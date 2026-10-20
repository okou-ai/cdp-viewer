import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function serveConsumer(dist: string) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid")
      .pathname;
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
    const file = resolve(
      dist,
      pathname === "/" ? "index.html" : "." + pathname,
    );
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

export async function launchBackend(profile: string, origin: string) {
  await mkdir(profile, { recursive: true });
  const extension = fileURLToPath(new URL("./extension", import.meta.url));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CDP_VIEWER_CHROMIUM
      ? { executablePath: process.env.CDP_VIEWER_CHROMIUM }
      : {}),
    args: [
      "--remote-debugging-port=0",
      `--remote-allow-origins=${origin}`,
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const [port, path] = (
      await readFile(resolve(profile, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split("\n");
    if (!port || !path)
      throw new Error("Test Chromium did not expose a debugger endpoint.");
    const browser = context.browser();
    if (!browser) throw new Error("Test Chromium has no browser owner.");
    const session = await browser.newBrowserCDPSession();
    return {
      context,
      session,
      endpoint: `ws://127.0.0.1:${port}${path}`,
      close: () => context.close(),
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
