import type { Protocol } from "devtools-protocol";
import type { CdpClient } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import { releaseRuntimeObjects } from "../cdp/runtime-objects";
import { nativeWindowGeometry, positive } from "./geometry";
import type { DisplaySize, NativeWindowGeometry } from "./geometry";
import type { DisplayViewport } from "./viewport";

export interface DisplayTarget {
  readonly targetId: string;
  readonly sessionId: string;
  readonly current: () => boolean;
  readonly geometry: DisplayViewport;
}

export interface DisplaySnapshot {
  readonly window: Protocol.Browser.GetWindowForTargetResponse;
  readonly native: NativeWindowGeometry;
  readonly remote: DisplaySize;
  readonly layout: Protocol.Page.GetLayoutMetricsResponse;
  readonly current: () => boolean;
}

type NativeWindow =
  | { readonly kind: "initial" }
  | {
      readonly kind: "rebinding";
      readonly windowId: number;
      readonly refreshed: boolean;
    }
  | {
      readonly kind: "bound";
      readonly windowId: number;
      readonly geometry: NativeWindowGeometry;
    };

/** Selected-owner acquisition; verified calibration outlives a preparation. */
export class DisplayPreparation {
  private reference: NativeWindow = { kind: "initial" };

  constructor(
    private readonly client: CdpClient,
    private readonly target: DisplayTarget,
    private readonly windowId: number | undefined,
    private readonly current: () => boolean,
    private readonly refreshNative: () => Promise<void>,
  ) {}

  async acquire(
    signal: AbortSignal,
    budget: number | undefined,
  ): Promise<DisplaySnapshot | null> {
    const { target } = this;
    const reference = this.reference;
    if (reference.kind === "rebinding" && !reference.refreshed) {
      await this.refreshNative();
      if (!this.current()) return null;
      this.reference = { ...reference, refreshed: true };
    }
    if (this.reference.kind !== "bound") {
      try {
        await target.geometry.waitForNativeFrame(signal, budget);
      } catch (error) {
        if (this.current() && this.reference.kind === "rebinding")
          this.reference = { ...this.reference, refreshed: false };
        throw error;
      }
    }
    if (!this.current()) return null;
    const revision = target.geometry.revision;
    const observation = target.geometry.nativeObservation;
    const current = () =>
      this.current() &&
      revision === target.geometry.revision &&
      observation === target.geometry.nativeObservation;
    const [native, metrics, layout] = await Promise.all([
      this.readWindow().then((window) => {
        if (!current()) return null;
        this.assertWindow(window);
        if (
          this.reference.kind !== "initial" &&
          this.reference.windowId !== window.windowId
        ) {
          // Metadata has no window ID. Retire the association before obtaining
          // a causal native frame for this observed destination on reprepare.
          this.reference = {
            kind: "rebinding",
            windowId: window.windowId,
            refreshed: false,
          };
          return null;
        }
        if (this.reference.kind !== "bound") {
          const device = target.geometry.decodedNative(observation);
          if (!device) return null;
          this.reference = {
            kind: "bound",
            windowId: window.windowId,
            geometry: nativeWindowGeometry(device, window.bounds),
          };
        }
        return { window, geometry: this.reference.geometry };
      }),
      this.readMetrics(),
      this.client.request("Page.getLayoutMetrics", undefined, target.sessionId),
    ]);
    if (!native || !current()) return null;
    const value: unknown = metrics.result.value;
    if (
      metrics.exceptionDetails ||
      !isRecord(value) ||
      !positive(value.width) ||
      !positive(value.height) ||
      !positive(value.dpr)
    )
      throw new CdpFault(
        "display",
        "The page display metrics are unavailable.",
      );
    return {
      window: native.window,
      native: native.geometry,
      remote: { width: value.width, height: value.height, dpr: value.dpr },
      layout,
      current,
    };
  }

  async confirm(
    windowId: number,
  ): Promise<Protocol.Browser.GetWindowForTargetResponse> {
    const window = await this.readWindow();
    if (this.current()) {
      this.assertWindow(window);
      if (window.windowId !== windowId)
        throw new CdpFault(
          "scope",
          "The page moved during display synchronization.",
        );
    }
    return window;
  }

  private readWindow() {
    return this.client.request("Browser.getWindowForTarget", {
      targetId: this.target.targetId,
    });
  }

  private async readMetrics() {
    const { client, target } = this;
    const release = (result: unknown) =>
      releaseRuntimeObjects(client, target.sessionId, result);
    const remote = await client.request(
      "Runtime.evaluate",
      {
        expression:
          "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
        returnByValue: true,
      },
      target.sessionId,
      release,
    );
    release(remote);
    return remote;
  }

  private assertWindow(
    window: Protocol.Browser.GetWindowForTargetResponse,
  ): void {
    if (
      !Number.isSafeInteger(window.windowId) ||
      (this.windowId !== undefined && window.windowId !== this.windowId)
    )
      throw new CdpFault("scope", "The page is outside this viewer's window.");
    if (window.bounds.windowState && window.bounds.windowState !== "normal")
      throw new CdpFault(
        "display",
        "Restore the browser window before synchronizing its display.",
      );
  }
}
