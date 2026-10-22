import { act, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import type { ExtensionContext, ViewerExtension } from "../../src/index";
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
    vi.fn(() => Promise.resolve({ width: 2, height: 2, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  return fake;
}

async function streaming(count = 1) {
  await waitFor(() =>
    expect(document.querySelectorAll('[data-status="streaming"]')).toHaveLength(
      count,
    ),
  );
}

it("preserves inline extension setup, sockets, sessions and input nodes on callback rerenders", async () => {
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
      onError={() => {}}
    />
  );
  const mounted = render(view());
  await streaming();
  await waitFor(() => expect(setup).toHaveBeenCalledOnce());
  const proxy = document.querySelector("textarea");
  const canvas = document.querySelector("canvas");
  const attaches = fake.sockets[0]!.commands.filter(
    (command) => command.method === "Target.attachToTarget",
  ).length;
  mounted.rerender(view());
  mounted.rerender(view());
  expect(setup).toHaveBeenCalledOnce();
  expect(fake.sockets).toHaveLength(1);
  expect(
    fake.sockets[0]!.commands.filter(
      (command) => command.method === "Target.attachToTarget",
    ),
  ).toHaveLength(attaches);
  mounted.rerender(view("new configuration"));
  await waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
  expect(setup.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(setup.mock.calls[1]![0].signal.aborted).toBe(false);
  expect(fake.sockets).toHaveLength(1);
  expect(document.querySelector("textarea")).toBe(proxy);
  expect(document.querySelector("canvas")).toBe(canvas);
});

it("isolates one reused descriptor across two viewers and applies scoped vendor activation", async () => {
  const fake = browser();
  fake.targets.push({ id: "page-c", windowId: 0, title: "Page C" });
  const owners: ExtensionContext[] = [];
  const cleanup = vi.fn();
  const shared: ViewerExtension = {
    id: "shared",
    setup: (context) => {
      owners.push(context);
      return cleanup;
    },
  };
  const view = (first: boolean) => (
    <>
      {first && (
        <CdpViewer
          key="a"
          cdpUrl="wss://fixture.invalid"
          windowId={0}
          extensions={[shared, browserUse()]}
        />
      )}
      <CdpViewer
        key="b"
        cdpUrl="wss://fixture.invalid"
        windowId={2}
        extensions={[shared, browserUse()]}
      />
    </>
  );
  const mounted = render(view(true));
  await streaming(2);
  expect(owners).toHaveLength(2);
  expect(owners[0]!.getState()).toEqual({
    status: "streaming",
    selectedTargetId: "page-a",
    capabilities: { windowScoped: true, interactive: false },
  });
  expect(JSON.stringify(owners.map((owner) => owner.getState()))).not.toMatch(
    /fixture|Window|title|url|token/,
  );
  act(() => {
    for (const socket of fake.sockets)
      socket.emit("BrowserUse.activeTargetChanged", { targetId: "page-c" });
  });
  await waitFor(() =>
    expect(
      document.querySelectorAll('[role="tab"][aria-selected="true"]')[0],
    ).toHaveTextContent("Page C"),
  );
  expect(
    document.querySelectorAll('[role="tab"][aria-selected="true"]')[1],
  ).toHaveTextContent("Window B");
  mounted.rerender(view(false));
  await streaming();
  await waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  expect(owners[0]!.signal.aborted).toBe(true);
  expect(owners[1]!.signal.aborted).toBe(false);
  expect(fake.sockets[0]!.readyState).toBe(3);
  expect(fake.sockets[1]!.readyState).toBe(1);
  expect(await owners[0]!.requestTargetSelection("page-a")).toBe(false);
});

it("retires old connection contexts and subscriptions under replacement and Strict Mode", async () => {
  const fake = browser();
  const owners: ExtensionContext[] = [];
  const events = vi.fn();
  const cleanup = vi.fn();
  const shared: ViewerExtension = {
    id: "shared",
    setup: (context) => {
      owners.push(context);
      context.subscribe("Vendor.changed", events);
      return cleanup;
    },
  };
  const view = (url: string) => (
    <StrictMode>
      <CdpViewer cdpUrl={url} extensions={[shared, browserUse()]} />
    </StrictMode>
  );
  const mounted = render(view("wss://fixture.invalid"));
  await streaming();
  expect(owners).toHaveLength(1);
  const previous = owners[0]!;
  const oldSocket = fake.sockets.at(-1)!;
  mounted.rerender(view("wss://replacement.invalid"));
  await streaming();
  await waitFor(() => expect(owners).toHaveLength(2));
  expect(previous.signal.aborted).toBe(true);
  expect(await previous.requestTargetSelection("page-b")).toBe(false);
  act(() => {
    oldSocket.emit("Vendor.changed", {});
    oldSocket.emit("BrowserUse.activeTargetChanged", { targetId: "page-b" });
    fake.sockets.at(-1)!.emit("Vendor.changed", {});
  });
  expect(events).toHaveBeenCalledOnce();
  expect(
    document.querySelector('[role="tab"][aria-selected="true"]'),
  ).toHaveTextContent("Window A");
  mounted.unmount();
  await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
  expect(owners.every((owner) => owner.signal.aborted)).toBe(true);
});

it.each(["initial", "update"])(
  "reports sanitized %s extension faults while leaving standard viewing usable",
  async (configuration) => {
    browser();
    const errors = vi.fn();
    const view = (fault: boolean) => (
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        onError={errors}
        extensions={
          fault
            ? [
                {
                  id: "bad",
                  setup: () => {
                    throw new Error("private provider payload");
                  },
                },
              ]
            : []
        }
      />
    );
    const mounted = render(view(configuration === "initial"));
    await streaming();
    if (configuration === "update") mounted.rerender(view(true));
    await waitFor(() =>
      expect(errors).toHaveBeenCalledWith({
        kind: "extension",
        message: "An extension could not be initialized.",
      }),
    );
    await streaming();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private");
    mounted.rerender(view(false));
    await streaming();
  },
);

it("keeps extension setup inert during server rendering", () => {
  const setup = vi.fn();
  const connect = vi.fn();
  vi.stubGlobal("WebSocket", connect);
  expect(
    renderToString(
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        extensions={[browserUse(), { id: "inert", setup }]}
      />,
    ),
  ).toContain("Remote browser viewer");
  expect(setup).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
