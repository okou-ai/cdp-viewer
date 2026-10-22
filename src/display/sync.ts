import { timeout } from "signal-timers";
import type { CdpClient } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import { releaseRuntimeObjects } from "../cdp/runtime-objects";
import type { WindowSizeSync } from "../viewer/types";
import { constrainDisplay, positive, projectDisplay } from "./geometry";
import type { DisplaySize } from "./geometry";
import type { DisplayViewport } from "./viewport";

export interface DisplayState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly constrained: boolean;
  readonly pointerBlocked: boolean;
}

interface Target {
  readonly targetId: string;
  readonly sessionId: string;
  readonly current: () => boolean;
  readonly geometry: DisplayViewport;
  applied?: string;
}

interface DisplayHost {
  readonly signal: AbortSignal;
  readonly windowId: number | undefined;
  readonly changed: (state: DisplayState) => void;
  readonly failed: (error: CdpFault) => void;
  readonly synchronized: () => void;
  readonly capture: () => Promise<void>;
}

type Request = { readonly source: "manual" | "automatic" };
type Operation =
  | { readonly kind: "fit" }
  | { readonly kind: "restore-density"; readonly size: DisplaySize };
type Phase = "idle" | "scheduled" | "applying" | "failed";

/** One connection's policy, explicit pending request and bounded execution phase. */
export class DisplaySync {
  private target: Target | null = null;
  private local: DisplaySize | null = null;
  private mode: WindowSizeSync = "off";
  private readonly initial = new Map<number, number>();
  private request: Request | null = null;
  private phase: Phase = "idle";
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
    if (this.phase === "failed") this.phase = "idle";
    this.constrained = false;
    this.request =
      target && this.mode !== "off" ? { source: "automatic" } : null;
    this.schedule();
    this.publish();
  }

  setMode(mode: WindowSizeSync): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.revision++;
    if (this.phase === "failed") this.phase = "idle";
    if (this.request?.source !== "manual")
      this.request = mode !== "off" ? { source: "automatic" } : null;
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
      this.request ??= { source: "automatic" };
    this.schedule();
    this.publish();
  }

  sync(): void {
    if (!this.local || !this.target || this.host.signal.aborted) return;
    if (this.phase === "failed") this.phase = "idle";
    this.request = { source: "manual" };
    this.revision++;
    this.schedule();
    this.publish();
  }

  close(): void {
    this.target = null;
    this.local = null;
    this.request = null;
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
      pending:
        this.phase === "applying" ||
        (this.phase === "scheduled" && this.request !== null),
      constrained: this.constrained,
      pointerBlocked: !!this.target && !this.target.geometry.available,
    });
  }

  private schedule(): void {
    if (
      this.phase !== "idle" ||
      !this.request ||
      !this.local ||
      !this.target ||
      this.host.signal.aborted
    )
      return;
    this.phase = "scheduled";
    timeout(
      () => {
        this.phase = "idle";
        this.drain().catch(() => {
          // run() reports only fixed, owner-bound diagnostics.
          this.phase = "failed";
          this.publish();
        });
      },
      Math.max(0, 150 - (performance.now() - this.started)),
      { signal: this.host.signal },
    );
  }

  private async readPageSize(sessionId: string) {
    const release = (result: unknown) =>
      releaseRuntimeObjects(this.client, sessionId, result);
    const result = await this.client.request(
      "Runtime.evaluate",
      {
        expression:
          "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
        returnByValue: true,
      },
      sessionId,
      release,
    );
    // Exceptional by-value reads can still allocate result/exception handles.
    release(result);
    return result;
  }

  /** Revalidate intent after a read boundary without consuming a hidden surface's request. */
  private currentSize(
    target: Target,
    revision: number,
    request: Request,
  ): DisplaySize | null {
    if (!this.current(target)) return null;
    if (revision !== this.revision) {
      if (request.source === "manual") this.request = request;
      return null;
    }
    if (!this.local) this.request ??= request;
    return this.local;
  }

  private async drain(): Promise<void> {
    const target = this.target;
    const request = this.request;
    if (!target || !this.local || !request || !this.current(target)) {
      this.publish();
      return;
    }
    const revision = this.revision;
    const mode = this.mode;
    this.request = null;
    this.phase = "applying";
    this.started = performance.now();
    this.publish();
    let override: "none" | "pending" | "applied" = "none";
    let rejectWrite: (() => void) | undefined;
    try {
      const [window, remote, metrics] = await Promise.all([
        this.client.request("Browser.getWindowForTarget", {
          targetId: target.targetId,
        }),
        this.readPageSize(target.sessionId),
        this.client.request(
          "Page.getLayoutMetrics",
          undefined,
          target.sessionId,
        ),
      ]);
      let local = this.currentSize(target, revision, request);
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
      const remembered = this.initial.get(window.windowId);
      const operation: Operation =
        mode === "initial" &&
        request.source !== "manual" &&
        remembered !== undefined
          ? {
              kind: "restore-density",
              size: {
                width: (value.width * value.dpr) / remembered,
                height: (value.height * value.dpr) / remembered,
                dpr: remembered,
              },
            }
          : { kind: "fit" };
      let size = constrainDisplay(
        operation.kind === "fit" ? local : operation.size,
      );
      let projected = projectDisplay(window.windowId, size, metrics);
      if (request.source !== "manual" && target.applied === projected.key)
        return;
      await this.host.capture();
      local = this.currentSize(target, revision, request);
      if (!local) return;
      if (operation.kind === "fit") size = constrainDisplay(local);
      projected = projectDisplay(window.windowId, size, metrics);
      // Consume measurements coalesced during guards; later changes stay pending.
      this.request = null;
      rejectWrite = target.geometry.beginWrite();
      this.publish();
      override = "pending";
      await this.client.request(
        "Emulation.setDeviceMetricsOverride",
        projected.metrics,
        target.sessionId,
      );
      override = "applied";
      if (!this.current(target)) return;
      target.geometry.apply(projected.input);
      this.publish();
      const confirmed = await this.client.request(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      if (!this.current(target)) return;
      this.assertWindow(confirmed);
      if (confirmed.windowId !== window.windowId)
        throw new CdpFault(
          "scope",
          "The page moved during display synchronization.",
        );
      if (operation.kind === "fit" || size.constrained)
        await this.client.request(
          "Browser.setContentsSize",
          projected.contents,
        );
      if (!this.current(target)) return;
      target.applied = projected.key;
      this.constrained = size.constrained;
      this.host.synchronized();
      if (mode === "initial" || this.initial.has(window.windowId))
        this.initial.set(window.windowId, size.dpr);
    } catch (error) {
      if (this.current(target)) {
        let restored = true;
        const uncertain =
          override === "pending" &&
          !(error instanceof CdpFault && error.code !== undefined);
        if (override === "pending" && !uncertain) rejectWrite?.();
        if (override === "applied" || uncertain) {
          target.geometry.uncertain();
          delete target.applied;
          this.constrained = false;
          this.publish();
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
            target.geometry.apply(null);
          }
        }
        // A later explicit policy/manual request survives this older failure.
        // Measurements alone do not reopen a failed transaction.
        this.phase = revision === this.revision ? "failed" : "idle";
        this.host.failed(
          !restored
            ? new CdpFault(
                "display",
                "Display recovery could not be confirmed. Try synchronizing again.",
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
      if (this.phase === "applying") this.phase = "idle";
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
