import {
  act,
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
  await userEvent.click(
    scope.getByRole("menuitem", { name: "Capture quality" }),
  );
  return within(await scope.findByRole("dialog", { name: "Capture quality" }));
}

it.each([
  ["mouse", "Enter"],
  ["mouse", "Space"],
  ["keyboard", "Enter"],
  ["keyboard", "Space"],
] as const)(
  "keeps initial menu focus and capture activation in menu order (%s opening, %s activation)",
  async (method, activation) => {
    const fake = browser();
    const changed = vi.fn();
    render(
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        interactive
        onCaptureChange={changed}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
    );
    const trigger = screen.getByRole("button", { name: "Browser menu" });
    if (method === "mouse") await userEvent.click(trigger);
    else {
      trigger.focus();
      await userEvent.keyboard("{Enter}");
    }
    const menu = screen.getByRole("menu", {
      name: "Browser menu",
    });
    const transport = within(menu).getByRole("menuitem", {
      name: "Transport",
    });
    const capture = within(menu).getByRole("menuitem", {
      name: "Capture quality",
    });
    if (method === "mouse") {
      await waitFor(() => expect(menu).toHaveFocus());
      expect(menu.querySelector("[data-highlighted]")).not.toBeInTheDocument();
      await userEvent.keyboard("{ArrowDown}");
    }
    await waitFor(() => expect(transport).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Capture quality" }),
    ).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(capture).toHaveFocus());
    expect(capture).toHaveAttribute("data-highlighted");
    await userEvent.keyboard(activation === "Space" ? " " : "{Enter}");
    const detail = within(
      await screen.findByRole("dialog", { name: "Capture quality" }),
    );
    await waitFor(() =>
      expect(
        detail.getByRole("slider", { name: "Image quality" }),
      ).toHaveFocus(),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(capture).toHaveFocus());
    expect(menu).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("menu", { name: "Browser menu" }),
    ).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    expect(
      fake.sockets
        .flatMap((socket) => socket.commands)
        .filter((command) => command.method.startsWith("Input.")),
    ).toHaveLength(0);
  },
);

it.each(["shared", "split"] as const)(
  "applies menu-owned capture quality only to its viewer without reconnecting (%s)",
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
    const quality = detail.getByRole("slider", { name: "Image quality" });
    expect(quality).toHaveValue("70");
    expect(detail.getAllByRole("radio")).toHaveLength(8);
    expect(detail.getByRole("radio", { name: "WebP" })).toBeChecked();
    expect(detail.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(detail.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(detail.getByRole("radio", { name: "JPEG" }));
    expect(detail.getByRole("radio", { name: "JPEG" })).toBeChecked();
    expect(changed).toHaveBeenLastCalledWith({ format: "jpeg" });
    fireEvent.change(quality, { target: { value: "0" } });
    expect(quality).toHaveValue("0");
    await userEvent.click(detail.getByRole("radio", { name: "1280 × 720" }));
    expect(detail.getByRole("radio", { name: "1280 × 720" })).toBeChecked();
    expect(detail.getAllByRole("radio", { checked: true })).toHaveLength(2);
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
      format: "jpeg",
      quality: 0,
      maxWidth: 1280,
      maxHeight: 720,
    });
    await userEvent.click(detail.getByRole("radio", { name: "Auto" }));
    expect(changed).toHaveBeenLastCalledWith({ format: "jpeg", quality: 0 });
    expect(detail.getByRole("radio", { name: "Auto" })).toBeChecked();
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
      siblingDetail.getByRole("slider", { name: "Image quality" }),
    ).toHaveValue("70");
    expect(siblingDetail.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(siblingDetail.getByRole("radio", { name: "WebP" })).toBeChecked();
  },
);

it("requests controlled format changes while preserving custom bounds and Auto preferences", async () => {
  const fake = browser();
  const changed = vi.fn<(capture: ViewerCaptureOptions) => void>();
  const props = {
    cdpUrl: "wss://fixture.invalid",
    interactive: true,
    onCaptureChange: changed,
  };
  const capture: ViewerCaptureOptions = {
    format: "jpeg",
    quality: 37,
    maxWidth: 1234,
    maxHeight: 777,
  };
  const view = render(<CdpViewer {...props} capture={capture} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
  );
  const starts = () =>
    fake.sockets.flatMap((socket) =>
      socket.commands.filter((c) => c.method === "Page.startScreencast"),
    );
  const detail = await openDetail();
  const jpeg = detail.getByRole("radio", { name: "JPEG" });
  const webp = detail.getByRole("radio", { name: "WebP" });
  expect(jpeg).toBeChecked();
  await userEvent.click(webp);
  expect(changed).toHaveBeenLastCalledWith({ ...capture, format: "webp" });
  expect(jpeg).toBeChecked();
  expect(starts()).toHaveLength(1);
  view.rerender(
    <CdpViewer {...props} capture={{ ...capture, format: "webp" }} />,
  );
  await waitFor(() => expect(starts()).toHaveLength(2));
  expect(webp).toBeChecked();
  expect(starts()[1]!.params).toMatchObject({ ...capture, format: "webp" });
  await userEvent.click(detail.getByRole("radio", { name: "Auto" }));
  expect(changed).toHaveBeenLastCalledWith({ format: "webp", quality: 37 });
  expect(fake.sockets).toHaveLength(1);
});

it.each(["shared", "split"] as const)(
  "lets users choose JPEG and explicitly retry a rejected WebP stream (%s)",
  async (transport) => {
    const fake = browser();
    fake.holdMethod = "Page.startScreencast";
    render(
      <CdpViewer
        cdpUrl="wss://fixture.invalid"
        interactive
        transport={transport}
      />,
    );
    await waitFor(() => expect(fake.heldCommands).toHaveLength(1));
    const held = fake.heldCommands.shift()!;
    expect(held.command.params?.format).toBe("webp");
    fake.holdMethod = null;
    act(() => held.socket.reject(held.command, -32602));
    const retry = await screen.findByRole("button", {
      name: "Retry live image",
    });
    await waitFor(() => expect(retry).toBeEnabled());
    const sockets = [...fake.sockets];
    const detail = await openDetail();
    await userEvent.click(detail.getByRole("radio", { name: "JPEG" }));
    expect(detail.getByRole("radio", { name: "JPEG" })).toBeChecked();
    const starts = () =>
      fake.sockets.flatMap((socket) =>
        socket.commands.filter((c) => c.method === "Page.startScreencast"),
      );
    expect(starts()).toHaveLength(1);
    await userEvent.keyboard("{Escape}{Escape}");
    await userEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled(),
    );
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).toMatchObject({
      sessionId: held.command.sessionId,
      params: { format: "jpeg" },
    });
    expect(fake.sockets).toEqual(sockets);
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
  const quality = detail.getByRole("slider", { name: "Image quality" });
  const resolution = detail.getByRole("radiogroup", {
    name: "Capture resolution maximum",
  });
  expect(
    within(resolution).queryAllByRole("radio", { checked: true }),
  ).toHaveLength(0);
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
  await userEvent.click(detail.getByRole("radio", { name: "Auto" }));
  expect(changed).toHaveBeenLastCalledWith({ quality: 80 });
  expect(
    within(resolution).queryAllByRole("radio", { checked: true }),
  ).toHaveLength(0);
  expect(fake.sockets).toEqual(sockets);
});

it("checks only exact resolution matches and leaves custom bounds unchecked", async () => {
  browser();
  const props = { cdpUrl: "wss://fixture.invalid", interactive: true };
  const view = render(
    <CdpViewer {...props} capture={{ maxWidth: 1280, maxHeight: 720 }} />,
  );
  const detail = await openDetail();
  expect(detail.getByRole("radio", { name: "1280 × 720" })).toBeChecked();
  const resolution = within(
    detail.getByRole("radiogroup", {
      name: "Capture resolution maximum",
    }),
  );
  expect(resolution.getAllByRole("radio", { checked: true })).toHaveLength(1);
  view.rerender(
    <CdpViewer {...props} capture={{ maxWidth: 1280, maxHeight: 721 }} />,
  );
  expect(resolution.queryAllByRole("radio", { checked: true })).toHaveLength(0);
  view.rerender(<CdpViewer {...props} capture={{ maxWidth: 1280 }} />);
  expect(resolution.queryAllByRole("radio", { checked: true })).toHaveLength(0);
  view.rerender(<CdpViewer {...props} capture={{ quality: 0 }} />);
  expect(detail.getByRole("radio", { name: "Auto" })).toBeChecked();
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
  const quality = detail.getByRole("slider", { name: "Image quality" });
  expect(quality).toHaveValue("0");
  expect(quality).toBeDisabled();
  for (const option of detail.getAllByRole("radio"))
    expect(option).toBeDisabled();
  expect(detail.getByRole("radio", { name: "WebP" })).toBeChecked();
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
  const quality = detail.getByRole("slider", { name: "Image quality" });
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
