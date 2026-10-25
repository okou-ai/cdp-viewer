import { render, screen, waitFor } from "@testing-library/react";
import { Component } from "react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CdpViewer } from "../../src/index";
import { FakeBrowser } from "./wire";

const restore: (() => void)[] = [];
function removeMember(target: object, name: string) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  restore.push(() => {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  });
  Object.defineProperty(target, name, { configurable: true, value: undefined });
}

afterEach(() => {
  while (restore.length) restore.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class HostBoundary extends Component<
  { children: ReactNode; failed: (error: Error) => void },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    this.props.failed(error);
  }
  override render() {
    return this.state.error ? (
      <output role="alert">{this.state.error.message}</output>
    ) : (
      this.props.children
    );
  }
}

function supportedBrowser() {
  const browser = new FakeBrowser();
  vi.stubGlobal("WebSocket", function () {
    return browser.factory("wss://fixture.invalid");
  });
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => ({
    ...(JSON.parse(await blob.text()) as { width: number; height: number }),
    close: vi.fn(),
  }));
  const drawing = { clearRect: vi.fn(), drawImage: vi.fn() };
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(drawing as unknown as CanvasRenderingContext2D);
  return { browser, context, drawing };
}

const capabilities = [
  {
    name: "AbortSignal.any",
    remove: () => removeMember(AbortSignal, "any"),
  },
  {
    name: "Uint8Array.fromBase64",
    remove: () => removeMember(Uint8Array, "fromBase64"),
  },
  {
    name: "createImageBitmap",
    remove: () => vi.stubGlobal("createImageBitmap", undefined),
  },
  {
    name: "ResizeObserver",
    remove: () => vi.stubGlobal("ResizeObserver", undefined),
  },
  {
    name: "IntersectionObserver",
    remove: () => vi.stubGlobal("IntersectionObserver", undefined),
  },
  {
    name: "window.matchMedia",
    remove: () => vi.stubGlobal("matchMedia", undefined),
  },
];

it.each(capabilities)(
  "rejects missing $name before acquiring resources even for paused view-only viewers",
  ({ name, remove }) => {
    const { browser, context } = supportedBrowser();
    remove();
    const failed = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <HostBoundary failed={failed}>
        <CdpViewer cdpUrl="wss://fixture.invalid" paused />
      </HostBoundary>,
    );
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0]).toBeInstanceOf(TypeError);
    expect(failed.mock.calls[0]![0]).toMatchObject({
      message: `cdp-viewer requires ${name}.`,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(name);
    expect(browser.sockets).toHaveLength(0);
    expect(context).not.toHaveBeenCalled();
  },
);

it("streams with the required APIs and revalidates a fresh instance after cleanup", async () => {
  const { browser, drawing } = supportedBrowser();
  const view = render(<CdpViewer cdpUrl="wss://fixture.invalid" />);
  await waitFor(() =>
    expect(view.container.querySelector(".cdpv-root")).toHaveAttribute(
      "data-status",
      "streaming",
    ),
  );
  expect(drawing.drawImage).toHaveBeenCalled();
  view.unmount();
  expect(browser.sockets.every((socket) => socket.readyState === 3)).toBe(true);
  const before = browser.sockets.length;
  removeMember(Uint8Array, "fromBase64");
  const failed = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <HostBoundary failed={failed}>
      <CdpViewer cdpUrl="wss://fixture.invalid" />
    </HostBoundary>,
  );
  expect(failed).toHaveBeenCalledWith(expect.any(TypeError));
  expect(browser.sockets).toHaveLength(before);
});

it("renders on the server without requiring the client APIs or acquiring resources", () => {
  const { browser, context } = supportedBrowser();
  for (const capability of capabilities) capability.remove();
  expect(
    renderToString(<CdpViewer cdpUrl="wss://fixture.invalid" />),
  ).toContain("Remote browser viewer");
  expect(browser.sockets).toHaveLength(0);
  expect(context).not.toHaveBeenCalled();
});
