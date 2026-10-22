import type { SocketFactory } from "../../src/cdp/client";
import type { InputStop } from "../../src/input/lifecycle";
import { GuardedProbe } from "./guarded-probe";
import type { ProbeMode, ProbeReply } from "./guarded-probe";

/** Explicit test-owned browser admission, never an endpoint-keyed global pool. */
export class ProbeHost {
  private readonly targets = new Map<string, { probe: GuardedProbe | null }>();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly endpoint: string,
    private readonly factory?: SocketFactory,
  ) {}

  async admit({
    targetId,
    windowId,
    reply,
    mode,
    transitionDeadlineMs,
  }: {
    targetId: string;
    windowId: number;
    reply: (value: ProbeReply) => void;
    mode?: ProbeMode;
    transitionDeadlineMs?: number;
  }): Promise<GuardedProbe> {
    if (this.lifetime.signal.aborted) throw new Error("Fixture host is closed");
    if (this.targets.has(targetId))
      throw new Error("Fixture target has an unsettled owner");
    // Reserve before any await, including the connection and scope lookup.
    const slot = { probe: null as GuardedProbe | null };
    this.targets.set(targetId, slot);
    slot.probe = await GuardedProbe.open({
      endpoint: this.endpoint,
      targetId,
      windowId,
      reply,
      signal: this.lifetime.signal,
      ...(mode ? { mode } : {}),
      ...(transitionDeadlineMs !== undefined ? { transitionDeadlineMs } : {}),
      ...(this.factory ? { factory: this.factory } : {}),
    });
    if (this.lifetime.signal.aborted) {
      slot.probe.close();
      throw new Error("Fixture host is closed");
    }
    return slot.probe;
  }

  async retire(
    probe: GuardedProbe,
    reason: Exclude<InputStop, "disconnected"> = "disposed",
    deadlineMs = 10_000,
  ): Promise<boolean> {
    const slot = this.targets.get(probe.targetId);
    if (slot?.probe !== probe) return false;
    const confirmed = await probe.retire(reason, deadlineMs);
    if (confirmed && this.targets.get(probe.targetId) === slot)
      this.targets.delete(probe.targetId);
    // An unknown release retains its reservation, even after local teardown.
    return confirmed;
  }

  close(): void {
    this.lifetime.abort();
    for (const { probe } of this.targets.values()) probe?.close();
  }
}
