import type { Protocol } from "devtools-protocol";
import { timeout } from "signal-timers";
import { CdpFault, isRecord } from "../cdp/errors";
import { frameTimeoutMs, maximumFrameDimension } from "./limits";
import {
  frameViewport,
  captureRaster,
  inputTransform,
  InputGeometry,
  positive,
} from "./geometry";
import type {
  DisplayTransform,
  PresentationGeometry,
  Viewport,
} from "./geometry";

interface FrameGeometry {
  readonly viewport: Viewport | null;
  readonly device: Viewport | null;
  readonly raster: Viewport;
}

type Presentation = "presented" | "inconsistent";

type FrameWait =
  | { readonly kind: "native" }
  | { readonly kind: "presentation"; readonly recoverInconsistent: boolean };

function same(actual: Viewport, wanted: Viewport): boolean {
  return (
    Math.abs(actual.width - wanted.width) <= 1 &&
    Math.abs(actual.height - wanted.height) <= 1
  );
}

function presentationTimeout(): CdpFault {
  return new CdpFault(
    "display",
    "The synchronized image did not arrive. Try synchronizing again.",
  );
}

type Adaptation =
  | { readonly kind: "native"; readonly scale: number }
  | { readonly kind: "writing" | "uncertain" }
  | {
      readonly kind: "presenting" | "presented";
      readonly scale: number;
      readonly expected: PresentationGeometry;
    };

function compatible(
  frame: FrameGeometry,
  expected: PresentationGeometry,
  capture: Viewport,
): boolean {
  // Allow native DIP rounding, then validate pixels against the frame's actual
  // metadata and native density. Projected rounding cannot excuse a stale JPEG.
  return (
    !!frame.viewport &&
    !!frame.device &&
    same(frame.device, expected.device) &&
    same(frame.raster, captureRaster(frame.device, expected.nativeDpr, capture))
  );
}

/** One selected session's acknowledged adaptation, calibration and painted facts. */
export class DisplayViewport {
  private version = 0;
  private timestamp = -Infinity;
  private captureAfter = -Infinity;
  private painted: FrameGeometry | null = null;
  private decoded: FrameGeometry | null = null;
  private adaptation: Adaptation = { kind: "native", scale: 1 };
  private transform: DisplayTransform | null = null;
  private waiting: {
    finish: (result: Presentation | CdpFault) => void;
    request: FrameWait;
  } | null = null;
  private capture: Viewport = {
    width: maximumFrameDimension,
    height: maximumFrameDimension,
  };

  setCapture(bounds: Viewport): void {
    this.capture = bounds;
  }

  get revision(): number {
    return this.version;
  }

  get device(): Viewport | null {
    return this.painted?.device ?? null;
  }

  get available(): boolean {
    return (
      this.adaptation.kind === "native" || this.adaptation.kind === "presented"
    );
  }

  get input(): InputGeometry | null {
    if (!this.available || !this.painted?.viewport || !this.transform)
      return null;
    return new InputGeometry(
      this.version,
      {
        width: this.painted.viewport.width * this.transform.frameScale,
        height: this.painted.viewport.height * this.transform.frameScale,
      },
      this.transform.wheelScale,
    );
  }

  matches(
    expected: PresentationGeometry,
    transform: DisplayTransform,
  ): boolean {
    const close = (left: number, right: number) =>
      Math.abs(left - right) <= Math.abs(right) * 1e-6;
    return (
      this.adaptation.kind === "presented" &&
      !!this.painted &&
      compatible(this.painted, expected, this.capture) &&
      !!this.transform &&
      close(this.transform.viewportScale, transform.viewportScale) &&
      close(this.transform.frameScale, transform.frameScale) &&
      close(this.transform.wheelScale, transform.wheelScale)
    );
  }

  captureFence(
    layout: Protocol.Page.GetLayoutMetricsResponse,
    transform: DisplayTransform,
  ): (expected: PresentationGeometry) => boolean {
    const state = this.adaptation;
    if (state.kind !== "native" && state.kind !== "presented")
      return () => true;
    const viewport = layout.cssVisualViewport;
    const scale = (viewport.zoom ?? 1) * (viewport.scale ?? 1);
    const device = (viewportScale: number) => ({
      width: viewport.clientWidth * scale * viewportScale,
      height: viewport.clientHeight * scale * viewportScale,
    });
    const previous = device(state.scale);
    const projected = device(transform.viewportScale);
    const painted = this.painted?.device;
    // Preserve pre-write facts until acknowledged native bounds are known.
    return (expected) =>
      same(previous, expected.device) ||
      // An unchanged logical viewport can need a fresh static image even when
      // its native extent changes under the projected density.
      same(projected, expected.device) ||
      (!!painted && same(painted, expected.device));
  }

  fence(timestamp: number): void {
    this.captureAfter = timestamp;
    this.version++;
    this.painted = null;
    this.decoded = null;
  }

  invalidate(): void {
    this.version++;
    this.painted = null;
    this.decoded = null;
    this.transform = null;
    // External resize/navigation recalibrates native units. A transaction still
    // awaiting its image keeps the presentation barrier across invalidation.
    if (this.adaptation.kind === "presented")
      this.adaptation = { kind: "native", scale: this.adaptation.scale };
  }

  event(method: string): void {
    if (method === "Page.frameResized") this.invalidate();
  }

  apply(
    transform: DisplayTransform | null,
    expected: PresentationGeometry,
    freshCapture = false,
  ): void {
    // Frames can paint before the final native acknowledgement. Retain their facts,
    // but only the acknowledged projection can authorize their input mapping.
    this.transform = transform;
    this.adaptation = {
      kind: "presenting",
      scale: transform?.viewportScale ?? 1,
      expected,
    };
    if (freshCapture) this.fence(Infinity);
    this.present();
  }

  /** A write may have taken effect without a confirming reply. */
  uncertain(): void {
    this.adaptation = { kind: "uncertain" };
    this.captureAfter = -Infinity;
    this.invalidate();
  }

  /** Only a definite rejection can restore calibration from before a write. */
  beginWrite(): () => void {
    const previous = this.adaptation;
    const painted = this.painted;
    const transform = this.transform;
    this.adaptation = { kind: "writing" };
    this.invalidate();
    const revision = this.version;
    return () => {
      if (revision !== this.version) {
        this.uncertain();
        return;
      }
      this.version++;
      this.painted ??= painted;
      this.transform = transform;
      this.adaptation =
        previous.kind === "presented"
          ? { ...previous, kind: "presenting" }
          : previous;
      this.present();
    };
  }

  private present(): void {
    const state = this.adaptation;
    if (
      state.kind !== "presenting" ||
      !this.painted ||
      !compatible(this.painted, state.expected, this.capture)
    )
      return;
    this.adaptation = { ...state, kind: "presented" };
    this.waiting?.finish("presented");
  }

  private inconsistent(): boolean {
    const state = this.adaptation;
    return (
      state.kind === "presenting" &&
      !!this.decoded?.viewport &&
      !!this.decoded.device &&
      same(this.decoded.device, state.expected.device) &&
      !compatible(this.decoded, state.expected, this.capture)
    );
  }

  /** The same bounded stream budget applies when a resize stops producing images. */
  waitForPresentation(
    signal: AbortSignal,
    budget = frameTimeoutMs,
    recoverInconsistent = false,
  ): Promise<Presentation> {
    return this.waitForFrame(signal, budget, {
      kind: "presentation",
      recoverInconsistent,
    });
  }

  /** An initial layout can already be emulated; only a selected frame is native. */
  waitForNativeFrame(
    signal: AbortSignal,
    budget = frameTimeoutMs,
  ): Promise<Presentation> {
    return this.waitForFrame(signal, budget, { kind: "native" });
  }

  private waitForFrame(
    signal: AbortSignal,
    budget: number,
    request: FrameWait,
  ): Promise<Presentation> {
    if (budget <= 0) return Promise.reject(presentationTimeout());
    if (request.kind === "native" ? this.device !== null : this.available)
      return Promise.resolve("presented");
    if (
      request.kind === "presentation" &&
      request.recoverInconsistent &&
      this.inconsistent()
    )
      return Promise.resolve("inconsistent");
    return new Promise((resolve, reject) => {
      const deadline = new AbortController();
      const aborted = () =>
        finish(
          new CdpFault("display", "Display synchronization was cancelled."),
        );
      const finish = (result: Presentation | CdpFault) => {
        deadline.abort();
        signal.removeEventListener("abort", aborted);
        this.waiting = null;
        if (result instanceof CdpFault) reject(result);
        else resolve(result);
      };
      this.waiting = { finish, request };
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      timeout(() => finish(presentationTimeout()), budget, {
        signal: deadline.signal,
      });
    });
  }

  cancelPresentation(): void {
    this.waiting?.finish(
      new CdpFault("display", "Display synchronization was cancelled."),
    );
  }

  read(
    layout: Protocol.Page.GetLayoutMetricsResponse,
    revision: number,
  ): InputGeometry | null {
    if (revision !== this.version) return null;
    const state = this.adaptation;
    if (state.kind !== "native" && state.kind !== "presented") return null;
    const viewport = layout.cssVisualViewport;
    if (!positive(viewport.clientWidth) || !positive(viewport.clientHeight))
      throw new CdpFault(
        "input",
        "The remote viewport is unavailable for input.",
      );
    this.transform ??= inputTransform(viewport.zoom ?? 1, state.scale);
    return (
      this.input ??
      new InputGeometry(
        this.version,
        {
          width: viewport.clientWidth * state.scale,
          height: viewport.clientHeight * state.scale,
        },
        this.transform.wheelScale,
      )
    );
  }

  /** Null rejects an older capture; geometry is committed only after this image paints. */
  frame(metadata: unknown): {
    accept: (raster: Viewport) => boolean;
    painted: (raster: Viewport) => void;
  } | null {
    const timestamp = isRecord(metadata) ? metadata.timestamp : null;
    if (
      this.captureAfter !== -Infinity &&
      (typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        timestamp < this.captureAfter)
    )
      return null;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      if (timestamp < this.timestamp) return null;
      this.timestamp = timestamp;
    }
    const viewport = frameViewport(metadata);
    const device =
      isRecord(metadata) &&
      positive(metadata.deviceWidth) &&
      positive(metadata.deviceHeight)
        ? { width: metadata.deviceWidth, height: metadata.deviceHeight }
        : null;
    const version = this.version;
    const accept = (raster: Viewport) => {
      if (version !== this.version) return false;
      const state = this.adaptation;
      this.decoded = { viewport, device, raster };
      const accepted =
        (state.kind !== "presenting" && state.kind !== "presented") ||
        compatible(this.decoded, state.expected, this.capture);
      if (
        this.waiting?.request.kind === "presentation" &&
        this.waiting.request.recoverInconsistent &&
        this.inconsistent()
      )
        this.waiting.finish("inconsistent");
      return accepted;
    };
    return {
      accept,
      painted: (raster) => {
        if (!accept(raster)) return;
        this.painted = { viewport, device, raster };
        if (device && this.waiting?.request.kind === "native")
          this.waiting.finish("presented");
        this.present();
      },
    };
  }
}
