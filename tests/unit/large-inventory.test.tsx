import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import type { ViewerSnapshot } from "../../src/index";
import { FakeBrowser } from "./wire";

afterEach(() => vi.unstubAllGlobals());

it("keeps complete large inventories usable through independent public viewers", async () => {
  const fake = new FakeBrowser();
  fake.targets = [
    ...Array.from({ length: 600 }, (_, index) => ({
      id: "foreign-" + index,
      title: "Foreign " + index,
      windowId: 2,
    })),
    { id: "owned-first", title: "Owned first", windowId: 0 },
    { id: "owned-last", title: "Owned last", windowId: 0 },
  ];
  vi.stubGlobal("WebSocket", function () {
    return fake.factory("wss://fixture.invalid");
  });
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({
    ...(JSON.parse(await blob.text()) as { width: number; height: number }),
    close: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const scopedStatus = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const allStatus = vi.fn<(snapshot: ViewerSnapshot) => void>();
  const scoped = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      windowId={0}
      onStatusChange={scopedStatus}
    />,
  );
  const all = render(
    <CdpViewer cdpUrl="wss://fixture.invalid" onStatusChange={allStatus} />,
  );
  await waitFor(() => {
    expect(scopedStatus.mock.lastCall?.[0]).toMatchObject({
      status: "streaming",
      targets: [
        { id: "owned-first", title: "Owned first" },
        { id: "owned-last", title: "Owned last" },
      ],
    });
    expect(allStatus.mock.lastCall?.[0].status).toBe("streaming");
  });
  expect(allStatus.mock.lastCall?.[0].targets).toHaveLength(602);
  fireEvent.click(
    within(all.container).getByRole("tab", { name: "Owned last" }),
  );
  await waitFor(() =>
    expect(allStatus.mock.lastCall?.[0]).toMatchObject({
      status: "streaming",
      selectedTargetId: "owned-last",
    }),
  );
  expect(
    fake.sockets[1]!.commands.some(
      (command) => command.method === "Browser.getWindowForTarget",
    ),
  ).toBe(false);
  act(() => {
    fake.targets[601]!.title = "Renamed last";
    for (const socket of fake.sockets)
      socket.emit("Target.targetInfoChanged", {
        targetInfo: {
          targetId: "owned-last",
          type: "page",
          title: "Renamed last",
        },
      });
  });
  await waitFor(() => {
    expect(scopedStatus.mock.lastCall?.[0].targets.at(-1)?.title).toBe(
      "Renamed last",
    );
    expect(allStatus.mock.lastCall?.[0].targets.at(-1)?.title).toBe(
      "Renamed last",
    );
  });
  scoped.unmount();
  expect(fake.sockets[0]!.readyState).toBe(3);
  expect(fake.sockets[1]!.readyState).toBe(1);
  expect(allStatus.mock.lastCall?.[0].status).toBe("streaming");
  all.unmount();
});
