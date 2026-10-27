import { interval, timeout } from "signal-timers";
import { CdpFault, isRecord } from "../cdp/errors";
import { pageTarget } from "../cdp/targets";
import type { TargetDirectory } from "../cdp/targets";
import type { CdpEvent } from "../cdp/client";
import type { ViewerModel } from "./model";
import type { ViewerTarget } from "./types";
import {
  currentObservation,
  currentRound,
  inventoryExpiry,
} from "./target-inventory";
import type {
  InventoryEvent,
  InventoryRound,
  TargetObservation,
} from "./target-inventory";

const selectedIntervalMs = 2_000;
const selectedFreshnessMs = 12_000;
const inventoryIntervalMs = 10_000;
const inventoryRoundMs = 10_000;

interface Scan {
  readonly round: InventoryRound;
  readonly deadline: AbortController;
}

interface Selected {
  readonly targetId: string;
  deadline: AbortController;
  verifiedAt: number;
  pending: boolean;
}

interface DiscoveryOptions {
  readonly signal: AbortSignal;
  readonly scoped: boolean;
  readonly changed: () => void;
  readonly failed: (error: unknown) => void;
}

/** Connection-owned IO; the model alone owns target facts and their projection. */
export class TargetDiscovery {
  private readonly dirty = new Set<string>();
  private scan: Scan | null = null;
  private inventoryDeadline: AbortController | null = null;
  private selected: Selected | null = null;
  private fullWanted = false;
  private running = false;
  private closed = false;
  private epoch: number | null = null;

  constructor(
    private readonly directory: TargetDirectory,
    private readonly model: ViewerModel,
    private readonly options: DiscoveryOptions,
  ) {}

  private state() {
    return this.model.read(this.model.inventoryState$);
  }

  start(): void {
    this.epoch = this.model.inventory({ type: "reset" }).epoch;
    if (this.options.scoped) {
      interval(() => this.reconcile(), inventoryIntervalMs, {
        signal: this.options.signal,
      });
      interval(() => this.checkSelected(), selectedIntervalMs, {
        signal: this.options.signal,
      });
    }
    this.reconcile();
  }

  watch(targetId: string | null): void {
    this.selected?.deadline.abort();
    this.selected = null;
    if (targetId && this.options.scoped) {
      const selected: Selected = {
        targetId,
        pending: false,
        deadline: new AbortController(),
        verifiedAt: performance.now(),
      };
      this.selected = selected;
      this.expireSelected(selected);
    }
  }

  current(targetId: string): boolean {
    return (
      this.active() &&
      (!this.options.scoped ||
        (this.selected?.targetId === targetId &&
          performance.now() - this.selected.verifiedAt < selectedFreshnessMs))
    );
  }

  refresh(): void {
    if (!this.active()) return;
    this.model.inventory({ type: "invalidate-round" });
    this.scan?.deadline.abort();
    this.reconcile();
  }

  removed(targetId: string): void {
    if (!this.active()) return;
    this.scan?.deadline.abort();
    this.dirty.delete(targetId);
    this.commit({ type: "closed", id: targetId });
    this.reconcile();
  }

  beginCreation(targetId: string): TargetObservation {
    if (!this.active())
      throw new CdpFault("tab", "The tab action is no longer current.");
    const startedAt = performance.now();
    const state = this.model.inventory({
      type: "begin-creation",
      id: targetId,
      now: startedAt,
    });
    return {
      id: targetId,
      epoch: state.epoch,
      generation: state.entries.get(targetId)!.generation,
      order: state.sequence,
      startedAt,
    };
  }

  created(target: ViewerTarget, observation: TargetObservation): boolean {
    if (!this.active()) return false;
    this.dirty.delete(target.id);
    this.commit({ type: "created", target, observation });
    if (this.scan && !currentRound(this.state(), this.scan.round)) {
      this.scan.deadline.abort();
      if (this.running) this.fullWanted = true;
    }
    return this.model
      .getSnapshot()
      .targets.some((value) => value.id === target.id);
  }

  event(event: CdpEvent): void {
    if (!this.active()) return;
    const info = event.params.targetInfo;
    const id =
      event.method === "Target.targetDestroyed"
        ? event.params.targetId
        : isRecord(info)
          ? info.targetId
          : undefined;
    if (
      typeof id !== "string" ||
      !id ||
      (event.method !== "Target.targetDestroyed" &&
        (!isRecord(info) || typeof info.type !== "string"))
    ) {
      this.reconcile();
      return;
    }
    try {
      const target =
        event.method === "Target.targetDestroyed" ? null : pageTarget(info);
      const present = this.state().entries.has(id);
      if (!target) {
        if (
          !present &&
          (event.method !== "Target.targetDestroyed" || !this.state().round)
        )
          return;
        this.dirty.delete(id);
        this.commit({ type: "retired", id }, present);
      } else {
        this.commit({ type: "metadata", target, now: performance.now() });
        this.dirty.add(id);
        if (!this.state().ready) this.fullWanted = true;
        this.pump();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.selected?.deadline.abort();
    this.scan?.deadline.abort();
    this.inventoryDeadline?.abort();
    this.dirty.clear();
    this.selected = null;
    this.fullWanted = false;
    if (this.state().epoch === this.epoch)
      this.model.inventory({ type: "reset" });
  }

  private active(): boolean {
    return (
      !this.closed &&
      !this.options.signal.aborted &&
      this.epoch === this.state().epoch
    );
  }

  private commit(event: InventoryEvent, notify = true): void {
    const targets = this.model.getSnapshot().targets;
    const ready = this.state().ready;
    this.model.inventory(event);
    this.expireInventory();
    if (
      notify &&
      (targets !== this.model.getSnapshot().targets ||
        (!ready && this.state().ready))
    )
      this.publish();
  }

  private observe(id: string): TargetObservation | null {
    if (!this.active()) return null;
    const state = this.model.inventory({ type: "order" });
    const entry = state.entries.get(id);
    return entry
      ? {
          id,
          epoch: state.epoch,
          generation: entry.generation,
          order: state.sequence,
          startedAt: performance.now(),
        }
      : null;
  }

  private reconcile(): void {
    if (!this.active()) return;
    this.fullWanted = true;
    this.pump();
  }

  private pump(): void {
    if (!this.active() || this.running) return;
    this.drain().catch((error: unknown) => this.fail(error));
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.active() && (this.fullWanted || this.dirty.size)) {
        if (this.fullWanted) {
          this.fullWanted = false;
          await this.readFull();
        } else await this.readDirty();
      }
    } finally {
      this.running = false;
    }
  }

  private async readFull(): Promise<void> {
    const state = this.model.inventory({
      type: "begin-round",
      now: performance.now(),
    });
    const scan: Scan = { round: state.round!, deadline: new AbortController() };
    this.scan = scan;
    const current = () =>
      this.active() && currentRound(this.state(), scan.round);
    timeout(
      () => {
        if (current())
          this.fail(
            new CdpFault(
              "scope",
              "Window inventory could not be verified in time.",
            ),
          );
      },
      inventoryRoundMs,
      {
        signal: AbortSignal.any([this.options.signal, scan.deadline.signal]),
      },
    );
    try {
      const pages = await this.directory.read();
      if (!current()) return;
      this.commit({ type: "listed", round: scan.round, targets: pages });
      if (!current()) return;
      for (let offset = 0; offset < pages.length; offset += 4) {
        await Promise.all(
          pages.slice(offset, offset + 4).map(async (target) => {
            const observation = this.observe(target.id);
            if (!observation) return;
            try {
              const member = await this.directory.contains(target.id);
              if (current())
                this.commit({ type: "membership", observation, member });
            } catch (error) {
              if (current() && currentObservation(this.state(), observation))
                this.fail(error);
            }
          }),
        );
        if (!current()) return;
      }
      this.commit({ type: "complete-round", round: scan.round });
    } catch (error) {
      if (current()) this.fail(error);
    } finally {
      scan.deadline.abort();
      if (this.scan === scan) this.scan = null;
    }
  }

  private expireInventory(): void {
    if (!this.active() || !this.options.scoped) return;
    this.inventoryDeadline?.abort();
    const expiresAt = inventoryExpiry(this.state());
    if (expiresAt === null) return;
    const deadline = new AbortController();
    this.inventoryDeadline = deadline;
    const expire = () => {
      if (this.active() && this.inventoryDeadline === deadline)
        this.fail(
          new CdpFault(
            "scope",
            "Window inventory could not be verified in time.",
          ),
        );
    };
    const remaining = expiresAt - performance.now();
    if (remaining <= 0) expire();
    else
      timeout(expire, remaining, {
        signal: AbortSignal.any([this.options.signal, deadline.signal]),
      });
  }

  private async readDirty(): Promise<void> {
    const batch: string[] = [];
    for (const id of this.dirty) {
      batch.push(id);
      this.dirty.delete(id);
      if (batch.length === 4) break;
    }
    await Promise.all(
      batch.map(async (id) => {
        const observation = this.observe(id);
        if (!observation) return;
        try {
          const member = await this.directory.contains(id);
          if (this.active())
            this.commit({ type: "membership", observation, member });
        } catch (error) {
          if (this.active() && currentObservation(this.state(), observation))
            this.fail(error);
        }
      }),
    );
  }

  private checkSelected(): void {
    const selected = this.selected;
    if (!this.active() || !selected || selected.pending) return;
    if (!this.current(selected.targetId)) {
      this.staleSelected();
      return;
    }
    selected.pending = true;
    this.readSelected(selected).catch((error: unknown) => {
      if (this.active() && this.selected === selected) this.fail(error);
    });
  }

  private async readSelected(selected: Selected): Promise<void> {
    const observation = this.observe(selected.targetId);
    try {
      if (!observation) return;
      const member = await this.directory.contains(selected.targetId);
      if (!this.active() || this.selected !== selected) return;
      if (!this.current(selected.targetId)) {
        this.staleSelected();
        return;
      }
      this.commit({ type: "membership", observation, member });
      if (this.selected !== selected) return;
      const entry = this.state().entries.get(selected.targetId);
      if (
        entry?.generation === observation.generation &&
        entry.membership?.member
      ) {
        selected.verifiedAt = Math.max(
          selected.verifiedAt,
          entry.membership.startedAt,
        );
        selected.deadline.abort();
        selected.deadline = new AbortController();
        this.expireSelected(selected);
      }
    } catch (error) {
      if (
        observation &&
        this.active() &&
        this.selected === selected &&
        currentObservation(this.state(), observation)
      )
        this.fail(error);
    } finally {
      selected.pending = false;
    }
  }

  private expireSelected(selected: Selected): void {
    timeout(
      () => {
        if (this.active() && this.selected === selected) this.staleSelected();
      },
      Math.max(
        0,
        selected.verifiedAt + selectedFreshnessMs - performance.now(),
      ),
      {
        signal: AbortSignal.any([
          this.options.signal,
          selected.deadline.signal,
        ]),
      },
    );
  }

  private staleSelected(): void {
    this.fail(
      new CdpFault(
        "scope",
        "Selected window membership could not be verified in time.",
      ),
    );
  }

  private publish(): void {
    if (this.active() && this.state().ready) this.options.changed();
  }

  private fail(error: unknown): void {
    if (!this.active()) return;
    this.scan?.deadline.abort();
    this.inventoryDeadline?.abort();
    this.fullWanted = false;
    this.dirty.clear();
    this.epoch = this.model.inventory({ type: "reset" }).epoch;
    this.options.failed(error);
  }
}
