import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, state } from "ccstate";
import { StoreProvider, useGet } from "ccstate-react";
import { LucideProvider, Plus } from "lucide-react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import type {
  ExtensionContext,
  ViewerExtension,
  ViewerError,
  ViewerSnapshot,
} from "../../src/index";
import { browserUse } from "../../src/extensions/browser-use";
import { FakeBrowser } from "./wire";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function browser() {
  const fake = new FakeBrowser();
  vi.stubGlobal("WebSocket", function () {
    return fake.factory("wss://fixture.invalid");
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => ({
      ...(JSON.parse(await blob.text()) as { width: number; height: number }),
      close: vi.fn(),
    })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  return fake;
}

it("reconnects only the owning viewer for transport changes and retains callback stability", async () => {
  const fake = browser();
  const view = render(
    <CdpViewer cdpUrl="wss://fixture.invalid" interactive transport="split" />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(fake.sockets).toHaveLength(2);
  const sockets = [...fake.sockets];
  view.rerender(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      transport="split"
      onError={() => {}}
      onStatusChange={() => {}}
    />,
  );
  expect(fake.sockets).toEqual(sockets);
  view.rerender(
    <CdpViewer cdpUrl="wss://fixture.invalid" interactive transport="shared" />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(fake.sockets).toHaveLength(3);
  expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
  view.unmount();
  expect(fake.sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it("exposes wrapped request context and context-only error changes without replacing input", async () => {
  const fake = browser();
  const onError = vi.fn<(error: ViewerError) => void>();
  const onStatusChange = vi.fn<(snapshot: ViewerSnapshot) => void>();
  render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      onError={onError}
      onStatusChange={onStatusChange}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const input = screen.getByLabelText("Remote browser input");
  fake.holdMethod = "Page.reload";
  for (const code of [-32000, -32001]) {
    await userEvent.click(
      screen.getByRole("button", { name: "Reload remote page" }),
    );
    await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
    const held = fake.heldCommands.shift()!;
    act(() => held.socket.reject(held.command, code));
    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith({
        kind: "input",
        message:
          "Remote input could not be completed. Unsent input was discarded; it will not be replayed.",
        request: { method: "Page.reload", code },
      }),
    );
    expect(onStatusChange.mock.lastCall?.[0].error?.request).toEqual({
      method: "Page.reload",
      code,
    });
  }
  expect(onError).toHaveBeenCalledTimes(2);
  fake.holdMethod = "Page.getFrameTree";
  await userEvent.click(screen.getByRole("button", { name: "New tab" }));
  await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
  const tab = fake.heldCommands.shift()!;
  act(() => tab.socket.reject(tab.command, -32000));
  await waitFor(() =>
    expect(onError).toHaveBeenLastCalledWith({
      kind: "tab",
      message:
        "The tab operation could not be completed. Check the browser before trying again.",
      request: { method: "Page.getFrameTree", code: -32000 },
    }),
  );
  expect(screen.getByLabelText("Remote browser input")).toBe(input);
  expect(fake.sockets).toHaveLength(1);
  expect(JSON.stringify(onError.mock.calls)).not.toMatch(
    /private|sessionId|params/,
  );
});

it("owns the browser menu mode and combined manual sync without replacing native input", async () => {
  const fake = browser();
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 640, 480));
  const changed = vi.fn();
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      windowSizeSync="off"
      onWindowSizeSyncChange={changed}
    />,
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  const proxy = screen.getByRole("textbox", { name: "Remote browser input" });
  const menu = screen.getByRole("button", { name: "Browser menu" });
  await userEvent.click(menu);
  expect(screen.getByRole("menuitem", { name: "Sync now" })).toBeEnabled();
  await userEvent.click(
    screen.getByRole("menuitemradio", { name: "Sync continuously" }),
  );
  expect(changed).toHaveBeenCalledWith("live");
  await userEvent.click(menu);
  expect(
    screen.getByRole("menuitemradio", { name: "Do not sync automatically" }),
  ).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitem", { name: "Sync now" }));
  await waitFor(() =>
    expect(fake.windowSizes.get(0)).toEqual({ width: 640, height: 480 }),
  );
  view.rerender(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      windowSizeSync="live"
    />,
  );
  await userEvent.click(menu);
  expect(
    screen.getByRole("menuitemradio", { name: "Sync continuously" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(
    screen.getByRole("menuitemradio", { name: "Sync continuously" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("textbox", { name: "Remote browser input" })).toBe(
    proxy,
  );
  expect(fake.sockets).toHaveLength(1);
});

it("keeps a menu-owned mode when the host changes callback identity", async () => {
  const fake = browser();
  const changed = vi.fn();
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      onWindowSizeSyncChange={changed}
    />,
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Browser menu" }));
  await userEvent.click(
    screen.getByRole("menuitemradio", { name: "Sync continuously" }),
  );
  expect(changed).toHaveBeenCalledWith("live");
  view.rerender(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      onWindowSizeSyncChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Browser menu" }));
  expect(
    screen.getByRole("menuitemradio", { name: "Sync continuously" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(fake.sockets).toHaveLength(1);
});

it("keeps display recovery guidance and a usable manual action until pointer input can resume", async () => {
  const fake = browser();
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 640, 480));
  render(<CdpViewer cdpUrl="wss://fixture.invalid" interactive />);
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  const proxy = screen.getByRole("textbox", { name: "Remote browser input" });
  const menu = screen.getByRole("button", { name: "Browser menu" });
  fake.unsupportedContentsSize = true;
  fake.holdMethod = "Emulation.clearDeviceMetricsOverride";
  await userEvent.click(menu);
  await userEvent.click(screen.getByRole("menuitem", { name: "Sync now" }));
  await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
  const held = fake.heldCommands[0]!;
  act(() => held.socket.reject(held.command, -32000));
  await waitFor(() =>
    expect(menu).toHaveAttribute(
      "title",
      "Browser menu — display recovery required",
    ),
  );
  await userEvent.click(menu);
  expect(
    screen.getByText("Use Sync now to resume pointer input"),
  ).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Sync now" })).toBeEnabled();
  fake.unsupportedContentsSize = false;
  fake.holdMethod = null;
  await userEvent.click(screen.getByRole("menuitem", { name: "Sync now" }));
  await waitFor(() => expect(menu).toHaveAttribute("title", "Browser menu"));
  await userEvent.click(menu);
  expect(
    screen.queryByText("Use Sync now to resume pointer input"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Remote browser input" })).toBe(
    proxy,
  );
  expect(fake.sockets).toHaveLength(1);
});

it("recovers view-only adaptation through a mode update without requiring an input menu", async () => {
  const fake = browser();
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 640, 480));
  fake.unsupportedContentsSize = true;
  fake.holdMethod = "Emulation.clearDeviceMetricsOverride";
  const view = render(
    <CdpViewer cdpUrl="wss://fixture.invalid" windowSizeSync="initial" />,
  );
  await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
  const held = fake.heldCommands[0]!;
  act(() => held.socket.reject(held.command, -32000));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Display recovery could not be confirmed. Try synchronizing again.",
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Browser menu" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Remote browser input" }),
  ).not.toBeInTheDocument();
  fake.unsupportedContentsSize = false;
  fake.holdMethod = null;
  view.rerender(
    <CdpViewer cdpUrl="wss://fixture.invalid" windowSizeSync="live" />,
  );
  await waitFor(() =>
    expect(fake.windowSizes.get(0)).toEqual({ width: 640, height: 480 }),
  );
  expect(
    document.querySelector('[data-status="streaming"]'),
  ).toBeInTheDocument();
  expect(fake.sockets).toHaveLength(1);
});

it("keeps native composition, focus and the connection through live capture updates", async () => {
  const fake = browser();
  const view = (quality: number) => (
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      capture={{ quality }}
    />
  );
  const mounted = render(view(70));
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  const proxy = screen.getByLabelText("Remote browser input");
  act(() => proxy.focus());
  const socket = fake.sockets[0]!;
  fireEvent.compositionStart(proxy);
  const update = new Event("compositionupdate", { bubbles: true });
  Object.defineProperty(update, "data", { value: "ni" });
  fireEvent(proxy, update);
  await waitFor(() =>
    expect(
      socket.commands.some(
        (c) =>
          c.method === "Input.imeSetComposition" && c.params?.text === "ni",
      ),
    ).toBe(true),
  );
  const before = socket.commands.length;
  mounted.rerender(view(50));
  await waitFor(() =>
    expect(
      socket.commands.filter((c) => c.method === "Page.startScreencast"),
    ).toHaveLength(2),
  );
  expect(screen.getByLabelText("Remote browser input")).toBe(proxy);
  expect(proxy).toHaveFocus();
  expect(fake.sockets).toHaveLength(1);
  expect(
    socket.commands
      .slice(before)
      .filter(
        (c) =>
          c.method === "Input.imeSetComposition" ||
          c.method === "Target.detachFromTarget",
      ),
  ).toHaveLength(0);
  const ended = new Event("compositionend", { bubbles: true });
  Object.defineProperty(ended, "data", { value: "你" });
  fireEvent(proxy, ended);
  await waitFor(() =>
    expect(
      socket.commands.some(
        (c) => c.method === "Input.insertText" && c.params?.text === "你",
      ),
    ).toBe(true),
  );
});

it("recovers corrected initial capture settings and rejects a repeated invalid live value without reconnecting", async () => {
  const fake = browser();
  const onError = vi.fn();
  const view = (quality: number) => (
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      capture={{ quality }}
      onError={onError}
    />
  );
  const mounted = render(view(-1));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(fake.sockets).toHaveLength(0);
  mounted.rerender(view(70));
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  mounted.rerender(view(101));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  mounted.rerender(view(101));
  expect(onError).toHaveBeenCalledTimes(2);
  expect(fake.sockets).toHaveLength(1);
  expect(
    fake.sockets[0]!.commands.filter(
      (c) => c.method === "Page.startScreencast",
    ),
  ).toHaveLength(1);
});

it("reconciles inline adapter configuration while preserving the connection and input", async () => {
  const fake = browser();
  const setup = vi.fn<ViewerExtension["setup"]>();
  const view = (key?: string) => (
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      extensions={[
        browserUse(),
        {
          id: "custom",
          ...(key === undefined ? {} : { key }),
          setup: (context) => setup(context),
        },
      ]}
      onStatusChange={() => {}}
    />
  );
  const mounted = render(view());
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  await waitFor(() => expect(setup).toHaveBeenCalledOnce());
  const canvas = document.querySelector("canvas");
  const proxy = screen.getByLabelText("Remote browser input");
  mounted.rerender(view());
  expect(setup).toHaveBeenCalledOnce();
  mounted.rerender(view("updated"));
  await waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
  expect(setup.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(fake.sockets).toHaveLength(1);
  expect(document.querySelector("canvas")).toBe(canvas);
  expect(screen.getByLabelText("Remote browser input")).toBe(proxy);
});

it("gives reused adapter descriptors independent viewer and connection lifetimes", async () => {
  browser();
  const owners: ExtensionContext[] = [];
  const cleanup = vi.fn();
  const shared: ViewerExtension = {
    id: "shared",
    setup: (context) => {
      owners.push(context);
      return cleanup;
    },
  };
  const view = (url: string) => (
    <StrictMode>
      <CdpViewer cdpUrl={url} windowId={0} extensions={[shared]} />
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        windowId={2}
        extensions={[shared]}
      />
    </StrictMode>
  );
  const mounted = render(view("wss://fixture.invalid"));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  expect(owners).toHaveLength(2);
  expect(owners[0]!.getState()).toEqual({
    status: "streaming",
    selectedTargetId: "page-a",
    capabilities: { windowScoped: true, interactive: false },
  });
  mounted.rerender(view("wss://replacement.invalid"));
  await waitFor(() => expect(owners).toHaveLength(3));
  expect(owners[0]!.signal.aborted).toBe(true);
  expect(owners[1]!.signal.aborted).toBe(false);
  expect(owners[2]!.signal.aborted).toBe(false);
  mounted.unmount();
  await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(3));
});

it("pauses only an offscreen panel and respects explicit pause on re-entry", async () => {
  const fake = browser();
  const observations: {
    callback: (entries: { isIntersecting: boolean }[]) => void;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly disconnect = vi.fn();
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observations.push({ callback, disconnect: this.disconnect });
      }
      observe() {}
    },
  );
  const view = render(
    <>
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} />
    </>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  expect(observations).toHaveLength(2);
  act(() => observations[0]!.callback([{ isIntersecting: false }]));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="paused"]')).toHaveLength(1),
  );
  expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
    1,
  );
  view.rerender(
    <>
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} paused />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} />
    </>,
  );
  act(() => observations[0]!.callback([{ isIntersecting: true }]));
  expect(document.querySelectorAll('[data-status="paused"]')).toHaveLength(1);
  view.rerender(
    <>
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} />
    </>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  expect(fake.sockets).toHaveLength(2);
  view.rerender(
    <>
      <CdpViewer cdpUrl="wss://replacement.invalid" windowId={0} />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} />
    </>,
  );
  await waitFor(() => expect(fake.sockets).toHaveLength(3));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  act(() => {
    observations[0]!.callback([{ isIntersecting: false }]);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
    2,
  );
  view.unmount();
  expect(
    observations.every(
      (observer) => observer.disconnect.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it("isolates library stores from host ccstate and survives Strict Mode teardown", async () => {
  const fake = browser();
  const host = createStore();
  const hostValue = state("host intact");
  function Host() {
    return <p>{useGet(hostValue)}</p>;
  }
  const { unmount } = render(
    <StrictMode>
      <StoreProvider value={host}>
        <Host />
        <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} />
        <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} />
      </StoreProvider>
    </StrictMode>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  expect(screen.getByText("host intact")).toBeInTheDocument();
  act(() => host.set(hostValue, "host changed"));
  expect(screen.getByText("host changed")).toBeInTheDocument();
  const ids = screen.getAllByRole("tablist").map((element) => element.id);
  expect(new Set(ids).size).toBe(2);
  unmount();
  expect(fake.sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it("reconnects explicitly but not when callback references change", async () => {
  const fake = browser();
  const view = render(
    <CdpViewer cdpUrl="wss://fixture.invalid" onStatusChange={() => {}} />,
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  view.rerender(
    <CdpViewer cdpUrl="wss://fixture.invalid" onStatusChange={() => {}} />,
  );
  expect(fake.sockets).toHaveLength(1);
  act(() => fake.sockets[0]!.close());
  await userEvent.click(
    await screen.findByRole("button", { name: "Reconnect viewer" }),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  expect(fake.sockets).toHaveLength(2);
  expect(fake.sockets[0]!.readyState).toBe(3);
});

it("isolates navigation drafts and reconnect ownership while retaining native proxy nodes", async () => {
  const fake = browser();
  const view = render(
    <>
      <CdpViewer
        key="a"
        cdpUrl="wss://fixture.invalid"
        windowId={0}
        interactive
      />
      <CdpViewer
        key="b"
        cdpUrl="wss://fixture.invalid"
        windowId={2}
        interactive
      />
    </>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  const addresses = screen.getAllByRole("textbox", {
    name: "Remote page address",
  });
  const proxies = screen.getAllByRole("textbox", {
    name: "Remote browser input",
  });
  const siblingSocket = fake.sockets[1]!;
  await userEvent.clear(addresses[0]!);
  await userEvent.type(addresses[0]!, "https://draft-a.invalid/");
  await userEvent.clear(addresses[1]!);
  await userEvent.type(addresses[1]!, "https://draft-b.invalid/");
  expect(addresses[0]).toHaveValue("https://draft-a.invalid/");
  expect(addresses[1]).toHaveValue("https://draft-b.invalid/");
  act(() => fake.sockets[0]!.close());
  await userEvent.click(
    await screen.findByRole("button", { name: "Reconnect viewer" }),
  );
  await waitFor(() => expect(fake.sockets).toHaveLength(3));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  await waitFor(() =>
    expect(addresses[0]).toHaveValue("https://fixture.invalid/"),
  );
  expect(addresses[1]).toHaveValue("https://draft-b.invalid/");
  const afterReconnect = screen.getAllByRole("textbox", {
    name: "Remote browser input",
  });
  expect(afterReconnect[0]).toBe(proxies[0]);
  expect(afterReconnect[1]).toBe(proxies[1]);
  expect(siblingSocket.readyState).toBe(1);
  view.rerender(
    <>
      <CdpViewer
        key="b"
        cdpUrl="wss://fixture.invalid"
        windowId={2}
        interactive
      />
    </>,
  );
  expect(siblingSocket.readyState).toBe(1);
  expect(fake.sockets).toHaveLength(3);
  expect(screen.getByRole("textbox", { name: "Remote browser input" })).toBe(
    proxies[1],
  );
  expect(
    screen.getByRole("textbox", { name: "Remote page address" }),
  ).toHaveValue("https://draft-b.invalid/");
});

it("retains owned keyboard focus through same-tab resets without reclaiming local focus", async () => {
  const fake = browser();
  render(
    <>
      <input aria-label="Host input" />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} interactive />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} interactive />
    </>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  const [first, second] = screen.getAllByRole("textbox", {
    name: "Remote browser input",
  });
  const socket = fake.sockets[0]!;
  const session = socket.commands.find(
    (command) => command.method === "Page.getFrameTree",
  )!.sessionId!;
  act(() => first!.focus());
  fireEvent.compositionStart(first!);
  act(() =>
    socket.emit("Page.frameStartedNavigating", { frameId: "main" }, session),
  );
  expect(first).toHaveFocus();
  // Happy DOM does not populate CompositionEvent.data from its constructor.
  const ended = new Event("compositionend", { bubbles: true });
  Object.defineProperty(ended, "data", { value: "old composition" });
  fireEvent(first!, ended);
  fireEvent.input(first!, {
    target: { value: "old composition" },
    inputType: "insertCompositionText",
  });
  await userEvent.keyboard("fresh");
  await waitFor(() =>
    expect(
      socket.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchKeyEvent" &&
            command.params?.type === "keyDown",
        )
        .map((command) => command.params?.text)
        .join(""),
    ).toBe("fresh"),
  );
  expect(
    socket.commands.filter((command) => command.method === "Input.insertText"),
  ).toHaveLength(0);
  for (const [method, params] of [
    ["Runtime.executionContextsCleared", {}],
    ["Page.frameNavigated", { frame: { id: "main" } }],
    ["Page.navigatedWithinDocument", { frameId: "main" }],
  ] as const) {
    act(() => socket.emit(method, params, session));
    expect(first).toHaveFocus();
  }
  expect(screen.getAllByLabelText("Remote browser input")).toEqual([
    first,
    second,
  ]);
  const hostInput = screen.getByRole("textbox", { name: "Host input" });
  act(() => hostInput.focus());
  act(() =>
    socket.emit("Page.frameNavigated", { frame: { id: "main" } }, session),
  );
  expect(hostInput).toHaveFocus();
  act(() => second!.focus());
  act(() => socket.emit("Runtime.executionContextsCleared", {}, session));
  expect(second).toHaveFocus();
  act(() => first!.focus());
  fake.targets = fake.targets.filter((target) => target.id !== "page-a");
  act(() => socket.emit("Target.targetDestroyed", { targetId: "page-a" }));
  await waitFor(() => expect(first).toBeDisabled());
  expect(first).not.toHaveFocus();
  expect(second).toBeEnabled();
  expect(fake.sockets).toHaveLength(2);
});

it("ends an active address draft when interaction is disabled without resetting its sibling", async () => {
  const fake = browser();
  const content = (interactive: boolean) => (
    <>
      <CdpViewer
        key="a"
        cdpUrl="wss://fixture.invalid"
        windowId={0}
        interactive={interactive}
      />
      <CdpViewer
        key="b"
        cdpUrl="wss://fixture.invalid"
        windowId={2}
        interactive
      />
    </>
  );
  const view = render(content(true));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  const addresses = screen.getAllByRole("textbox", {
    name: "Remote page address",
  });
  await userEvent.clear(addresses[1]!);
  await userEvent.type(addresses[1]!, "https://sibling-draft.invalid/");
  await userEvent.clear(addresses[0]!);
  await userEvent.type(addresses[0]!, "https://unfinished-draft.invalid/");
  expect(addresses[0]).toHaveFocus();
  const siblingSocket = fake.sockets[1]!;
  view.rerender(content(false));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "Remote page address" }),
  ).toHaveValue("https://sibling-draft.invalid/");
  view.rerender(content(true));
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  const restored = screen.getAllByRole("textbox", {
    name: "Remote page address",
  });
  expect(restored[0]).toHaveValue("https://fixture.invalid/");
  expect(restored[1]).toBe(addresses[1]);
  expect(restored[1]).toHaveValue("https://sibling-draft.invalid/");
  expect(siblingSocket.readyState).toBe(1);
  expect(
    fake.sockets
      .flatMap((socket) => socket.commands)
      .some((command) => command.method === "Page.navigate"),
  ).toBe(false);
});

it("keeps imports and server rendering free of browser connections", () => {
  const socket = vi.fn();
  const setup = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  expect(
    renderToString(
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        extensions={[browserUse(), { id: "custom", setup }]}
      />,
    ),
  ).toContain("Remote browser viewer");
  expect(socket).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "separates address composition confirmation from navigation inside a host form: %j",
  async (composition) => {
    const fake = browser();
    const submitted = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submitted}>
        <CdpViewer cdpUrl="wss://fixture.invalid" interactive />
        <button type="submit">Host submit</button>
      </form>,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-status="streaming"]'),
      ).toBeInTheDocument(),
    );
    const address = screen.getByRole("textbox", {
      name: "Remote page address",
    });
    await userEvent.clear(address);
    await userEvent.type(address, "https://destination.invalid/");
    fireEvent.keyDown(address, { key: "Enter", code: "Enter", ...composition });
    expect(
      fake.sockets
        .flatMap((socket) => socket.commands)
        .filter((command) => command.method === "Page.navigate"),
    ).toHaveLength(0);
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        fake.sockets
          .flatMap((socket) => socket.commands)
          .filter((command) => command.method === "Page.navigate"),
      ).toHaveLength(1),
    );
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Host submit" }));
    expect(submitted).toHaveBeenCalledOnce();
  },
);

it("owns icon defaults without changing a shared host provider", async () => {
  browser();
  const { container } = render(
    <LucideProvider
      color="#cc1122"
      size={40}
      strokeWidth={5}
      className="host-icons"
    >
      <Plus data-testid="host-icon" />
      <CdpViewer cdpUrl="wss://fixture.invalid" interactive />
    </LucideProvider>,
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  expect(screen.getByTestId("host-icon")).toHaveAttribute("stroke", "#cc1122");
  expect(screen.getByTestId("host-icon")).toHaveAttribute("width", "40");
  expect(screen.getByTestId("host-icon")).toHaveAttribute("stroke-width", "5");
  const icons = container.querySelectorAll(".cdpv-root svg");
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) {
    expect(icon).toHaveAttribute("stroke", "currentColor");
    expect(icon).toHaveAttribute("stroke-width", "2");
    expect(icon).not.toHaveClass("host-icons");
  }
});

it("owns tab measurement per viewer and keeps hidden tabs accessible without reconnecting", async () => {
  const fake = browser();
  fake.targets = Array.from({ length: 20 }, (_, index) => ({
    id: `page-${index}`,
    title: `Project ${index} with a complete accessible name`,
    windowId: index < 10 ? 0 : 2,
  }));
  const observations: {
    measure: () => void;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly disconnect = vi.fn();
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains("cdpv-toolbar"))
          observations.push({
            measure: () => this.callback([], this),
            disconnect: this.disconnect,
          });
      }
      unobserve() {}
    },
  );
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        this.classList.contains("cdpv-new-tab")
          ? 32
          : parseFloat(this.style.width) || 0,
        41,
      );
    });
  const view = render(
    <>
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} interactive />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} interactive />
    </>,
  );
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      2,
    ),
  );
  const viewers = Array.from(
    document.querySelectorAll<HTMLElement>(".cdpv-root"),
  );
  const rows = viewers.map((root) =>
    root.querySelector<HTMLElement>(".cdpv-toolbar")!,
  );
  const canvas = viewers[0]!.querySelector("canvas");
  const proxy = within(viewers[0]!).getByLabelText("Remote browser input");
  for (const row of rows) {
    row.style.cssText =
      "width:320px;padding:0 16px 0 3px;column-gap:6px;--cdpv-tab-action:32px";
    row.querySelector<HTMLElement>(".cdpv-tabs")!.style.cssText =
      "padding:0 16px;column-gap:3px";
  }
  act(() => observations.forEach((observer) => observer.measure()));
  const first = within(viewers[0]!);
  const second = within(viewers[1]!);
  expect(first.getAllByRole("tab")).toHaveLength(6);
  expect(second.getAllByRole("tab")).toHaveLength(6);
  const picker = first.getByRole("combobox", { name: "All tabs" });
  await userEvent.click(picker);
  expect(first.getAllByRole("option")).toHaveLength(10);
  expect(second.queryByRole("listbox")).toBeNull();
  await userEvent.click(
    first.getByRole("option", {
      name: "Project 9 with a complete accessible name",
    }),
  );
  await waitFor(() => expect(first.queryByRole("listbox")).toBeNull());
  expect(picker).toHaveAttribute("aria-expanded", "false");
  expect(first.getByRole("tab", { selected: true })).toHaveAccessibleName(
    "Project 9 with a complete accessible name",
  );
  expect(second.getByRole("tab", { selected: true })).toHaveAccessibleName(
    "Project 10 with a complete accessible name",
  );
  rows[0]!.style.width = "900px";
  act(() => observations[0]!.measure());
  expect(first.getAllByRole("tab")).toHaveLength(10);
  expect(first.queryByRole("combobox")).toBeNull();
  expect(second.getAllByRole("tab")).toHaveLength(6);
  expect(fake.sockets).toHaveLength(2);
  expect(viewers[0]!.querySelector("canvas")).toBe(canvas);
  expect(first.getByLabelText("Remote browser input")).toBe(proxy);
  view.unmount();
  const measured = geometry.mock.calls.length;
  observations.forEach((observer) => {
    expect(observer.disconnect).toHaveBeenCalledOnce();
    observer.measure();
  });
  expect(geometry).toHaveBeenCalledTimes(measured);
});

it.each(["success", "failure"] as const)(
  "keeps discovered-tab creation icon-only through %s",
  async (outcome) => {
    const fake = browser();
    render(
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} interactive />,
    );
    const create = screen.getByRole("button", { name: "New tab" });
    await waitFor(() => expect(create).toBeEnabled());
    fake.holdMethod = "Page.navigate";
    await userEvent.click(create);
    await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
    await screen.findByRole("tab", { name: "New tab" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(create).toHaveAttribute("aria-busy", "true");
    expect(create).toBeDisabled();
    expect(create).toHaveTextContent(/^$/);
    expect(screen.getByRole("status")).toHaveTextContent("Creating tab");
    await userEvent.click(create);
    expect(
      fake.targets.filter((target) => target.id.startsWith("new-")),
    ).toHaveLength(1);
    const held = fake.heldCommands[0]!;
    act(() => {
      if (outcome === "success") held.socket.reply(held.command);
      else held.socket.reject(held.command);
    });
    await waitFor(() => expect(create).toHaveAttribute("aria-busy", "false"));
    await waitFor(() => expect(create).toBeEnabled());
    expect(create).toHaveTextContent(/^$/);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      outcome === "success" ? "New tab" : "Window A",
    );
    if (outcome === "failure")
      expect(screen.getByRole("alert")).toHaveTextContent("tab operation");
  },
);

it("replaces identical warnings with fresh owned timers and releases them on unmount", async () => {
  browser();
  const timers = vi.spyOn(window, "setTimeout");
  const clear = vi.spyOn(window, "clearTimeout");
  const view = render(<CdpViewer cdpUrl="wss://fixture.invalid" interactive />);
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  const address = screen.getByRole("textbox", { name: "Remote page address" });
  const image = screen.getByRole("img", { name: "Live browser view" });
  const proxy = screen.getByRole("textbox", { name: "Remote browser input" });
  await userEvent.clear(address);
  await userEvent.type(address, "not-an-address{Enter}");
  const first = screen.getByRole("alert");
  expect(first).toHaveAttribute("data-phase", "visible");
  const firstId = first.getAttribute("data-notification-id");
  const firstIndex = timers.mock.calls.map(([, ms]) => ms).lastIndexOf(5000);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  const firstTimer = timers.mock.results[firstIndex]!.value;
  const firstTimerCount = timers.mock.calls.filter(
    ([, ms]) => ms === 5000,
  ).length;
  await userEvent.keyboard("{Enter}");
  const second = screen.getByRole("alert");
  expect(second).not.toBe(first);
  expect(second).not.toHaveAttribute("data-notification-id", firstId);
  expect(second).toHaveAttribute("data-phase", "visible");
  await waitFor(() => expect(first).not.toBeInTheDocument());
  expect(timers.mock.calls.filter(([, ms]) => ms === 5000)).toHaveLength(
    firstTimerCount + 1,
  );
  expect(screen.getByRole("img", { name: "Live browser view" })).toBe(image);
  expect(screen.getByRole("textbox", { name: "Remote browser input" })).toBe(
    proxy,
  );
  expect(clear).toHaveBeenCalledWith(firstTimer);
  const secondIndex = timers.mock.calls.map(([, ms]) => ms).lastIndexOf(5000);
  expect(secondIndex).toBeGreaterThan(firstIndex);
  const secondTimer = timers.mock.results[secondIndex]!.value;
  view.unmount();
  expect(clear).toHaveBeenCalledWith(secondTimer);
});

it("clears notices on runtime replacement and keeps recovery outside the expiry lifetime", async () => {
  const fake = browser();
  const timers = vi.spyOn(window, "setTimeout");
  const view = render(<CdpViewer cdpUrl="wss://fixture.invalid" interactive />);
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  const address = screen.getByRole("textbox", { name: "Remote page address" });
  await userEvent.clear(address);
  await userEvent.type(address, "not-an-address{Enter}");
  expect(screen.getByRole("alert")).toHaveAttribute("data-phase", "visible");
  view.rerender(<CdpViewer cdpUrl="wss://replacement.invalid" interactive />);
  await waitFor(() => expect(fake.sockets).toHaveLength(2));
  await waitFor(() =>
    expect(
      document.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const timerCount = timers.mock.calls.filter(([, ms]) => ms === 5000).length;
  act(() => fake.sockets[1]!.close());
  await screen.findByText("Browser disconnected");
  expect(
    screen.getByRole("button", { name: "Reconnect viewer" }),
  ).toBeEnabled();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(
    document.querySelector(".cdpv-notification-viewport"),
  ).not.toBeInTheDocument();
  expect(timers.mock.calls.filter(([, ms]) => ms === 5000)).toHaveLength(
    timerCount,
  );
});

it("offers creation only for a confirmed empty browser, not failed discovery", async () => {
  const fake = browser();
  fake.targets = [];
  render(<CdpViewer cdpUrl="wss://fixture.invalid" interactive />);
  await screen.findByText("No tabs open");
  expect(screen.getByRole("button", { name: "New tab" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Create new tab" })).toBeEnabled();
  fake.holdMethod = "Target.getTargets";
  act(() => fake.sockets[0]!.emit("Target.targetInfoChanged", {}));
  await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
  const held = fake.heldCommands[0]!;
  act(() => held.socket.reject(held.command));
  await screen.findByText("Browser view unavailable");
  expect(screen.getByRole("button", { name: "New tab" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Create new tab" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Reconnect viewer" }),
  ).toBeEnabled();
});

it("can close a broken page while its browser connection is still established", async () => {
  const fake = browser();
  fake.unsupportedStream = true;
  render(<CdpViewer cdpUrl="wss://fixture.invalid" interactive />);
  await waitFor(() =>
    expect(document.querySelector('[data-status="error"]')).toBeInTheDocument(),
  );
  const close = screen.getByRole("button", {
    name: "Close Window A",
  });
  expect(close).toBeEnabled();
  await userEvent.click(close);
  await waitFor(() =>
    expect(
      screen.queryByRole("tab", { name: "Window A" }),
    ).not.toBeInTheDocument(),
  );
  expect(fake.targets.map((target) => target.id)).toEqual(["page-b"]);
  expect(fake.sockets).toHaveLength(1);
});

it.each(["connecting", "paused", "error", "disconnected"] as const)(
  "keeps local Tab navigation usable while remote input is %s",
  async (status) => {
    const fake = browser();
    fake.holdAttach = status === "connecting";
    fake.unsupportedStream = status === "error";
    render(
      <>
        <CdpViewer
          cdpUrl="wss://fixture.invalid"
          interactive
          paused={status === "paused"}
        />
        <input aria-label="After viewer" />
      </>,
    );
    if (status === "disconnected") {
      await waitFor(() =>
        expect(
          document.querySelector('[data-status="streaming"]'),
        ).toBeInTheDocument(),
      );
      act(() => fake.sockets[0]!.close());
    }
    await waitFor(() =>
      expect(
        document.querySelector(`[data-status="${status}"]`),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole("textbox", { name: "Remote page address" }),
    );
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Browser menu" })).toHaveFocus();
    await userEvent.tab();
    if (status === "error" || status === "disconnected") {
      expect(
        screen.getByRole("button", { name: "Reconnect viewer" }),
      ).toHaveFocus();
      await userEvent.tab();
    }
    expect(screen.getByRole("textbox", { name: "After viewer" })).toHaveFocus();
  },
);
