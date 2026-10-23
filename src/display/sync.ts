import { timeout } from "signal-timers";
import type { CdpClient } from "../cdp/client";
import { CdpFault, requestDetails } from "../cdp/errors";
import type { WindowSizeSync } from "../viewer/types";
import type { DisplaySize } from "./geometry";
import {
  activeDisplayIntent,
  canBeginDisplay,
  createDisplayPolicy,
  decideDisplay,
  transitionDisplay,
} from "./policy";
import type { DisplayEvent } from "./policy";
import { DisplayTransaction } from "./transaction";
import type { DisplayEffects, DisplayTarget } from "./transaction";

const minimumSyncIntervalMs = 150;

export interface DisplayState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly pointerBlocked: boolean;
}

interface DisplayHost extends DisplayEffects {
  readonly changed: (state: DisplayState) => void;
  readonly failed: (error: CdpFault) => void;
  readonly synchronized: () => void;
}

/** Connection-owned bridge: pure policy, one selected executor and bounded scheduling. */
export class DisplaySync {
  private policy = createDisplayPolicy();
  private target: DisplayTarget | null = null;
  private transaction: DisplayTransaction | null = null;
  private scheduled = false;
  private started = -Infinity;

  constructor(
    private readonly client: CdpClient,
    private readonly host: DisplayHost,
  ) {}

  setTarget(target: DisplayTarget | null): void {
    this.target?.geometry.cancelPresentation();
    this.target = target;
    this.transaction = target
      ? new DisplayTransaction(
          this.client,
          target,
          this.host,
          () => this.target === target,
        )
      : null;
    this.dispatch({ type: "select", owner: target });
  }

  setMode(mode: WindowSizeSync): void {
    this.dispatch({ type: "mode", mode });
  }

  measure(size: DisplaySize | null): void {
    this.dispatch({ type: "measure", size });
  }

  sync(): void {
    if (!this.host.signal.aborted) this.dispatch({ type: "manual" });
  }

  close(): void {
    this.target?.geometry.cancelPresentation();
    this.target = null;
    this.transaction = null;
    this.dispatch({ type: "close" });
  }

  private dispatch(event: DisplayEvent): boolean {
    const next = transitionDisplay(this.policy, event);
    if (next === this.policy) return false;
    this.policy = next;
    this.schedule();
    this.publish();
    return true;
  }

  private publish(): void {
    this.host.changed({
      ready: !!this.policy.local && !!this.target,
      pending:
        !!activeDisplayIntent(this.policy) ||
        (this.scheduled && !!this.policy.pending),
      pointerBlocked: !!this.target && !this.target.geometry.available,
    });
  }

  private schedule(): void {
    if (
      this.scheduled ||
      !canBeginDisplay(this.policy) ||
      !this.target?.current() ||
      this.host.signal.aborted
    )
      return;
    this.scheduled = true;
    timeout(
      () => {
        this.scheduled = false;
        this.drain().catch((error: unknown) => {
          const intent = activeDisplayIntent(this.policy);
          if (!intent) return;
          this.dispatch({
            type: "finished",
            intent,
            outcome: { kind: "failed" },
          });
          if (this.target === intent.owner && !this.host.signal.aborted)
            this.host.failed(
              new CdpFault(
                "display",
                "The browser display could not be synchronized. Try again.",
                undefined,
                requestDetails(error),
              ),
            );
        });
      },
      Math.max(0, minimumSyncIntervalMs - (performance.now() - this.started)),
      { signal: this.host.signal },
    );
  }

  private async drain(): Promise<void> {
    const target = this.target;
    const transaction = this.transaction;
    if (
      !canBeginDisplay(this.policy) ||
      !target ||
      !transaction ||
      !target.current() ||
      this.host.signal.aborted
    ) {
      this.publish();
      return;
    }
    this.policy = transitionDisplay(this.policy, { type: "begin" });
    const intent = activeDisplayIntent(this.policy);
    if (!intent) {
      this.publish();
      return;
    }
    this.started = performance.now();
    this.publish();
    try {
      const result = await transaction.execute({
        decide: (windowId) => decideDisplay(this.policy, intent, windowId),
        prepared: () => this.dispatch({ type: "prepared", intent }),
        stage: (stage) => this.dispatch({ type: "stage", intent, stage }),
      });
      const current =
        this.target === target && target.current() && !this.host.signal.aborted;
      const previous = this.policy;
      this.policy = transitionDisplay(previous, {
        type: "finished",
        intent,
        outcome: result,
      });
      if (current && previous !== this.policy) {
        if (result.kind === "completed") this.host.synchronized();
        else if (result.kind === "failed") this.host.failed(result.error);
      }
    } finally {
      this.schedule();
      this.publish();
    }
  }
}
