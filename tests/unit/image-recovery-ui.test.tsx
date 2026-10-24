import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import { FakeBrowser } from "./wire";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const browser = new FakeBrowser();
  vi.stubGlobal("WebSocket", function () {
    return browser.factory("wss://fixture.invalid");
  });
  const decode = vi.fn(async (blob: Blob) => ({
    ...(JSON.parse(await blob.text()) as { width: number; height: number }),
    close: vi.fn(),
  }));
  vi.stubGlobal("createImageBitmap", decode);
  const clear = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: clear,
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  return { browser, decode, clear };
}

it.each(["shared", "split"] as const)(
  "%s: exposes explicit image retry and keeps native input and connections",
  async (transport) => {
    const f = fixture();
    f.browser.holdMethod = "Page.getNavigationHistory";
    const props = {
      cdpUrl: "wss://fixture.invalid",
      interactive: true,
      transport,
    };
    const view = render(<CdpViewer {...props} />);
    const input = screen.getByLabelText("Remote browser input");
    await waitFor(() => expect(input).toBeEnabled());
    await waitFor(() => expect(f.browser.heldCommands).toHaveLength(1));
    const history = f.browser.heldCommands.shift()!;
    f.browser.holdMethod = null;
    act(() =>
      history.socket.reply(history.command, {
        currentIndex: 1,
        entries: [
          { id: 1, url: "https://fixture.invalid/before", title: "Before" },
          { id: 2, url: "https://fixture.invalid/", title: "Current" },
          { id: 3, url: "https://fixture.invalid/after", title: "After" },
        ],
      }),
    );
    const address = screen.getByRole("textbox", {
      name: "Remote page address",
    });
    const back = screen.getByRole("button", { name: "Back remote page" });
    const forward = screen.getByRole("button", { name: "Forward remote page" });
    await waitFor(() =>
      expect(address).toHaveValue("https://fixture.invalid/"),
    );
    expect(back).toBeEnabled();
    expect(forward).toBeEnabled();
    const frame = f.browser.sockets[transport === "split" ? 1 : 0]!;
    const session = frame.commands.find(
      (command) => command.method === "Page.startScreencast",
    )!.sessionId!;
    const sockets = [...f.browser.sockets];
    const clears = f.clear.mock.calls.length;
    f.decode.mockRejectedValueOnce(new Error("Synthetic decode failure"));
    act(() => f.browser.frame(frame, session));
    const retry = await screen.findByRole("button", {
      name: "Retry live image",
    });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.getByText("Live image unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect viewer" }),
    ).toBeEnabled();
    expect(input).toBeDisabled();
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();
    expect(f.clear.mock.calls.length).toBeGreaterThan(clears);
    view.rerender(<CdpViewer {...props} capture={{ quality: 40 }} />);
    f.browser.holdFrames = true;
    await userEvent.click(retry);
    await waitFor(() => expect(f.browser.heldFrames).toHaveLength(1));
    const pending = screen.getByRole("button", {
      name: "Retrying live image…",
    });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(input).toBeDisabled();
    act(() => f.browser.heldFrames.shift()!());
    await waitFor(() => expect(input).toBeEnabled());
    expect(address).toHaveValue("https://fixture.invalid/");
    expect(back).toBeEnabled();
    expect(forward).toBeEnabled();
    expect(screen.getByLabelText("Remote browser input")).toBe(input);
    expect(f.browser.sockets).toEqual(sockets);
    expect(
      frame.commands.filter(
        (command) => command.method === "Page.startScreencast",
      ),
    ).toHaveLength(2);
    expect(frame.commands.at(-1)?.method).not.toBe("Target.detachFromTarget");
  },
);

it("offers image recovery in a view-only viewer and keeps reconnect as a distinct action", async () => {
  const f = fixture();
  const view = render(<CdpViewer cdpUrl="wss://fixture.invalid" />);
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  const socket = f.browser.sockets[0]!;
  const session = socket.commands.find(
    (command) => command.method === "Page.startScreencast",
  )!.sessionId!;
  f.decode.mockRejectedValueOnce(new Error("Synthetic decode failure"));
  act(() => f.browser.frame(socket, session));
  const retry = await screen.findByRole("button", { name: "Retry live image" });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
  expect(f.browser.sockets).toHaveLength(1);
  expect(
    socket.commands.filter(
      (command) => command.method === "Target.attachToTarget",
    ),
  ).toHaveLength(1);
  expect(
    socket.commands.filter(
      (command) => command.method === "Page.startScreencast",
    ),
  ).toHaveLength(2);
  f.decode.mockRejectedValueOnce(new Error("Synthetic second image failure"));
  act(() => f.browser.frame(socket, session));
  await screen.findByRole("button", { name: "Retry live image" });
  await userEvent.click(
    screen.getByRole("button", { name: "Reconnect viewer" }),
  );
  await waitFor(() => expect(f.browser.sockets).toHaveLength(2));
  expect(socket.readyState).toBe(3);
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-status="streaming"]'),
    ).toBeInTheDocument(),
  );
});

it.each(["unsupported", "scope"] as const)(
  "does not advertise image retry for %s failures",
  async (failure) => {
    const f = fixture();
    f.browser.unsupportedStream = failure === "unsupported";
    f.browser.unsupportedWindows = failure === "scope";
    render(
      <CdpViewer cdpUrl="wss://fixture.invalid" windowId={0} interactive />,
    );
    await screen.findByRole("button", { name: "Reconnect viewer" });
    expect(
      screen.queryByRole("button", { name: "Retry live image" }),
    ).not.toBeInTheDocument();
  },
);
