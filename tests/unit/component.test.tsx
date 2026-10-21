import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, state } from "ccstate";
import { StoreProvider, useGet } from "ccstate-react";
import { LucideProvider, Plus } from "lucide-react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
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
    vi.fn(() => Promise.resolve({ width: 2, height: 2, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  return fake;
}

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
  vi.stubGlobal("WebSocket", socket);
  expect(
    renderToString(<CdpViewer cdpUrl="wss://fixture.invalid" />),
  ).toContain("Remote browser viewer");
  expect(socket).not.toHaveBeenCalled();
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
    if (status === "error" || status === "disconnected") {
      expect(
        screen.getByRole("button", { name: "Reconnect viewer" }),
      ).toHaveFocus();
      await userEvent.tab();
    }
    expect(screen.getByRole("textbox", { name: "After viewer" })).toHaveFocus();
  },
);
