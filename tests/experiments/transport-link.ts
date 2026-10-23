interface Message {
  remaining: number;
  deliver: () => void;
}

/** Aggregate modeled downlink, FIFO per socket and fair 16 KiB chunks across sockets. */
export class TransportLink {
  private readonly lanes = new Map<object, Message[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private active = false;
  private closed = false;
  private cursor = 0;

  constructor(private readonly shaped: boolean) {}

  private later(deliver: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) deliver();
    }, Math.ceil(ms));
    this.timers.add(timer);
  }

  uplink(deliver: () => void): void {
    if (!this.closed) this.later(deliver, this.shaped ? 50 : 0);
  }

  downlink(owner: object, bytes: number, deliver: () => void): void {
    if (this.closed) return;
    if (!this.shaped) {
      this.later(deliver, 0);
      return;
    }
    const lane = this.lanes.get(owner) ?? [];
    this.lanes.set(owner, lane);
    lane.push({ remaining: bytes, deliver });
    if (!this.active) this.tick();
  }

  private tick(): void {
    const lanes = [...this.lanes.values()].filter((lane) => lane.length);
    if (this.closed || !lanes.length) {
      this.active = false;
      return;
    }
    this.active = true;
    const lane = lanes[this.cursor++ % lanes.length]!;
    const message = lane[0]!;
    const bytes = Math.min(message.remaining, 16 * 1024);
    this.later(
      () => {
        message.remaining -= bytes;
        if (!message.remaining) {
          lane.shift();
          this.later(message.deliver, 50);
        }
        this.tick();
      },
      (bytes / (1024 * 1024)) * 1000,
    );
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.lanes.clear();
  }
}
