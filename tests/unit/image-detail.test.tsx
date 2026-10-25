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
import type { ViewerCaptureOptions } from "../../src/index";
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

async function openDetail(scope: ReturnType<typeof within> = screen) {
  await userEvent.click(scope.getByRole("button", { name: "Browser menu" }));
  await userEvent.click(scope.getByRole("menuitem", { name: "Image quality" }));
  return within(await scope.findByRole("dialog", { name: "Image quality" }));
}

it.each(["shared", "split"] as const)(
  "applies menu-owned image detail only to its viewer without reconnecting (%s)",
  async (transport) => {
    const fake = browser();
    const changed = vi.fn();
    render(
      <>
        <CdpViewer
          cdpUrl="wss://fixture.invalid"
          windowId={0}
          interactive
          transport={transport}
          onCaptureChange={changed}
        />
        <CdpViewer
          cdpUrl="wss://fixture.invalid"
          windowId={2}
          interactive
          transport={transport}
        />
      </>,
    );
    const views = screen.getAllByRole("region", {
      name: "Remote browser viewer",
    });
    const owner = within(views[0]!);
    const sibling = within(views[1]!);
    await waitFor(() =>
      expect(owner.getByLabelText("Remote browser input")).toBeEnabled(),
    );
    await waitFor(() =>
      expect(sibling.getByLabelText("Remote browser input")).toBeEnabled(),
    );
    const sockets = [...fake.sockets];
    const input = owner.getByLabelText("Remote browser input");
    const detail = await openDetail(owner);
    const quality = detail.getByRole("slider", { name: "JPEG quality" });
    expect(quality).toHaveValue("70");
    fireEvent.change(quality, { target: { value: "0" } });
    expect(quality).toHaveValue("0");
    await userEvent.selectOptions(
      detail.getByRole("combobox", { name: "Capture resolution maximum" }),
      "1280x720",
    );
    await waitFor(() =>
      expect(
        fake.sockets
          .flatMap((socket) => socket.commands)
          .some(
            (command) =>
              command.method === "Page.startScreencast" &&
              command.params?.quality === 0 &&
              command.params.maxWidth === 1280 &&
              command.params.maxHeight === 720,
          ),
      ).toBe(true),
    );
    expect(changed).toHaveBeenLastCalledWith({
      quality: 0,
      maxWidth: 1280,
      maxHeight: 720,
    });
    await userEvent.selectOptions(
      detail.getByRole("combobox", { name: "Capture resolution maximum" }),
      "automatic",
    );
    expect(changed).toHaveBeenLastCalledWith({ quality: 0 });
    expect(owner.getByLabelText("Remote browser input")).toBe(input);
    expect(fake.sockets).toEqual(sockets);
    expect(
      fake.sockets
        .flatMap((socket) => socket.commands)
        .filter(
          (command) =>
            command.method.startsWith("Emulation.") ||
            command.method === "Browser.setContentsSize",
        ),
    ).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    const siblingDetail = await openDetail(sibling);
    expect(
      siblingDetail.getByRole("slider", { name: "JPEG quality" }),
    ).toHaveValue("70");
    expect(
      siblingDetail.getByRole("combobox", {
        name: "Capture resolution maximum",
      }),
    ).toHaveValue("automatic");
  },
);

it("requests controlled capture changes and waits for the host to apply them", async () => {
  const fake = browser();
  const changed = vi.fn<(capture: ViewerCaptureOptions) => void>();
  const props = {
    cdpUrl: "wss://fixture.invalid",
    interactive: true,
    onCaptureChange: changed,
  };
  const view = render(
    <CdpViewer {...props} capture={{ quality: 45, maxWidth: 1234 }} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const sockets = [...fake.sockets];
  const detail = await openDetail();
  const quality = detail.getByRole("slider", { name: "JPEG quality" });
  const resolution = detail.getByRole("combobox", {
    name: "Capture resolution maximum",
  });
  expect(resolution).toHaveValue("custom");
  expect(
    detail.getByRole("option", { name: "Custom (1234 × auto)" }),
  ).toBeInTheDocument();
  const before = fake.sockets
    .flatMap((socket) => socket.commands)
    .filter((command) => command.method === "Page.startScreencast").length;
  fireEvent.change(quality, { target: { value: "80" } });
  expect(changed).toHaveBeenLastCalledWith({ quality: 80, maxWidth: 1234 });
  expect(quality).toHaveValue("45");
  expect(
    fake.sockets
      .flatMap((socket) => socket.commands)
      .filter((command) => command.method === "Page.startScreencast"),
  ).toHaveLength(before);
  view.rerender(
    <CdpViewer {...props} capture={{ quality: 80, maxWidth: 1234 }} />,
  );
  await waitFor(() => expect(quality).toHaveValue("80"));
  await waitFor(() =>
    expect(
      fake.sockets
        .flatMap((socket) => socket.commands)
        .filter((command) => command.method === "Page.startScreencast")
        .at(-1)?.params?.quality,
    ).toBe(80),
  );
  await userEvent.selectOptions(resolution, "automatic");
  expect(changed).toHaveBeenLastCalledWith({ quality: 80 });
  expect(resolution).toHaveValue("custom");
  expect(fake.sockets).toEqual(sockets);
});

it("keeps fixed host settings disabled and makes callback changes live without reconnecting", async () => {
  const fake = browser();
  const capture = { quality: 0, maxHeight: 720 };
  const props = { cdpUrl: "wss://fixture.invalid", interactive: true, capture };
  const view = render(<CdpViewer {...props} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const detail = await openDetail();
  const quality = detail.getByRole("slider", { name: "JPEG quality" });
  const resolution = detail.getByRole("combobox", {
    name: "Capture resolution maximum",
  });
  expect(quality).toHaveValue("0");
  expect(quality).toBeDisabled();
  expect(resolution).toBeDisabled();
  expect(
    detail.getByRole("option", { name: "Custom (auto × 720)" }),
  ).toBeInTheDocument();
  fireEvent.change(quality, { target: { value: "40" } });
  expect(quality).toHaveValue("0");
  const first = vi.fn();
  view.rerender(<CdpViewer {...props} onCaptureChange={first} />);
  await waitFor(() => expect(quality).toBeEnabled());
  fireEvent.change(quality, { target: { value: "40" } });
  expect(first).toHaveBeenCalledWith({ quality: 40, maxHeight: 720 });
  const second = vi.fn();
  view.rerender(<CdpViewer {...props} onCaptureChange={second} />);
  fireEvent.change(quality, { target: { value: "50" } });
  expect(second).toHaveBeenCalledWith({ quality: 50, maxHeight: 720 });
  expect(first).toHaveBeenCalledOnce();
  expect(fake.sockets).toHaveLength(1);
});

it("keeps menu-owned settings through callback updates and applies paused changes on resume", async () => {
  const fake = browser();
  const props = { cdpUrl: "wss://fixture.invalid", interactive: true };
  const view = render(<CdpViewer {...props} paused />);
  const detail = await openDetail();
  const quality = detail.getByRole("slider", { name: "JPEG quality" });
  fireEvent.change(quality, { target: { value: "85" } });
  view.rerender(<CdpViewer {...props} onCaptureChange={() => {}} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  expect(quality).toHaveValue("85");
  expect(
    fake.sockets
      .flatMap((socket) => socket.commands)
      .filter((command) => command.method === "Page.startScreencast")
      .at(-1)?.params?.quality,
  ).toBe(85);
  expect(fake.sockets).toHaveLength(1);
});
