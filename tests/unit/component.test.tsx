import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, state } from "ccstate";
import { StoreProvider, useGet } from "ccstate-react";
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
  const ids = screen.getAllByRole("combobox").map((element) => element.id);
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
  await userEvent.click(
    screen.getByRole("button", { name: "Reconnect viewer" }),
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
  await userEvent.click(
    screen.getAllByRole("button", { name: "Reconnect viewer" })[0]!,
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
    expect(screen.getByRole("textbox", { name: "After viewer" })).toHaveFocus();
  },
);
