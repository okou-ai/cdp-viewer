import type { Protocol } from "devtools-protocol";
import type { CdpClient } from "../cdp/client";
import { CdpFault, isRecord, requestDetails } from "../cdp/errors";
import { releaseRuntimeObjects } from "../cdp/runtime-objects";
import {
  constrainDisplay,
  nativePresentation,
  positive,
  projectDisplay,
} from "./geometry";
import type { DisplaySize } from "./geometry";
import type { DisplayDecision, DisplayOutcome, DisplayStage } from "./policy";
import type { DisplayViewport } from "./viewport";
import { frameTimeoutMs } from "./limits";

export interface DisplayTarget {
  readonly targetId: string;
  readonly sessionId: string;
  readonly current: () => boolean;
  readonly geometry: DisplayViewport;
}

export interface DisplayEffects {
  readonly signal: AbortSignal;
  readonly presentationTimeout?: number | undefined;
  readonly windowId: number | undefined;
  readonly capture: () => Promise<void>;
  readonly refresh: (prepare: () => Promise<void>) => Promise<void>;
}

interface ExecutionPolicy {
  readonly decide: (windowId: number) => DisplayDecision | null;
  readonly prepared: () => boolean;
  readonly stage: (
    stage: Exclude<DisplayStage, "preparing" | "prepared">,
  ) => boolean;
}

export type DisplayResult =
  | Extract<DisplayOutcome, { readonly kind: "completed" }>
  | { readonly kind: "deferred" | "retired" }
  | { readonly kind: "failed"; readonly error: CdpFault };

type Mutation =
  | { readonly kind: "none" | "applied" }
  | { readonly kind: "pending"; readonly rejected: () => void };

function projection(
  windowId: number,
  decision: DisplayDecision,
  remote: DisplaySize,
  layout: Protocol.Page.GetLayoutMetricsResponse,
) {
  const size = constrainDisplay(
    decision.kind === "fit"
      ? decision.size
      : {
          width: (remote.width * remote.dpr) / decision.dpr,
          height: (remote.height * remote.dpr) / decision.dpr,
          dpr: decision.dpr,
        },
  );
  return { size, projected: projectDisplay(windowId, size, layout) };
}

/** One selected lifetime's native effects and applied receipt, never window policy. */
export class DisplayTransaction {
  private applied: string | undefined;

  constructor(
    private readonly client: CdpClient,
    private readonly target: DisplayTarget,
    private readonly host: DisplayEffects,
    private readonly ownsTarget: () => boolean,
  ) {}

  private current(): boolean {
    return (
      !this.host.signal.aborted && this.ownsTarget() && this.target.current()
    );
  }

  private decision(
    policy: ExecutionPolicy,
    revision: number,
    windowId: number,
  ): DisplayDecision | null {
    return this.current() && revision === this.target.geometry.revision
      ? policy.decide(windowId)
      : null;
  }

  async execute(policy: ExecutionPolicy): Promise<DisplayResult> {
    const { target, client, host } = this;
    const revision = target.geometry.revision;
    let mutation: Mutation = { kind: "none" };
    try {
      const [window, remote, layout] = await Promise.all([
        client.request("Browser.getWindowForTarget", {
          targetId: target.targetId,
        }),
        this.evaluate(
          "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
        ),
        client.request("Page.getLayoutMetrics", undefined, target.sessionId),
      ]);
      let decision = this.decision(policy, revision, window.windowId);
      if (!decision) return { kind: this.current() ? "deferred" : "retired" };
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
      const remoteSize = {
        width: value.width,
        height: value.height,
        dpr: value.dpr,
      };
      const existing = projection(
        window.windowId,
        decision,
        remoteSize,
        layout,
      );
      if (
        this.applied === existing.projected.key &&
        target.geometry.matches(
          existing.projected.presentation,
          existing.projected.input,
        )
      ) {
        if (!policy.prepared())
          return { kind: this.current() ? "deferred" : "retired" };
        return this.completed(window.windowId, existing, "reused");
      }

      await host.capture();
      decision = this.decision(policy, revision, window.windowId);
      if (!decision) return { kind: this.current() ? "deferred" : "retired" };
      // Choose the latest local observation once. Later changes are separate work;
      // no dispatched payload can change while awaiting native acknowledgements.
      const prepared = projection(
        window.windowId,
        decision,
        remoteSize,
        layout,
      );
      const { projected, size } = prepared;
      if (!policy.prepared())
        return { kind: this.current() ? "deferred" : "retired" };
      const freshCapture = target.geometry.needsCaptureFence(
        layout,
        projected.presentation,
      );
      const rejected = target.geometry.beginWrite();
      if (!policy.stage("writing")) {
        rejected();
        return { kind: this.current() ? "deferred" : "retired" };
      }
      if (!this.current()) {
        rejected();
        return { kind: "retired" };
      }
      mutation = { kind: "pending", rejected };
      await client.request(
        "Emulation.setDeviceMetricsOverride",
        projected.metrics,
        target.sessionId,
      );
      mutation = { kind: "applied" };
      if (!this.current()) return { kind: "retired" };
      const confirmed = await client.request("Browser.getWindowForTarget", {
        targetId: target.targetId,
      });
      if (!this.current()) return { kind: "retired" };
      this.assertWindow(confirmed);
      if (confirmed.windowId !== window.windowId)
        throw new CdpFault(
          "scope",
          "The page moved during display synchronization.",
        );
      if (decision.kind === "fit" || size.constrained)
        await client.request("Browser.setContentsSize", projected.contents);
      if (!this.current()) return { kind: "retired" };
      target.geometry.apply(
        projected.input,
        projected.presentation,
        freshCapture,
      );
      policy.stage("presenting");
      if (freshCapture) await this.fenceCapture();
      if (!this.current()) return { kind: "retired" };
      const started = performance.now();
      const budget = host.presentationTimeout ?? frameTimeoutMs;
      const presentation = await target.geometry.waitForPresentation(
        host.signal,
        budget,
        !freshCapture,
      );
      // Compatible pixels can paint after the mismatch wakes this continuation.
      if (
        presentation === "inconsistent" &&
        !target.geometry.matches(projected.presentation, projected.input)
      ) {
        if (!this.current()) return { kind: "retired" };
        // A clipped static image may be the stream's last frame. Refresh once
        // on evidence, retiring queued decodes before stopping that stream.
        target.geometry.fence(Infinity);
        await this.fenceCapture();
        if (!this.current()) return { kind: "retired" };
        await target.geometry.waitForPresentation(
          host.signal,
          budget - (performance.now() - started),
        );
      }
      if (!this.current()) return { kind: "retired" };
      return this.completed(window.windowId, prepared, "painted");
    } catch (error) {
      if (!this.current()) return { kind: "retired" };
      const uncertain =
        mutation.kind === "pending" &&
        !(error instanceof CdpFault && error.code !== undefined);
      if (mutation.kind === "pending" && !uncertain) mutation.rejected();
      let restored = true;
      if (mutation.kind === "applied" || uncertain) {
        target.geometry.uncertain();
        this.applied = undefined;
        policy.stage("recovering");
        restored = await this.restore();
        if (!this.current()) return { kind: "retired" };
      }
      return {
        kind: "failed",
        error: !restored
          ? new CdpFault(
              "display",
              "Display recovery could not be confirmed. Try synchronizing again.",
              undefined,
              requestDetails(error),
            )
          : error instanceof CdpFault &&
              ["scope", "display"].includes(error.kind)
            ? error
            : new CdpFault(
                error instanceof CdpFault && error.code === -32601
                  ? "unsupported-capability"
                  : "display",
                "The browser display could not be synchronized. Check window support and try again.",
                undefined,
                requestDetails(error),
              ),
      };
    }
  }

  private completed(
    windowId: number,
    prepared: ReturnType<typeof projection>,
    proof: "reused" | "painted",
  ): Extract<DisplayOutcome, { readonly kind: "completed" }> {
    this.applied = prepared.projected.key;
    return {
      kind: "completed",
      proof,
      windowId,
      dpr: prepared.size.dpr,
    };
  }

  private async restore(): Promise<boolean> {
    const { client, target, host } = this;
    if (!this.current()) return false;
    const cleared = await client
      .request(
        "Emulation.clearDeviceMetricsOverride",
        undefined,
        target.sessionId,
      )
      .then(
        () => true,
        () => false,
      );
    if (!cleared || !this.current()) return false;
    try {
      const layout = await client.request(
        "Page.getLayoutMetrics",
        undefined,
        target.sessionId,
      );
      if (!this.current()) return false;
      target.geometry.apply(null, nativePresentation(layout), true);
      await this.fenceCapture();
      if (!this.current()) return false;
      await target.geometry.waitForPresentation(
        host.signal,
        host.presentationTimeout,
      );
      return this.current();
    } catch {
      if (this.current()) target.geometry.uncertain();
      return false;
    }
  }

  private async evaluate(expression: string, contextId?: number) {
    const { client, target } = this;
    const release = (result: unknown) =>
      releaseRuntimeObjects(client, target.sessionId, result);
    const result = await client.request(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        ...(contextId === undefined ? {} : { contextId }),
      },
      target.sessionId,
      release,
    );
    release(result);
    return result;
  }

  private async fenceCapture(): Promise<void> {
    const { client, target } = this;
    if (!this.current()) return;
    await this.host.refresh(async () => {
      const tree = await client.request(
        "Page.getFrameTree",
        undefined,
        target.sessionId,
      );
      if (!this.current()) return;
      const world = await client.request(
        "Page.createIsolatedWorld",
        { frameId: tree.frameTree.frame.id, worldName: "cdp-viewer-display" },
        target.sessionId,
      );
      if (!this.current()) return;
      const clock = await this.evaluate("Date.now()", world.executionContextId);
      if (!this.current()) return;
      const value: unknown = clock.result.value;
      if (clock.exceptionDetails || !positive(value))
        throw new CdpFault(
          "display",
          "A fresh browser image could not be confirmed. Try synchronizing again.",
        );
      // Native millisecond precision requires the next millisecond, not local time.
      target.geometry.fence((value + 1) / 1000);
    });
  }

  private assertWindow(
    window: Protocol.Browser.GetWindowForTargetResponse,
  ): void {
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
