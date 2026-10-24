import { interval, timeout } from "signal-timers";
import { CdpFault, isRecord } from "../cdp/errors";
import { maximumTargets, pageTarget } from "../cdp/targets";
import type { TargetDirectory } from "../cdp/targets";
import type { CdpEvent } from "../cdp/client";
import type { ViewerTarget } from "./types";

const selectedIntervalMs = 2_000;
const selectedFreshnessMs = 12_000;
const inventoryIntervalMs = 10_000;
const inventoryRoundMs = 10_000;
const inventoryFreshnessMs = inventoryIntervalMs + inventoryRoundMs;

interface Entry {
  readonly target: ViewerTarget;
  member: boolean;
}

interface Scan {
  readonly changed: Set<string>;
  readonly deadline: AbortController;
  invalidated: boolean;
  expired: boolean;
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
  readonly changed: (targets: readonly ViewerTarget[]) => void;
  readonly failed: (error: unknown) => void;
}

/** Metadata and observations belong to one connection, never an endpoint cache. */
export class TargetDiscovery {
  private readonly entries = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private scan: Scan | null = null;
  private inventoryDeadline: AbortController | null = null;
  private selected: Selected | null = null;
  private fullWanted = false;
  private running = false;
  private ready = false;
  private closed = false;
  private revision = 0;

  constructor(
    private readonly directory: TargetDirectory,
    private readonly options: DiscoveryOptions,
  ) {}

  start(): void {
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

  /** Explicit newer tab operations supersede a previously captured full scan. */
  refresh(): void {
    this.revision++;
    if (this.scan) {
      this.scan.invalidated = true;
      this.scan.deadline.abort();
    }
    this.reconcile();
  }

  /** The explicit create path has already freshly verified this target. */
  created(target: ViewerTarget): void {
    if (!this.active()) return;
    this.revision++;
    if (this.scan) {
      this.scan.invalidated = true;
      this.scan.deadline.abort();
    }
    if (!this.entries.has(target.id) && this.entries.size >= maximumTargets) {
      this.fail(
        new CdpFault("protocol", "Invalid or oversized browser target list."),
      );
      return;
    }
    this.entries.set(target.id, { target, member: true });
    this.dirty.delete(target.id);
    if (this.running) this.fullWanted = true;
    this.publish();
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
    let target: ViewerTarget | null;
    try {
      target =
        event.method === "Target.targetDestroyed" ? null : pageTarget(info);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (
      !target &&
      !this.entries.has(id) &&
      (event.method !== "Target.targetDestroyed" || !this.scan)
    )
      return;
    if (!this.changedTarget(id)) return;
    if (!target) {
      const present = this.entries.delete(id);
      this.dirty.delete(id);
      if (present) this.publish();
      return;
    }
    if (!this.entries.has(id) && this.entries.size >= maximumTargets) {
      this.fail(
        new CdpFault("protocol", "Invalid or oversized browser target list."),
      );
      return;
    }
    this.entries.set(id, {
      target,
      member: this.entries.get(id)?.member ?? false,
    });
    this.dirty.add(id);
    if (!this.ready) this.fullWanted = true;
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.selected?.deadline.abort();
    this.scan?.deadline.abort();
    this.inventoryDeadline?.abort();
    this.entries.clear();
    this.dirty.clear();
    this.selected = null;
    this.fullWanted = false;
  }

  private active(): boolean {
    return !this.closed && !this.options.signal.aborted;
  }

  private changedTarget(id: string): boolean {
    if (!this.scan) return true;
    this.scan.changed.add(id);
    if (this.scan.changed.size > maximumTargets) {
      this.fail(
        new CdpFault(
          "protocol",
          "Too many browser target changes during discovery.",
        ),
      );
      return false;
    }
    return true;
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
    const started = performance.now();
    const scan: Scan = {
      changed: new Set(),
      deadline: new AbortController(),
      invalidated: false,
      expired: false,
    };
    this.scan = scan;
    const current = () => this.active() && !scan.invalidated && !scan.expired;
    timeout(
      () => {
        if (!current()) return;
        scan.expired = true;
        this.fail(
          new CdpFault(
            "scope",
            "Window inventory could not be verified in time.",
          ),
        );
      },
      inventoryRoundMs,
      { signal: AbortSignal.any([this.options.signal, scan.deadline.signal]) },
    );
    try {
      const pages = await this.directory.read();
      if (!current()) return;
      const members = new Map<string, Entry>();
      for (let offset = 0; offset < pages.length; offset += 4) {
        const batch = pages.slice(offset, offset + 4);
        const results = await Promise.allSettled(
          batch.map(async (target) => {
            const entry = this.entries.get(target.id);
            try {
              const member = await this.directory.contains(target.id);
              if (
                current() &&
                !scan.changed.has(target.id) &&
                !member &&
                entry?.member &&
                this.entries.get(target.id) === entry
              ) {
                this.entries.delete(target.id);
                this.publish();
              }
              return member;
            } catch (error) {
              if (current() && !scan.changed.has(target.id)) this.fail(error);
              throw error;
            }
          }),
        );
        if (!current()) return;
        for (let index = 0; index < batch.length; index++) {
          const target = batch[index]!;
          if (scan.changed.has(target.id)) continue;
          const result = results[index]!;
          if (result.status === "rejected") throw result.reason;
          members.set(target.id, { target, member: result.value });
        }
      }
      for (const id of this.entries.keys())
        if (!scan.changed.has(id) && !members.has(id)) this.entries.delete(id);
      for (const [id, entry] of members)
        if (!scan.changed.has(id)) this.entries.set(id, entry);
      if (this.entries.size > maximumTargets)
        throw new CdpFault(
          "protocol",
          "Invalid or oversized browser target list.",
        );
      this.ready = true;
      if (this.options.scoped) this.expireInventory(started);
      this.publish();
    } catch (error) {
      if (current()) this.fail(error);
    } finally {
      scan.deadline.abort();
      if (this.scan === scan) this.scan = null;
    }
  }

  private expireInventory(started: number): void {
    this.inventoryDeadline?.abort();
    const deadline = new AbortController();
    this.inventoryDeadline = deadline;
    timeout(
      () => {
        if (this.active() && this.inventoryDeadline === deadline)
          this.fail(
            new CdpFault(
              "scope",
              "Window inventory could not be verified in time.",
            ),
          );
      },
      Math.max(0, started + inventoryFreshnessMs - performance.now()),
      {
        signal: AbortSignal.any([this.options.signal, deadline.signal]),
      },
    );
  }

  private async readDirty(): Promise<void> {
    const revision = this.revision;
    const batch = [...this.dirty].slice(0, 4).flatMap((id) => {
      this.dirty.delete(id);
      const entry = this.entries.get(id);
      return entry ? [{ id, entry }] : [];
    });
    await Promise.all(
      batch.map(async ({ id, entry }) => {
        const current = () =>
          this.active() &&
          revision === this.revision &&
          this.entries.get(id) === entry;
        try {
          const member = await this.directory.contains(id);
          if (!current()) return;
          entry.member = member;
          this.publish();
        } catch (error) {
          if (current()) this.fail(error);
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
    const started = performance.now();
    try {
      const member = await this.directory.contains(selected.targetId);
      if (!this.active() || this.selected !== selected) return;
      if (!this.current(selected.targetId)) {
        this.staleSelected();
        return;
      }
      if (!member) {
        if (!this.changedTarget(selected.targetId)) return;
        this.entries.delete(selected.targetId);
        this.dirty.delete(selected.targetId);
        this.publish();
      } else {
        // A delayed reply proves membership no earlier than request start.
        selected.verifiedAt = started;
        selected.deadline.abort();
        selected.deadline = new AbortController();
        this.expireSelected(selected);
      }
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
    if (this.active() && this.ready)
      this.options.changed(
        Object.freeze(
          [...this.entries.values()]
            .filter((entry) => entry.member)
            .map((entry) => entry.target),
        ),
      );
  }

  private fail(error: unknown): void {
    if (!this.active()) return;
    this.revision++;
    if (this.scan) {
      this.scan.invalidated = true;
      this.scan.deadline.abort();
    }
    this.fullWanted = false;
    this.inventoryDeadline?.abort();
    this.entries.clear();
    this.dirty.clear();
    this.ready = false;
    this.options.failed(error);
  }
}
