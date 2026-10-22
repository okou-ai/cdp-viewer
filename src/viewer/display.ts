import { timeout } from "signal-timers";
import type { CdpClient } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import type { WindowSizeSync } from "./types";

export interface DisplaySize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface DisplayState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly constrained: boolean;
}

interface Target {
  readonly targetId: string;
  readonly sessionId: string;
  readonly current: () => boolean;
  applied?: string;
}

interface DisplayHost {
  readonly signal: AbortSignal;
  readonly windowId: number | undefined;
  readonly changed: (state: DisplayState) => void;
  readonly failed: (error: CdpFault) => void;
  readonly synchronized: () => void;
  readonly capture: () => Promise<void>;
  readonly inputScale: (scale: number, densityScale?: number) => void;
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Product policy, independently of the capture cap and native window chrome. */
function constrainDisplay(size: DisplaySize): DisplaySize & {
  constrained: boolean;
} {
  const scale = Math.min(
    1,
    4096 / size.width,
    4096 / size.height,
    4096 / (size.width * size.dpr),
    4096 / (size.height * size.dpr),
    Math.sqrt((3840 * 2160) / size.width / size.height) / size.dpr,
  );
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  if (
    width * size.dpr > 4096 ||
    height * size.dpr > 4096 ||
    width * height * size.dpr * size.dpr > 3840 * 2160
  )
    throw new CdpFault(
      "display",
      "The display density cannot fit within the supported size limits.",
    );
  return {
    width,
    height,
    dpr: size.dpr,
    constrained: scale < 1,
  };
}

/** Project CSS dimensions into the zoomed viewport and native window DIP. */
function projectDisplay(
  windowId: number,
  size: DisplaySize,
  nativeDpr: number,
  zoom: number,
) {
  const densityScale = size.dpr / nativeDpr;
  const contents = {
    windowId,
    width: Math.max(1, Math.round(size.width * densityScale)),
    height: Math.max(1, Math.round(size.height * densityScale)),
  };
  return {
    contents,
    densityScale,
    metrics: {
      width: Math.max(1, Math.round(size.width * zoom)),
      height: Math.max(1, Math.round(size.height * zoom)),
      deviceScaleFactor: size.dpr / zoom,
      scale: densityScale / zoom,
      dontSetVisibleSize: true,
      mobile: false,
    },
    // Integer native sizes prevent metric float noise from defeating deduplication.
    key: [
      windowId,
      size.width,
      size.height,
      size.dpr,
      zoom,
      contents.width,
      contents.height,
    ].join(":"),
  };
}

/** One connection, one running transaction, and one newest desired update. */
export class DisplaySync {
  private target: Target | null = null;
  private local: DisplaySize | null = null;
  private mode: WindowSizeSync = "off";
  private readonly initial = new Map<number, number>();
  private wanted = false;
  private manual = false;
  private running = false;
  private scheduled = false;
  private faulted = false;
  private constrained = false;
  private revision = 0;
  private started = -Infinity;

  constructor(
    private readonly client: CdpClient,
    private readonly host: DisplayHost,
  ) {}

  setTarget(target: Target | null): void {
    this.target = target;
    this.revision++;
    this.faulted = false;
    this.constrained = false;
    this.wanted = !!target && this.mode !== "off";
    this.manual = false;
    this.schedule();
    this.publish();
  }

  setMode(mode: WindowSizeSync): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.revision++;
    this.faulted = false;
    this.wanted = this.manual || mode !== "off";
    this.schedule();
    this.publish();
  }

  measure(size: DisplaySize | null): void {
    if (size && ![size.width, size.height, size.dpr].every(positive))
      size = null;
    const previous = this.local;
    if (
      previous?.width === size?.width &&
      previous?.height === size?.height &&
      previous?.dpr === size?.dpr
    )
      return;
    this.local = size;
    if (
      this.mode === "live" ||
      (this.mode === "initial" && (!previous || !this.target?.applied))
    )
      this.wanted = true;
    this.schedule();
    this.publish();
  }

  sync(): void {
    if (!this.local || !this.target || this.host.signal.aborted) return;
    this.faulted = false;
    this.manual = true;
    this.wanted = true;
    this.revision++;
    this.schedule();
    this.publish();
  }

  close(): void {
    this.target = null;
    this.local = null;
    this.wanted = false;
    this.manual = false;
    this.initial.clear();
    this.publish();
  }

  private current(target: Target): boolean {
    return (
      !this.host.signal.aborted && this.target === target && target.current()
    );
  }

  private publish(): void {
    this.host.changed({
      ready: !!this.local && !!this.target,
      pending: this.running || (this.scheduled && this.wanted),
      constrained: this.constrained,
    });
  }

  private schedule(): void {
    if (
      this.running ||
      this.scheduled ||
      !this.wanted ||
      !this.local ||
      !this.target ||
      this.faulted ||
      this.host.signal.aborted
    )
      return;
    this.scheduled = true;
    timeout(
      () => {
        this.scheduled = false;
        this.drain().catch(() => {
          // run() reports only fixed, owner-bound diagnostics.
          this.faulted = true;
          this.publish();
        });
      },
      Math.max(0, 150 - (performance.now() - this.started)),
      { signal: this.host.signal },
    );
  }

  private async drain(): Promise<void> {
    const target = this.target;
    if (
      !target ||
      !this.local ||
      !this.wanted ||
      this.faulted ||
      !this.current(target)
    ) {
      this.publish();
      return;
    }
    const revision = this.revision;
    const manual = this.manual;
    const mode = this.mode;
    this.wanted = false;
    this.manual = false;
    this.running = true;
    this.started = performance.now();
    this.publish();
    let emulated = false;
    try {
      const [window, remote, metrics] = await Promise.all([
        this.client.request("Browser.getWindowForTarget", {
          targetId: target.targetId,
        }),
        this.client.request(
          "Runtime.evaluate",
          {
            expression:
              "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
            returnByValue: true,
          },
          target.sessionId,
        ),
        this.client.request(
          "Page.getLayoutMetrics",
          undefined,
          target.sessionId,
        ),
      ]);
      if (!this.current(target)) return;
      if (revision !== this.revision) {
        if (manual) this.manual = this.wanted = true;
        return;
      }
      const local = this.local;
      if (!local) return;
      this.assertWindow(window);
      const value: unknown = remote.result.value;
      if (
        remote.exceptionDetails ||
        !isRecord(value) ||
        !positive(value.width) ||
        !positive(value.height) ||
        !positive(value.dpr)
      )
        throw new CdpFault(
          "display",
          "The page display metrics are unavailable.",
        );
      const zoom = metrics.cssVisualViewport.zoom ?? 1;
      const nativeDpr =
        metrics.visualViewport.clientWidth /
        metrics.cssVisualViewport.clientWidth /
        zoom;
      if (!positive(zoom) || !positive(nativeDpr))
        throw new CdpFault(
          "display",
          "The browser display scale is unavailable.",
        );
      const remembered = this.initial.get(window.windowId);
      const restore = mode === "initial" && !manual && remembered !== undefined;
      let size = constrainDisplay(
        restore
          ? {
              width: (value.width * value.dpr) / remembered,
              height: (value.height * value.dpr) / remembered,
              dpr: remembered,
            }
          : local,
      );
      let projected = projectDisplay(window.windowId, size, nativeDpr, zoom);
      if (!manual && target.applied === projected.key) return;
      await this.host.capture();
      if (!this.current(target)) return;
      if (revision !== this.revision) {
        if (manual) this.manual = this.wanted = true;
        return;
      }
      if (!this.local) return;
      if (!restore) size = constrainDisplay(this.local);
      projected = projectDisplay(window.windowId, size, nativeDpr, zoom);
      // Consume measurements coalesced during guards/capture; later changes stay pending.
      this.wanted = false;
      await this.client.request(
        "Emulation.setDeviceMetricsOverride",
        projected.metrics,
        target.sessionId,
      );
      emulated = true;
      if (!this.current(target)) return;
      this.host.inputScale(projected.metrics.scale, projected.densityScale);
      const confirmed = await this.client.request(
        "Browser.getWindowForTarget",
        {
          targetId: target.targetId,
        },
      );
      if (!this.current(target)) return;
      this.assertWindow(confirmed);
      if (confirmed.windowId !== window.windowId)
        throw new CdpFault(
          "scope",
          "The page moved during display synchronization.",
        );
      await this.client.request("Browser.setContentsSize", projected.contents);
      if (!this.current(target)) return;
      target.applied = projected.key;
      this.constrained = size.constrained;
      this.host.synchronized();
      if (mode === "initial" || this.initial.has(window.windowId))
        this.initial.set(window.windowId, size.dpr);
    } catch (error) {
      if (this.current(target)) {
        let restored = true;
        if (emulated) {
          restored = await this.client
            .request(
              "Emulation.clearDeviceMetricsOverride",
              undefined,
              target.sessionId,
            )
            .then(
              () => true,
              () => false,
            );
          if (!this.current(target)) return;
          if (restored) {
            // Recalibrate native zoom on the next input after emulation is retired.
            this.host.inputScale(1);
            delete target.applied;
            this.constrained = false;
          }
        }
        this.faulted = true;
        this.host.failed(
          !restored
            ? new CdpFault(
                "display",
                "The browser display could not be synchronized or restored.",
              )
            : error instanceof CdpFault &&
                ["scope", "display"].includes(error.kind)
              ? error
              : new CdpFault(
                  error instanceof CdpFault && error.code === -32601
                    ? "unsupported-capability"
                    : "display",
                  "The browser display could not be synchronized. Check window support and try again.",
                ),
        );
      }
    } finally {
      this.running = false;
      this.schedule();
      this.publish();
    }
  }

  private assertWindow(window: {
    windowId: number;
    bounds: { windowState?: string };
  }): void {
    if (
      !Number.isSafeInteger(window.windowId) ||
      (this.host.windowId !== undefined &&
        window.windowId !== this.host.windowId)
    )
      throw new CdpFault("scope", "The page is outside this viewer's window.");
    if (window.bounds.windowState && window.bounds.windowState !== "normal")
      throw new CdpFault(
        "display",
        "Restore the browser window before synchronizing its display.",
      );
  }
}
