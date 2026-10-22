import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import { CdpClient } from "../../src/cdp/client";
import { launchNativeBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

type Backend = Awaited<ReturnType<typeof launchNativeBackend>>;

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => {
  await server?.close();
});

async function editor(backend: Backend, name: string, source?: Page) {
  const created = backend.context.waitForEvent("page");
  if (source)
    await source.evaluate(() => {
      window.open("about:blank");
    });
  else
    await backend.session.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
  const page = await created;
  await page.goto(server.origin + "/fixture/editor?" + name);
  await expect(page.locator("#plain")).toBeVisible();
  const inspection = await backend.context.newCDPSession(page);
  const { targetInfo } = await inspection.send("Target.getTargetInfo");
  await inspection.detach();
  const { windowId } = await backend.session.send(
    "Browser.getWindowForTarget",
    { targetId: targetInfo.targetId },
  );
  return { page, name, targetId: targetInfo.targetId, windowId };
}

async function record(info: TestInfo, backend: Backend, result: object) {
  const { product, protocolVersion } =
    await backend.session.send("Browser.getVersion");
  const consumer = JSON.parse(
    await readFile("test-results/package/receipt.json", "utf8"),
  ) as { specifier: string; lockfileSha256: string };
  const path = info.outputPath("window-isolation.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        source: consumer.specifier,
        lockfileSha256: consumer.lockfileSha256,
        browser: product,
        protocolVersion,
        platform: process.platform,
        osRelease: osRelease(),
        sameRemoteBrowserEndpoint: true,
        operatedPagesFocusEmulation: false,
        ...result,
      },
      null,
      2,
    ),
  );
  await info.attach("window-isolation", {
    path,
    contentType: "application/json",
  });
}

async function tabState(backend: Backend) {
  const worker =
    backend.context.serviceWorkers()[0] ??
    (await backend.context.waitForEvent("serviceworker"));
  return worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: object): Promise<{ windowId: number; url: string }[]>;
          };
          windows: {
            getAll(): Promise<{ id: number; focused: boolean }[]>;
          };
        };
      }
    ).chrome;
    return {
      tabs: (await chrome.tabs.query({ active: true })).map((tab) => ({
        windowId: tab.windowId,
        url: tab.url,
      })),
      windows: (await chrome.windows.getAll()).map((window) => ({
        id: window.id,
        focused: window.focused,
      })),
    };
  });
}

type Editor = Awaited<ReturnType<typeof editor>>;
type Owner = Editor & { client: CdpClient; sessionId: string };

interface FocusState {
  focused: boolean;
  activeElement: string | null;
  focusEvents: number;
  blurEvents: number;
}

async function focusState(owner: Owner): Promise<FocusState> {
  const { result } = await owner.client.request(
    "Runtime.evaluate",
    {
      expression: `({ focused: document.hasFocus(),
        activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
        focusEvents: Number(document.documentElement.dataset.focus ?? 0),
        blurEvents: Number(document.documentElement.dataset.blur ?? 0) })`,
      returnByValue: true,
    },
    owner.sessionId,
  );
  return result.value as FocusState;
}

async function click(owners: Owner[], selector: string) {
  const points = await Promise.all(
    owners.map(async (owner) => {
      const box = await owner.page.locator(selector).boundingBox();
      if (!box) throw new Error("Owned control has no bounds.");
      return { owner, x: box.x + box.width - 20, y: box.y + box.height / 2 };
    }),
  );
  for (const type of ["mousePressed", "mouseReleased"] as const)
    await Promise.all(
      points.map(({ owner, x, y }) =>
        owner.client.request(
          "Input.dispatchMouseEvent",
          {
            type,
            x,
            y,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          },
          owner.sessionId,
        ),
      ),
    );
}

async function edit(owners: Owner[], suffixes: string[]) {
  await click(owners, "#plain");
  for (const type of ["keyDown", "keyUp"] as const)
    await Promise.all(
      owners.map((owner) =>
        owner.client.request(
          "Input.dispatchKeyEvent",
          {
            type,
            key: "k",
            code: "KeyK",
            windowsVirtualKeyCode: 75,
            ...(type === "keyDown" ? { text: "k" } : {}),
          },
          owner.sessionId,
        ),
      ),
    );
  await Promise.all(
    owners.map((owner, index) =>
      owner.client.request(
        "Input.insertText",
        { text: suffixes[index]! },
        owner.sessionId,
      ),
    ),
  );
}

test("cdp sessions keep input independent while the other window activates a tab", async ({
  browserName,
}, info) => {
  const headless = info.project.use.headless !== false;
  const backend = await launchNativeBackend(server.origin, headless);
  const clients: CdpClient[] = [];
  try {
    clients.push(new CdpClient(backend.endpoint));
    clients.push(new CdpClient(backend.endpoint));
    const a = await editor(backend, "a");
    const aNext = await editor(backend, "a-next", a.page);
    const b = await editor(backend, "b");
    const bNext = await editor(backend, "b-next", b.page);
    expect(a.windowId).not.toBe(b.windowId);
    expect(aNext.windowId).toBe(a.windowId);
    expect(bNext.windowId).toBe(b.windowId);
    await Promise.all(clients.map((client) => client.opened));
    const owners = await Promise.all(
      [a, aNext, b, bNext].map(async (target, index): Promise<Owner> => {
        const client = clients[index < 2 ? 0 : 1]!;
        const { sessionId } = await client.request("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        await target.page.evaluate(() => {
          for (const type of ["focus", "blur"])
            window.addEventListener(type, () => {
              document.documentElement.dataset[type] = String(
                Number(document.documentElement.dataset[type] ?? 0) + 1,
              );
            });
        });
        return { ...target, client, sessionId };
      }),
    );
    const [firstA, nextA, firstB, nextB] = owners as [
      Owner,
      Owner,
      Owner,
      Owner,
    ];
    expect(new Set(owners.map((owner) => owner.sessionId)).size).toBe(4);
    for (const owner of [firstA, firstB])
      await owner.client.request("Target.activateTarget", {
        targetId: owner.targetId,
      });
    const focusStates = () =>
      Promise.all(
        owners.map(async (owner) => ({
          name: owner.name,
          targetId: owner.targetId,
          ...(await focusState(owner)),
        })),
      );
    const beforeInput = {
      ...(await tabState(backend)),
      pages: await focusStates(),
    };
    await edit([firstA, firstB], ["a", "b"]);
    await expect(a.page.locator("#plain")).toHaveValue("ka");
    await expect(b.page.locator("#plain")).toHaveValue("kb");
    const afterInput = {
      ...(await tabState(backend)),
      pages: await focusStates(),
    };
    const activations: object[] = [];
    for (const [activating, typing, expectedA, expectedB] of [
      [nextA, firstB, aNext, b],
      [nextB, nextA, aNext, bNext],
    ] as const) {
      await Promise.all([
        activating.client.request("Target.activateTarget", {
          targetId: activating.targetId,
        }),
        typing.client.request(
          "Input.insertText",
          { text: "+" },
          typing.sessionId,
        ),
      ]);
      if (!headless)
        await expect
          .poll(
            async () =>
              (await tabState(backend)).windows.find(
                (window) => window.id === activating.windowId,
              )?.focused,
          )
          .toBe(true);
      const state = await tabState(backend);
      for (const target of [expectedA, expectedB])
        expect(
          state.tabs.find((tab) => tab.windowId === target.windowId)?.url,
        ).toBe(target.page.url());
      for (const owner of owners.filter(
        (owner) =>
          ![expectedA.targetId, expectedB.targetId].includes(owner.targetId),
      ))
        await expect
          .poll(async () => (await focusState(owner)).focused)
          .toBe(false);
      if (!headless) {
        expect(
          state.windows.find((window) => window.id === activating.windowId)
            ?.focused,
        ).toBe(true);
        expect(
          state.windows.find((window) => window.id === typing.windowId)
            ?.focused,
        ).toBe(false);
        await expect
          .poll(async () => (await focusState(activating)).focused)
          .toBe(true);
      }
      activations.push({
        activatedTargetId: activating.targetId,
        ...state,
        pages: await focusStates(),
      });
      if (activating === nextA) {
        await expect(b.page.locator("#plain")).toHaveValue("kb+");
        await edit([nextA, firstB], ["a-next", "b-again"]);
        await expect(aNext.page.locator("#plain")).toHaveValue("ka-next");
        await expect(b.page.locator("#plain")).toHaveValue("kb+kb-again");
      } else {
        await expect(aNext.page.locator("#plain")).toHaveValue("ka-next+");
        await edit([nextA, nextB], ["a-again", "b-next"]);
      }
    }
    await expect(a.page.locator("#plain")).toHaveValue("ka");
    await expect(b.page.locator("#plain")).toHaveValue("kb+kb-again");
    await expect(aNext.page.locator("#plain")).toHaveValue("ka-next+ka-again");
    await expect(bNext.page.locator("#plain")).toHaveValue("kb-next");
    await click([nextA, nextB], "button[type=submit]");
    await expect(aNext.page.locator("#submits")).toHaveText("1");
    await expect(bNext.page.locator("#submits")).toHaveText("1");
    await record(info, backend, {
      browserName,
      headless,
      transport:
        "two independent flattened CDP connections; no focus emulation",
      beforeInput,
      afterInput,
      owners: owners.map(({ name, windowId, targetId, sessionId }) => ({
        name,
        windowId,
        targetId,
        sessionId,
      })),
      activations,
      result: "concurrent input and both activation directions passed",
    });
  } finally {
    for (const client of clients) client.close();
    await backend.close();
  }
});

async function color(canvas: ReturnType<Page["locator"]>, expected: number[]) {
  await expect
    .poll(() =>
      canvas.evaluate((element: HTMLCanvasElement, rgb) => {
        const context = element.getContext("2d");
        if (!context || !element.width || !element.height) return Infinity;
        return Math.max(
          ...[...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((value, index) => Math.abs(value - rgb[index]!)),
        );
      }, expected),
    )
    .toBeLessThanOrEqual(4);
}

for (const separate of [false, true]) {
  test(`public viewers make independent progress in ${separate ? "separate client pages" : "one host page"}`, async ({
    page,
    browser,
  }, info) => {
    const backend = await launchNativeBackend(server.origin);
    let other = page;
    let release: (() => void) | undefined;
    let armed = false;
    const links: { connection: number; targetId: string; sessionId: string }[] =
      [];
    const inputs: {
      connection: number;
      targetId: string | undefined;
      sessionId: string | undefined;
      method: string;
    }[] = [];
    let connections = 0;
    try {
      if (separate) other = await browser.newPage();
      const a = await editor(backend, "public-a");
      const b = await editor(backend, "public-b");
      expect(a.windowId).not.toBe(b.windowId);
      for (const client of new Set([page, other]))
        await client.routeWebSocket(backend.endpoint, (socket) => {
          const connection = ++connections;
          const upstream = socket.connectToServer();
          const attachments = new Map<number, string>();
          const sessions = new Map<string, string>();
          let heldId: number | undefined;
          socket.onMessage((message) => {
            const command = JSON.parse(String(message)) as {
              id: number;
              method: string;
              params?: { targetId?: string; type?: string };
              sessionId?: string;
            };
            if (
              command.method === "Target.attachToTarget" &&
              command.params?.targetId
            )
              attachments.set(command.id, command.params.targetId);
            if (command.method.startsWith("Input.")) {
              const targetId = command.sessionId
                ? sessions.get(command.sessionId)
                : undefined;
              inputs.push({
                connection,
                targetId,
                sessionId: command.sessionId,
                method: command.method,
              });
              if (
                armed &&
                targetId === a.targetId &&
                (separate
                  ? command.method === "Input.insertText"
                  : command.method === "Input.dispatchMouseEvent" &&
                    command.params?.type === "mouseWheel")
              ) {
                armed = false;
                heldId = command.id;
              }
            }
            upstream.send(message);
          });
          upstream.onMessage((message) => {
            const response = JSON.parse(String(message)) as {
              id?: number;
              result?: { sessionId?: string };
            };
            const targetId =
              response.id === undefined
                ? undefined
                : attachments.get(response.id);
            if (targetId && response.result?.sessionId) {
              sessions.set(response.result.sessionId, targetId);
              links.push({
                connection,
                targetId,
                sessionId: response.result.sessionId,
              });
              attachments.delete(response.id!);
            }
            if (response.id !== undefined && response.id === heldId)
              release = () => {
                heldId = undefined;
                socket.send(message);
              };
            else socket.send(message);
          });
        });
      const colors = [
        [232, 32, 48],
        [24, 80, 224],
      ];
      for (const [index, target] of [a, b].entries())
        await target.page.evaluate(
          ({ rgb, separate }) => {
            if (separate) {
              document
                .querySelector("#plain")!
                .addEventListener("input", () => {
                  document.body.style.background = `rgb(${rgb.join(",")})`;
                });
            } else {
              document.body.style.margin = "0";
              const surface = document.createElement("div");
              surface.style.cssText = `height:4000px;background:linear-gradient(to bottom,white 0 100px,rgb(${rgb.join(",")}) 100px)`;
              document.body.prepend(surface);
            }
          },
          { rgb: colors[index]!, separate },
        );
      const configure = async (
        client: Page,
        windowA: number,
        windowB?: number,
      ) => {
        await client.goto(server.origin);
        await client.waitForFunction(
          () => typeof window.configureViewers === "function",
        );
        await client.evaluate(
          (settings) => window.configureViewers!(settings),
          {
            cdpUrl: backend.endpoint,
            windowA,
            ...(windowB === undefined ? { second: false } : { windowB }),
            interactive: true,
          },
        );
      };
      await configure(page, a.windowId, separate ? undefined : b.windowId);
      if (separate) await configure(other, b.windowId);
      const viewA = page.locator("#viewer-a .cdpv-root");
      const viewB = other.locator(
        separate ? "#viewer-a .cdpv-root" : "#viewer-b .cdpv-root",
      );
      await expect(viewA).toHaveAttribute("data-status", "streaming");
      await expect(viewB).toHaveAttribute("data-status", "streaming");
      armed = true;
      if (separate) {
        await a.page.locator("#plain").focus();
        await b.page.locator("#plain").focus();
        await viewA
          .getByRole("textbox", { name: "Remote browser input" })
          .focus();
        await viewB
          .getByRole("textbox", { name: "Remote browser input" })
          .focus();
        await page.keyboard.insertText("alpha");
        await expect.poll(() => typeof release).toBe("function");
        await other.keyboard.type("bravo");
        await other.keyboard.insertText("🙂");
        await expect(b.page.locator("#plain")).toHaveValue("bravo🙂");
        await expect(a.page.locator("#plain")).toHaveValue("alpha");
      } else {
        const wheel = (view: typeof viewA) =>
          view.locator("canvas").evaluate((canvas) => {
            const box = canvas.getBoundingClientRect();
            canvas.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: box.x + box.width / 2,
                clientY: box.y + box.height / 2,
                deltaY: 200,
              }),
            );
          });
        await wheel(viewA);
        await expect.poll(() => typeof release).toBe("function");
        await wheel(viewB);
        await expect.poll(() => b.page.evaluate(() => scrollY)).toBe(200);
        await expect.poll(() => a.page.evaluate(() => scrollY)).toBe(200);
      }
      await color(viewB.locator("canvas"), colors[1]!);
      expect(typeof release).toBe("function");
      release!();
      release = undefined;
      await color(viewA.locator("canvas"), colors[0]!);
      expect(links).toHaveLength(2);
      expect(new Set(links.map((link) => link.connection)).size).toBe(2);
      expect(links.map((link) => link.targetId).sort()).toEqual(
        [a.targetId, b.targetId].sort(),
      );
      expect(inputs.some((input) => input.targetId === a.targetId)).toBe(true);
      expect(inputs.some((input) => input.targetId === b.targetId)).toBe(true);
      expect(
        inputs.every(
          (input) =>
            input.sessionId &&
            [a.targetId, b.targetId].includes(input.targetId ?? ""),
        ),
      ).toBe(true);
      await record(info, backend, {
        headless: true,
        separateClientPages: separate,
        links,
        inputs,
        result: "B edited/scrolled and painted while A awaited its own reply",
      });
    } finally {
      release?.();
      try {
        if (other !== page) await other.close();
      } finally {
        await backend.close();
      }
    }
  });
}
