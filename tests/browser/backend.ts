import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForDebuggerEndpoint } from "./debugger-endpoint";

export function serveBrowserConsumer(
  headers: Readonly<Record<string, string>> = {},
) {
  const dist = process.env.CDP_VIEWER_TEST_CONSUMER_DIST;
  if (!dist)
    throw new Error("Browser consumer setup did not provide its build.");
  return serveConsumer(dist, "/", headers);
}

export async function serveConsumer(
  dist: string,
  base = "/",
  headers: Readonly<Record<string, string>> = {},
) {
  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(headers))
      response.setHeader(name, value);
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid")
      .pathname;
    if (pathname === "/fixture/no-content") {
      response.writeHead(204).end();
      return;
    }
    if (pathname === "/fixture/editor") {
      void readFile(new URL("./fixtures/editor.html", import.meta.url))
        .then((data) => {
          response.setHeader("Content-Type", "text/html");
          response.end(data);
        })
        .catch(() => response.writeHead(500).end());
      return;
    }
    if (pathname.startsWith("/fixture/")) {
      const color = pathname.endsWith("red")
        ? "rgb(232,32,48)"
        : "rgb(24,80,224)";
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<html><head><title>${color}</title><style>html,body{margin:0;width:100%;height:100%;background:${color}}</style></head><body></body></html>`,
      );
      return;
    }
    if (!pathname.startsWith(base)) {
      response.writeHead(404).end();
      return;
    }
    const file = resolve(dist, pathname.slice(base.length) || "index.html");
    if (!file.startsWith(resolve(dist) + sep)) {
      response.writeHead(403).end();
      return;
    }
    void readFile(file)
      .then((data) => {
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
        };
        response.setHeader(
          "Content-Type",
          types[extname(file)] ?? "application/octet-stream",
        );
        response.end(data);
      })
      .catch(() => response.writeHead(404).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not bind.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function browserOptions(
  origin: string,
  headless: boolean,
  nativeDpr?: number,
) {
  const extension = fileURLToPath(new URL("./extension", import.meta.url));
  return {
    headless,
    // Extension support requires Chromium's new headless mode, not headless shell.
    // https://playwright.dev/docs/chrome-extensions
    channel: "chromium",
    ...(process.env.CDP_VIEWER_CHROMIUM
      ? { executablePath: process.env.CDP_VIEWER_CHROMIUM }
      : {}),
    args: [
      ...(nativeDpr === undefined
        ? []
        : [`--force-device-scale-factor=${nativeDpr}`]),
      "--remote-debugging-port=0",
      `--remote-allow-origins=${origin}`,
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  };
}

export async function launchBackend(
  profile: string,
  origin: string,
  nativeDpr?: number,
) {
  await mkdir(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(
    profile,
    browserOptions(origin, true, nativeDpr),
  );
  try {
    const endpoint = await waitForDebuggerEndpoint(
      profile,
      AbortSignal.timeout(5_000),
    );
    const browser = context.browser();
    if (!browser) throw new Error("Test Chromium has no browser owner.");
    const session = await browser.newBrowserCDPSession();
    return {
      context,
      session,
      endpoint,
      close: () => context.close(),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Inspect an owned browser without Playwright's per-page focus emulation. */
export async function launchNativeBackend(origin: string, headless = true) {
  const owner = await chromium.launchServer(browserOptions(origin, headless));
  let inspection: Browser | undefined;
  const close = async () => {
    try {
      await inspection?.close();
    } finally {
      await owner.close();
    }
  };
  try {
    const profile = owner
      .process()
      .spawnargs.find((arg) => arg.startsWith("--user-data-dir="));
    if (!profile) throw new Error("Owned Chromium has no profile directory.");
    const endpoint = await waitForDebuggerEndpoint(
      profile.slice("--user-data-dir=".length),
      AbortSignal.timeout(5_000),
    );
    inspection = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = inspection.contexts()[0];
    if (!context) throw new Error("Owned Chromium has no default context.");
    const session = await inspection.newBrowserCDPSession();
    return { context, session, endpoint, close };
  } catch (error) {
    await close();
    throw error;
  }
}
