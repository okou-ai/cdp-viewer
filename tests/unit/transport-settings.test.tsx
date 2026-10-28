import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import type { ViewerTransport } from "../../src/index";
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

async function openTransport(scope: ReturnType<typeof within> = screen) {
  await userEvent.click(scope.getByRole("button", { name: "Browser menu" }));
  const menu = scope.getByRole("menu", { name: "Browser menu", exact: true });
  expect(within(menu).getAllByRole("menuitem")[0]).toHaveTextContent(
    "Transport",
  );
  await userEvent.click(
    scope.getByRole("menuitem", { name: "Transport", exact: true }),
  );
  return within(
    await scope.findByRole("menu", { name: "Transport", exact: true }),
  );
}

it("switches only its menu-owned viewer and retains capture and display preferences", async () => {
  const fake = browser();
  const changed = vi.fn();
  render(
    <>
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        windowId={0}
        interactive
        onTransportChange={changed}
      />
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={2} interactive />
    </>,
  );
  const [first, second] = screen.getAllByRole("region", {
    name: "Remote browser viewer",
  });
  const owner = within(first!),
    sibling = within(second!);
  await waitFor(() =>
    expect(owner.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  await waitFor(() =>
    expect(sibling.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const [original, independent] = fake.sockets;
  const input = owner.getByLabelText("Remote browser input");
  await userEvent.click(owner.getByRole("button", { name: "Browser menu" }));
  await userEvent.click(
    owner.getByRole("menuitem", { name: "Capture quality" }),
  );
  const detail = within(owner.getByRole("dialog", { name: "Capture quality" }));
  fireEvent.change(detail.getByRole("slider"), { target: { value: "0" } });
  await userEvent.click(detail.getByRole("radio", { name: "1280 × 720" }));
  await userEvent.keyboard("{Escape}");
  await userEvent.click(
    owner.getByRole("menuitem", { name: "Fit to this viewer" }),
  );
  await userEvent.click(
    await owner.findByRole("menuitemradio", { name: "Sync once on opening" }),
  );

  const transport = await openTransport(owner);
  expect(
    transport.getByRole("menuitemradio", { name: "Shared" }),
  ).toBeChecked();
  await userEvent.click(
    transport.getByRole("menuitemradio", { name: "Split frame / control" }),
  );
  await waitFor(() => expect(fake.sockets).toHaveLength(4));
  await waitFor(() =>
    expect(owner.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(original!.readyState).toBe(3);
  expect(independent!.readyState).toBe(1);
  expect(changed).toHaveBeenLastCalledWith("split");
  expect(
    fake.sockets
      .slice(2)
      .flatMap((socket) => socket.commands)
      .some(
        (command) =>
          command.method === "Page.startScreencast" &&
          command.params?.quality === 0 &&
          command.params.maxWidth === 1280 &&
          command.params.maxHeight === 720,
      ),
  ).toBe(true);
  const split = await openTransport(owner);
  expect(
    split.getByRole("menuitemradio", { name: "Split frame / control" }),
  ).toBeChecked();
  await userEvent.click(
    split.getByRole("menuitemradio", { name: "Split frame / control" }),
  );
  expect(fake.sockets).toHaveLength(4);
  expect(changed).toHaveBeenCalledOnce();
  const same = await openTransport(owner);
  await userEvent.click(same.getByRole("menuitemradio", { name: "Shared" }));
  await waitFor(() => expect(fake.sockets).toHaveLength(5));
  await waitFor(() =>
    expect(owner.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(
    fake.sockets.slice(2, 4).every((socket) => socket.readyState === 3),
  ).toBe(true);
  expect(independent!.readyState).toBe(1);
  expect(owner.getByLabelText("Remote browser input")).toBe(input);
  expect(changed).toHaveBeenLastCalledWith("shared");
  await userEvent.click(owner.getByRole("button", { name: "Browser menu" }));
  await userEvent.click(
    owner.getByRole("menuitem", { name: "Fit to this viewer" }),
  );
  expect(
    await owner.findByRole("menuitemradio", { name: "Sync once on opening" }),
  ).toBeChecked();
  await userEvent.keyboard("{Escape}{Escape}");
  const other = await openTransport(sibling);
  expect(other.getByRole("menuitemradio", { name: "Shared" })).toBeChecked();
});

it("waits for controlled updates and uses replacement callbacks without reconnecting", async () => {
  const fake = browser();
  const first = vi.fn(),
    second = vi.fn();
  const props = { cdpUrl: "wss://fixture.invalid", interactive: true };
  const view = render(
    <CdpViewer {...props} transport="shared" onTransportChange={first} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const menu = await openTransport();
  await userEvent.click(
    menu.getByRole("menuitemradio", { name: "Split frame / control" }),
  );
  expect(first).toHaveBeenCalledWith("split");
  expect(fake.sockets).toHaveLength(1);
  const pending = await openTransport();
  expect(pending.getByRole("menuitemradio", { name: "Shared" })).toBeChecked();
  view.rerender(
    <CdpViewer {...props} transport="split" onTransportChange={first} />,
  );
  await waitFor(() => expect(fake.sockets).toHaveLength(3));
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(
    pending.getByRole("menuitemradio", { name: "Split frame / control" }),
  ).toBeChecked();
  view.rerender(
    <CdpViewer {...props} transport="split" onTransportChange={second} />,
  );
  expect(fake.sockets).toHaveLength(3);
  await userEvent.click(pending.getByRole("menuitemradio", { name: "Shared" }));
  expect(second).toHaveBeenCalledWith("shared");
  expect(first).toHaveBeenCalledOnce();
  expect(fake.sockets).toHaveLength(3);
});

it("keeps fixed host values checked and disabled until a callback is supplied", async () => {
  const fake = browser();
  const props = {
    cdpUrl: "wss://fixture.invalid",
    interactive: true,
    transport: "split" as const,
  };
  const view = render(<CdpViewer {...props} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const menu = await openTransport();
  expect(
    menu.getByRole("menuitemradio", { name: "Split frame / control" }),
  ).toBeChecked();
  for (const option of menu.getAllByRole("menuitemradio"))
    expect(option).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(menu.getByRole("menuitemradio", { name: "Shared" }));
  expect(fake.sockets).toHaveLength(2);
  const changed = vi.fn();
  view.rerender(<CdpViewer {...props} onTransportChange={changed} />);
  await userEvent.click(menu.getByRole("menuitemradio", { name: "Shared" }));
  expect(changed).toHaveBeenCalledWith("shared");
  expect(fake.sockets).toHaveLength(2);
});

it("preserves menu-owned transport through hidden settings, callback changes and pause", async () => {
  const fake = browser();
  const props = { cdpUrl: "wss://fixture.invalid", interactive: true };
  const view = render(<CdpViewer {...props} paused />);
  const menu = await openTransport();
  await userEvent.click(
    menu.getByRole("menuitemradio", { name: "Split frame / control" }),
  );
  await waitFor(() => expect(fake.sockets).toHaveLength(3));
  expect(
    fake.sockets
      .flatMap((socket) => socket.commands)
      .some((command) => command.method === "Page.startScreencast"),
  ).toBe(false);
  view.rerender(<CdpViewer {...props} paused showSettingsMenu={false} />);
  expect(
    screen.queryByRole("button", { name: "Browser menu" }),
  ).not.toBeInTheDocument();
  const changed = vi.fn();
  view.rerender(<CdpViewer {...props} onTransportChange={changed} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(fake.sockets).toHaveLength(3);
  const resumed = await openTransport();
  expect(
    resumed.getByRole("menuitemradio", { name: "Split frame / control" }),
  ).toBeChecked();
  await userEvent.click(resumed.getByRole("menuitemradio", { name: "Shared" }));
  expect(changed).toHaveBeenCalledWith("shared");
});

it("validates an invalid initial host mode before connecting and accepts correction", async () => {
  const fake = browser();
  const props = { cdpUrl: "wss://fixture.invalid", interactive: true };
  const view = render(
    <CdpViewer {...props} transport={"invalid" as ViewerTransport} />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Remote browser viewer" }),
    ).toHaveAttribute("data-status", "error"),
  );
  expect(fake.sockets).toHaveLength(0);
  view.rerender(<CdpViewer {...props} transport="split" />);
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(fake.sockets).toHaveLength(2);
  const menu = await openTransport();
  expect(
    menu.getByRole("menuitemradio", { name: "Split frame / control" }),
  ).toBeChecked();
});
