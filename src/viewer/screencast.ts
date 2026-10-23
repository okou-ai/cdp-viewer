import type { CdpClient } from "../cdp/client";
import { CdpFault } from "../cdp/errors";
import { frameTimeoutMs } from "../display/limits";
import type { FrameSink } from "../render/canvas";
import type { Viewport } from "../display/geometry";
import { sameCapture } from "./capture";
import type { CaptureSettings } from "./capture";

interface ScreencastOwner {
  client: CdpClient;
  sessionId: string;
  sink: FrameSink;
  current: () => boolean;
  failed: (error: unknown) => void;
  starting?: (settings: CaptureSettings) => void;
}

/** Capture may restart while its selected session and native input remain owned. */
export class Screencast {
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private desired: CaptureSettings;
  private applied: CaptureSettings | null = null;
  private busy = false;
  private working: Promise<void> | null = null;
  private reserved = false;
  private disposed = false;
  private started = false;
  private accepting = false;
  private revision = 0;
  private painted = false;
  private monitor = true;

  constructor(
    private readonly owner: ScreencastOwner,
    settings: CaptureSettings,
  ) {
    this.desired = settings;
  }

  start(): Promise<void> {
    this.schedule();
    return this.working ?? Promise.resolve();
  }

  configure(settings: CaptureSettings): void {
    this.desired = settings;
    this.schedule();
  }

  push(
    data: string,
    painted: (raster: Viewport) => void,
    accept?: (raster: Viewport) => boolean,
  ): void {
    if (!this.current() || !this.accepting) return;
    const revision = this.revision;
    const current = () =>
      this.current() && this.accepting && revision === this.revision;
    this.owner.sink.push(
      data,
      (raster) => {
        if (!current()) return;
        this.painted = true;
        this.cancelDeadline();
        painted(raster);
      },
      (error) => {
        if (current()) this.fail(error);
      },
      (raster) => current() && (accept?.(raster) ?? true),
    );
  }

  /** Display refresh/recovery shares the capture lane and retains the latest preferences. */
  async exclusive(operation: () => Promise<void>): Promise<void> {
    if (this.reserved)
      throw new CdpFault(
        "protocol",
        "A capture operation is already in progress.",
      );
    this.reserved = true;
    try {
      await this.working;
      if (this.current()) await operation();
    } finally {
      this.reserved = false;
      this.schedule();
    }
  }

  async stop(): Promise<void> {
    if (!this.current()) return;
    this.accepting = false;
    this.revision++;
    this.cancelDeadline();
    this.owner.sink.invalidate();
    await this.owner.client.request(
      "Page.stopScreencast",
      undefined,
      this.owner.sessionId,
    );
    if (this.current()) this.started = false;
  }

  /** A definite stop rejection leaves the original stream active. */
  resume(): void {
    if (!this.current() || !this.started) return;
    this.accepting = true;
    this.waitForFrame();
  }

  async begin(settings: CaptureSettings, monitor = true): Promise<void> {
    if (!this.current()) return;
    this.painted = false;
    this.monitor = monitor;
    this.accepting = true;
    this.started = true;
    this.owner.starting?.(settings);
    // Keep the final static state available when native frame credit is exhausted.
    await this.owner.client.request(
      "Page.startScreencast",
      { format: "jpeg", ...settings, sendLastFrame: true },
      this.owner.sessionId,
    );
    if (!this.current()) return;
    this.applied = settings;
    this.waitForFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accepting = false;
    this.cancelDeadline();
    if (this.started)
      this.owner.client.notify(
        "Page.stopScreencast",
        undefined,
        this.owner.sessionId,
      );
  }

  private current(): boolean {
    return !this.disposed && this.owner.current();
  }

  private cancelDeadline(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private waitForFrame(): void {
    this.cancelDeadline();
    if (!this.painted && this.monitor)
      this.deadline = setTimeout(() => {
        if (this.current() && !this.painted)
          this.fail(
            new CdpFault("frame", "The browser did not produce a live frame."),
          );
      }, frameTimeoutMs);
  }

  private fail(error: unknown): void {
    if (!this.current()) return;
    this.dispose();
    this.owner.failed(error);
  }

  private schedule(): void {
    if (
      !this.current() ||
      this.busy ||
      this.reserved ||
      (this.applied && sameCapture(this.applied, this.desired))
    )
      return;
    this.busy = true;
    this.working = this.reconcile()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.busy = false;
        this.working = null;
        // A committed update can arrive between reconcile's completion and this job.
        if (
          this.current() &&
          this.applied &&
          !sameCapture(this.applied, this.desired)
        )
          this.schedule();
      });
  }

  private async reconcile(): Promise<void> {
    while (
      this.current() &&
      !this.reserved &&
      (!this.applied || !sameCapture(this.applied, this.desired))
    ) {
      if (this.started) {
        await this.stop();
        if (!this.current()) return;
      }
      // Coalesce updates received while stop was pending before dispatching start.
      const settings = this.desired;
      await this.begin(settings);
    }
  }
}
