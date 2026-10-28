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

type NativeCapture =
  | { readonly kind: "stopped" }
  | { readonly kind: "possible"; readonly epoch: object };

/** Capture may restart while its selected session and native input remain owned. */
export class Screencast {
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private desired: CaptureSettings;
  private applied: CaptureSettings | null = null;
  private busy = false;
  private working: Promise<void> | null = null;
  private reserved = false;
  private exclusiveWork: Promise<void> | null = null;
  private quiescing: Promise<void> | null = null;
  private halted = false;
  private disposed = false;
  private native: NativeCapture = { kind: "stopped" };
  private accepting = false;
  private revision = 0;
  private painted = false;
  private monitor = true;
  private navigationRevision = 0;
  private navigating = new Set<string>();
  private navigationWaiter: (() => void) | null = null;

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

  get acceptingFrames(): boolean {
    return this.current() && !this.halted && this.accepting;
  }

  get stopped(): boolean {
    return this.native.kind === "stopped";
  }

  navigationStarted(frameId: string): void {
    this.navigationRevision++;
    this.navigating.add(frameId);
  }

  navigationFinished(frameId: string): void {
    this.navigating.delete(frameId);
    if (!this.navigating.size) this.navigationWaiter?.();
  }

  push(
    data: string,
    painted: (raster: Viewport) => void,
    accept?: (raster: Viewport) => boolean,
  ): void {
    if (!this.acceptingFrames) return;
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
  exclusive(operation: () => Promise<void>): Promise<void> {
    if (this.halted)
      return Promise.reject(
        new CdpFault(
          "frame",
          "The live image must be retried before capture work can continue.",
        ),
      );
    return this.reserve(operation);
  }

  private reserve(operation: () => Promise<void>): Promise<void> {
    if (this.reserved)
      return Promise.reject(
        new CdpFault("protocol", "A capture operation is already in progress."),
      );
    this.reserved = true;
    const work: Promise<void> = Promise.resolve()
      .then(async () => {
        await this.working;
        if (this.current()) await operation();
      })
      .finally(() => {
        this.reserved = false;
        if (this.exclusiveWork === work) this.exclusiveWork = null;
        this.schedule();
      });
    this.exclusiveWork = work;
    return work;
  }

  /** Revoke an image attempt without disposing its selected native session. */
  suspend(): void {
    if (!this.current() || this.halted) return;
    this.halted = true;
    this.accepting = false;
    this.revision++;
    this.cancelDeadline();
    this.owner.sink.invalidate();
    this.navigationWaiter?.();
  }

  /** A failed attempt retains its session only after original stop is confirmed. */
  quiesce(): Promise<void> {
    if (this.quiescing) return this.quiescing;
    const previous = this.exclusiveWork;
    this.quiescing = Promise.resolve().then(async () => {
      await this.working;
      try {
        await previous;
      } catch (error) {
        // The failed attempt keeps its diagnostic; cleanup still needs a stop receipt.
        if (!this.halted) throw error;
      }
      if (!this.current())
        throw new CdpFault("frame", "Capture cleanup could not be confirmed.");
      await this.reserve(async () => {
        await this.stop();
        if (!this.stopped)
          throw new CdpFault(
            "frame",
            "Capture cleanup could not be confirmed.",
          );
      });
      if (!this.stopped)
        throw new CdpFault("frame", "Capture cleanup could not be confirmed.");
    });
    return this.quiescing;
  }

  /** User intent alone can start a new attempt after the failed attempt settled. */
  async retry(
    prepare: () => Promise<void>,
    starting: () => void,
  ): Promise<void> {
    await this.quiesce();
    if (!this.current()) return;
    await this.reserve(async () => {
      await prepare();
      if (!this.current()) return;
      starting();
      if (!this.current()) return;
      this.quiescing = null;
      this.halted = false;
      this.applied = null;
      try {
        await this.begin(this.desired);
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.current()) return;
    const epoch = this.native.kind === "possible" ? this.native.epoch : null;
    this.accepting = false;
    this.revision++;
    this.cancelDeadline();
    this.owner.sink.invalidate();
    await this.owner.client.request(
      "Page.stopScreencast",
      undefined,
      this.owner.sessionId,
    );
    // A positive receipt belongs to this original resource after active selection retires.
    // It proves cleanup only; it cannot reactivate this object or grant a new input owner.
    if (this.native.kind === "stopped" || this.native.epoch === epoch)
      this.native = { kind: "stopped" };
  }

  /** A definite stop rejection leaves the original stream active. */
  resume(): void {
    if (!this.current() || this.halted || this.stopped) return;
    this.accepting = true;
    this.waitForFrame();
  }

  async begin(settings: CaptureSettings, monitor = true): Promise<void> {
    if (!this.current()) return;
    if (this.halted)
      throw new CdpFault("frame", "The live image is unavailable.");
    this.painted = false;
    this.monitor = monitor;
    this.accepting = true;
    this.native = { kind: "possible", epoch: {} };
    this.owner.starting?.(settings);
    const { quality, ...image } = settings;
    // Keep the final static state available when native frame credit is exhausted.
    await this.owner.client.request(
      "Page.startScreencast",
      {
        ...image,
        ...(settings.format === "png" ? {} : { quality }),
        sendLastFrame: true,
      },
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
    this.navigationWaiter?.();
    this.navigating.clear();
    if (!this.stopped)
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
    if (!this.current() || this.halted) return;
    this.suspend();
    this.owner.failed(error);
  }

  private schedule(): void {
    if (
      !this.current() ||
      this.halted ||
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
    let recoveredNavigation = false;
    while (
      this.current() &&
      !this.halted &&
      !this.reserved &&
      (!this.applied || !sameCapture(this.applied, this.desired))
    ) {
      if (!this.stopped) {
        await this.stop();
        if (!this.current()) return;
      }
      // Coalesce updates received while stop was pending before dispatching start.
      const settings = this.desired;
      const navigation = this.navigationRevision;
      try {
        await this.begin(settings);
      } catch (error) {
        // Chrome rejects a capture restart while replacing the document. Only
        // recover a definite start rejection with observed concurrent navigation;
        // uncertain requests and ordinary protocol failures still fail normally.
        if (
          !this.applied ||
          recoveredNavigation ||
          !(error instanceof CdpFault) ||
          error.code !== -32000 ||
          (!this.navigating.size && navigation === this.navigationRevision)
        )
          throw error;
        recoveredNavigation = true;
        this.accepting = false;
        this.revision++;
        this.owner.sink.invalidate();
        if (!(await this.waitForNavigation())) throw error;
        this.applied = null;
      }
    }
  }

  private waitForNavigation(): Promise<boolean> {
    if (!this.navigating.size || !this.current()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(deadline);
        this.navigationWaiter = null;
        resolve(completed);
      };
      const deadline = setTimeout(() => finish(false), frameTimeoutMs);
      this.navigationWaiter = () => finish(true);
    });
  }
}
