import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
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

it("places host controls in the tab row and host content over the stage", async () => {
  browser();
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      tabStyle="floating"
      toolbarEnd={<button type="button">Close panel</button>}
      stageOverlay={<p>Agent working</p>}
      labels={{ addressPlaceholder: "Search or enter a URL" }}
    />,
  );
  const root = view.container.querySelector(".cdpv-root")!;
  expect(root).toHaveAttribute("data-tab-style", "floating");
  const row = view.container.querySelector(".cdpv-toolbar")!;
  expect(
    within(row as HTMLElement).getByRole("button", { name: "Close panel" }),
  ).toBeInTheDocument();
  const stage = view.container.querySelector(".cdpv-stage")!;
  expect(within(stage as HTMLElement).getByText("Agent working")).toBeVisible();
  expect(
    screen.getByPlaceholderText("Search or enter a URL"),
  ).toBeInTheDocument();
});

it("names blank pages with the host label and shows the blank page only for about:blank", async () => {
  const fake = browser();
  fake.targets = [{ id: "page-a", windowId: 0, title: "about:blank" }];
  fake.navigationHistory = {
    currentIndex: 0,
    entries: [{ id: 1, url: "about:blank", title: "about:blank" }],
  };
  const view = render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      blankPage={<p>Start somewhere</p>}
      labels={{ blankTabTitle: "Start page" }}
    />,
  );
  expect(
    await screen.findByRole("tab", { name: "Start page" }),
  ).toBeInTheDocument();
  expect(await screen.findByText("Start somewhere")).toBeInTheDocument();
  view.unmount();

  const visited = browser();
  visited.targets = [{ id: "page-a", windowId: 0, title: "Fixture" }];
  render(
    <CdpViewer
      cdpUrl="wss://fixture.invalid"
      interactive
      blankPage={<p>Start somewhere</p>}
    />,
  );
  expect(await screen.findByRole("tab", { name: "Fixture" })).toBeVisible();
  await waitFor(() =>
    expect(screen.getByLabelText("Remote page address")).toHaveValue(
      "https://fixture.invalid/",
    ),
  );
  expect(screen.queryByText("Start somewhere")).not.toBeInTheDocument();
});

it("keeps the English default for an unnamed blank tab", async () => {
  const fake = browser();
  fake.targets = [{ id: "page-a", windowId: 0, title: "about:blank" }];
  render(<CdpViewer cdpUrl="wss://fixture.invalid" interactive />);
  expect(await screen.findByRole("tab", { name: "New tab" })).toBeVisible();
});
