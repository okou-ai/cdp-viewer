import type { CdpClient } from "../cdp/client";
import { CdpFault, diagnostic } from "../cdp/errors";
import { maximumTargets } from "../cdp/targets";
import { captureBoundary } from "../display/capture-boundary";
import type { DisplaySync } from "../display/sync";
import type { DisplayViewport } from "../display/viewport";
import type { InputSession } from "../input/session";
import type { FrameSink } from "../render/canvas";
import type { ImageEvent } from "./image-recovery";
import type { ViewerModel } from "./model";
import type { Screencast } from "./screencast";
import type { ViewerError } from "./types";

export interface ImageSelection {
  readonly targetId: string;
  sessionId: string | null;
  painted: boolean;
  stream: Screencast | null;
  input: InputSession | null;
  inputReady: boolean;
  readonly geometry: DisplayViewport;
}

interface RecoveryBinding {
  readonly owner: object;
  readonly selection: ImageSelection;
  readonly stream: Screencast;
}

export interface ImageRetirement {
  readonly owner: object;
  readonly stopped: boolean;
}

interface RecoveryHost {
  readonly client: () => CdpClient;
  readonly display: () => DisplaySync | null;
  readonly current: (selection: ImageSelection) => boolean;
  readonly available: () => boolean;
  readonly disposed: () => boolean;
  readonly assertMember: (targetId: string) => Promise<void>;
  readonly select: (targetId: string) => void;
  readonly lost: (error: ViewerError) => void;
}

/** Binds policy effects to original resources; semantic recovery state stays in the model. */
export class ImageRecoveryRuntime {
  private readonly retirements = new Map<string, Promise<void>>();
  private binding: RecoveryBinding | null = null;

  constructor(
    private readonly model: ViewerModel,
    private readonly sink: FrameSink,
    private readonly host: RecoveryHost,
  ) {}

  settle(targetId: string): Promise<void> | undefined {
    return this.retirements.get(targetId);
  }

  forget(targetId: string): void {
    this.retirements.delete(targetId);
  }

  close(): void {
    this.binding = null;
    this.retirements.clear();
  }

  fail(selection: ImageSelection, error: ViewerError): void {
    const stream = selection.stream;
    if (!stream || !this.host.current(selection)) return;
    if (
      this.retirements.size >= maximumTargets &&
      !this.retirements.has(selection.targetId)
    ) {
      this.host
        .client()
        .close(
          new CdpFault("protocol", "Too many unconfirmed capture owners."),
        );
      return;
    }
    stream.suspend();
    if (!this.host.current(selection)) return;
    const binding: RecoveryBinding = { owner: {}, selection, stream };
    this.binding = binding;
    selection.painted = false;
    let inputCleanup = Promise.resolve();
    let captureCleanup = Promise.resolve();
    let displayCleanup = Promise.resolve();
    // Install the original fence before any cleanup callback can select again.
    const cleanup = Promise.resolve().then(async () => {
      await Promise.all([inputCleanup, captureCleanup, displayCleanup]);
    });
    this.track(binding, cleanup);
    inputCleanup = selection.input?.suspend() ?? Promise.resolve();
    captureCleanup = stream.quiesce();
    if (this.host.current(selection)) {
      this.host.display()?.setSuspended(true);
      selection.geometry.suspendPresentation();
      displayCleanup = this.host.display()?.settle() ?? Promise.resolve();
    }
    if (this.host.current(selection)) {
      this.sink.reset();
      if (this.host.current(selection))
        this.report(binding, {
          type: "image-failed",
          owner: binding.owner,
          targetId: selection.targetId,
          error,
        });
    }
  }

  retry(selection: ImageSelection | null): void {
    const image = this.model.read(this.model.imageRecovery$);
    if (image?.phase !== "ready" || !this.host.available()) return;
    if (!selection) {
      this.host.select(image.targetId);
      return;
    }
    const binding = this.binding;
    if (!binding || binding.selection !== selection || !this.current(binding))
      return;
    this.report(binding, { type: "image-retrying", owner: binding.owner });
    if (!this.current(binding)) return;
    Promise.resolve()
      .then(async () => {
        await this.host.assertMember(selection.targetId);
        if (!this.current(binding)) return;
        await this.host.display()?.settle();
        if (!this.current(binding)) return;
        await binding.stream.retry(
          async () => {
            const boundary = await captureBoundary(
              this.host.client(),
              selection.sessionId!,
              () => this.current(binding),
            );
            if (boundary === null || !this.current(binding)) return;
            await this.host.assertMember(selection.targetId);
            if (this.current(binding)) {
              selection.geometry.fence(boundary);
              selection.geometry.resumePresentation();
            }
          },
          () =>
            this.report(binding, {
              type: "image-starting",
              owner: binding.owner,
            }),
        );
        if (this.current(binding))
          this.report(binding, {
            type: "image-released",
            owner: binding.owner,
          });
      })
      .catch((error: unknown) => {
        if (!this.current(binding)) return;
        const fault = diagnostic(error);
        if (fault.kind === "scope" || fault.kind === "target-unavailable")
          this.host.lost(fault);
        else
          this.report(binding, {
            type: "image-blocked",
            owner: binding.owner,
            error: fault,
          });
      });
  }

  /** Called only after the controller has current painted output and input initialization. */
  ready(selection: ImageSelection): boolean {
    const binding = this.binding;
    if (!binding || binding.selection !== selection || !this.current(binding))
      return false;
    this.report(binding, { type: "image-painted", owner: binding.owner });
    return true;
  }

  /** Resource facts are captured before selection retirement can reenter the controller. */
  retire(selection: ImageSelection): ImageRetirement | null {
    const binding = this.binding;
    if (!binding || binding.selection !== selection) return null;
    const image = this.model.read(this.model.imageRecovery$);
    const stopped = binding.stream.stopped;
    if (
      image?.owner === binding.owner &&
      !stopped &&
      image.phase !== "settling"
    )
      this.track(binding, binding.stream.quiesce());
    this.binding = null;
    return { owner: binding.owner, stopped };
  }

  cancel(retirement: ImageRetirement | null): void {
    if (retirement && !this.host.disposed())
      this.model.transition({ type: "image-cancelled", ...retirement });
  }

  private current(binding: RecoveryBinding): boolean {
    return (
      this.binding === binding &&
      this.host.current(binding.selection) &&
      this.model.read(this.model.imageRecovery$)?.owner === binding.owner
    );
  }

  private report(binding: RecoveryBinding, event: ImageEvent): void {
    if (this.host.disposed()) return;
    const decision = this.model.transition(event);
    // Both readiness arrival orders converge here, after accepted semantic publication.
    if (
      decision?.resumeDisplay &&
      this.binding === binding &&
      this.host.current(binding.selection) &&
      !this.model.read(this.model.imageRecovery$)
    )
      this.host.display()?.setSuspended(false);
    if (this.binding === binding && !this.model.read(this.model.imageRecovery$))
      this.binding = null;
  }

  private track(binding: RecoveryBinding, complete: Promise<void>): void {
    const { targetId } = binding.selection;
    const previous = this.retirements.get(targetId);
    const fence = previous
      ? Promise.all([previous, complete]).then(() => {})
      : complete;
    this.retirements.set(targetId, fence);
    fence.then(
      () => {
        if (this.retirements.get(targetId) === fence)
          this.retirements.delete(targetId);
        this.report(binding, {
          type: "image-settled",
          owner: binding.owner,
          ready: true,
        });
      },
      () => {
        // Unknown cleanup remains a same-target fence for this connection lifetime.
        this.report(binding, {
          type: "image-settled",
          owner: binding.owner,
          ready: false,
        });
      },
    );
  }
}
