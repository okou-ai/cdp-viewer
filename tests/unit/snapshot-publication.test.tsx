import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import type { ViewerSnapshot } from "../../src/index";
import { FakeBrowser } from "./wire";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function browser() {
  const fake = new FakeBrowser();
  vi.stubGlobal("WebSocket", function () {
    return fake.factory("wss://fixture.invalid");
  });
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({
    ...(JSON.parse(await blob.text()) as { width: number; height: number }),
    close() {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
  return fake;
}

async function advance(milliseconds = 0) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

it.each([
  { pages: 1, paused: false },
  { pages: 20, paused: false },
  { pages: 20, paused: true },
])("skips unchanged idle callbacks for %j", async ({ pages, paused }) => {
  const fake = browser();
  fake.targets = Array.from({ length: pages }, (_, index) => ({
    id: "owned-" + index,
    windowId: 0,
    title: "Owned page " + index,
  }));
  const changed = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      windowId={0}
      paused={paused}
      onStatusChange={changed}
    />,
  );
  await advance();
  expect(changed.mock.lastCall?.[0]).toMatchObject({
    status: paused ? "paused" : "streaming",
    selectedTargetId: "owned-0",
    error: null,
  });
  expect(changed.mock.lastCall?.[0].targets).toHaveLength(pages);
  const socket = fake.sockets[0]!;
  const queries = () =>
    socket.commands.filter((command) => command.method === "Target.getTargets")
      .length;
  const initialQueries = queries();
  changed.mockClear();
  // Separate ticks allow a React commit for each discovery observation.
  for (const elapsed of [2000, 2000, 2000, 100]) await advance(elapsed);
  expect(queries() - initialQueries).toBe(0);
  expect(changed).not.toHaveBeenCalled();
  expect(view.container.querySelector(".cdpv-root")).toHaveAttribute(
    "data-status",
    paused ? "paused" : "streaming",
  );
  // Include a full authoritative round as well as the selected-only idle checks.
  await advance(3900);
  expect(queries() - initialQueries).toBe(1);
  expect(changed).not.toHaveBeenCalled();
  view.unmount();
});

it("delivers real target and selection changes to replacement callbacks independently", async () => {
  const fake = browser();
  const original = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const replacement = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const sibling = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const viewers = (onStatusChange: typeof original, paused = false) => (
    <>
      <div data-testid="owner">
        <CdpViewer
          cdpUrl="wss://fixture.invalid"
          windowId={0}
          paused={paused}
          onStatusChange={onStatusChange}
        />
      </div>
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        windowId={2}
        onStatusChange={sibling}
      />
    </>
  );
  const view = render(viewers(original));
  await advance();
  expect(original.mock.lastCall?.[0].status).toBe("streaming");
  expect(sibling.mock.lastCall?.[0].status).toBe("streaming");
  const sockets = [...fake.sockets];
  const changedTarget = (index: number) => {
    const target = fake.targets[index]!;
    act(() => {
      for (const socket of fake.sockets)
        socket.emit("Target.targetInfoChanged", {
          targetInfo: {
            targetId: target.id,
            type: "page",
            title: target.title,
          },
        });
    });
  };
  original.mockClear();
  sibling.mockClear();
  view.rerender(viewers(replacement));
  await advance(2000);
  expect(replacement).not.toHaveBeenCalled();

  fake.targets[0]!.title = "Renamed page";
  changedTarget(0);
  await advance(2000);
  expect(replacement).toHaveBeenCalledOnce();
  expect(replacement.mock.lastCall?.[0].targets).toEqual([
    { id: "page-a", title: "Renamed page" },
  ]);
  const owner = within(view.getByTestId("owner"));
  expect(owner.getByRole("tab", { selected: true })).toHaveAccessibleName(
    "Renamed page",
  );

  fake.targets.push({ id: "page-c", title: "Added page", windowId: 0 });
  changedTarget(fake.targets.length - 1);
  await advance(2000);
  expect(replacement.mock.lastCall?.[0].targets).toHaveLength(2);
  fireEvent.click(owner.getByRole("tab", { name: "Added page" }));
  await advance();
  expect(replacement.mock.lastCall?.[0]).toMatchObject({
    status: "streaming",
    selectedTargetId: "page-c",
  });
  fake.targets = fake.targets.filter((target) => target.id !== "page-a");
  act(() => {
    for (const socket of fake.sockets)
      socket.emit("Target.targetDestroyed", { targetId: "page-a" });
  });
  await advance(2000);
  expect(replacement.mock.lastCall?.[0].targets).toEqual([
    { id: "page-c", title: "Added page" },
  ]);
  view.rerender(viewers(replacement, true));
  await advance();
  expect(replacement.mock.lastCall?.[0].status).toBe("paused");
  expect(original).not.toHaveBeenCalled();
  expect(sibling).not.toHaveBeenCalled();
  expect(fake.sockets).toEqual(sockets);
  view.unmount();
  expect(sockets.every((socket) => socket.readyState === 3)).toBe(true);
});

it("filters equal navigation observations and delivers changed URL and history", async () => {
  const fake = browser();
  const changed = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      windowId={0}
      interactive
      onStatusChange={changed}
    />,
  );
  await advance();
  expect(view.getByLabelText("Remote browser input")).toBeEnabled();
  expect(changed.mock.lastCall?.[0].navigation?.url).toBe(
    "https://fixture.invalid/",
  );
  const socket = fake.sockets[0]!;
  const session = socket.commands.find(
    (command) => command.method === "Page.getFrameTree",
  )!.sessionId!;
  fake.holdMethod = "Page.getNavigationHistory";
  const history = async (urls: string[], currentIndex: number) => {
    act(() => socket.emit("Page.loadEventFired", {}, session));
    await advance();
    expect(fake.heldCommands).toHaveLength(1);
    const held = fake.heldCommands.shift()!;
    act(() =>
      held.socket.reply(held.command, {
        currentIndex,
        entries: urls.map((url, index) => ({
          id: index + 1,
          url,
          title: "Owned page",
        })),
      }),
    );
    await advance();
  };
  changed.mockClear();
  await history(["https://fixture.invalid/"], 0);
  expect(changed).not.toHaveBeenCalled();
  await history(["https://fixture.invalid/", "https://next.invalid/"], 1);
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.lastCall?.[0].navigation).toEqual({
    url: "https://next.invalid/",
    canGoBack: true,
    canGoForward: false,
  });
  await history(["https://fixture.invalid/", "https://next.invalid/"], 1);
  expect(changed).toHaveBeenCalledOnce();
  await history(
    [
      "https://fixture.invalid/",
      "https://next.invalid/",
      "https://last.invalid/",
    ],
    1,
  );
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed.mock.lastCall?.[0].navigation?.canGoForward).toBe(true);
  view.unmount();
});

it("refreshes repeated warning expiry independently of unchanged discovery", async () => {
  browser();
  const changed = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      windowId={0}
      interactive
      onStatusChange={changed}
    />,
  );
  await advance();
  const address = view.getByRole("textbox", { name: "Remote page address" });
  fireEvent.change(address, { target: { value: "not-an-address" } });
  fireEvent.keyDown(address, { key: "Enter" });
  await advance();
  const first = view.getByRole("alert").getAttribute("data-notification-id");
  expect(changed.mock.lastCall?.[0].error?.kind).toBe("input");
  await advance(4000);
  fireEvent.keyDown(address, { key: "Enter" });
  await advance();
  const replacement = view
    .getByRole("alert")
    .getAttribute("data-notification-id");
  expect(replacement).not.toBe(first);
  changed.mockClear();
  await advance(1000);
  expect(view.getByRole("alert")).toHaveAttribute(
    "data-notification-id",
    replacement,
  );
  expect(view.getByRole("alert")).toHaveAttribute("data-phase", "visible");
  await advance(4000);
  expect(view.queryByRole("alert")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  view.unmount();
});
