import type { Protocol } from "devtools-protocol";
import { CdpFault, isRecord } from "../cdp/errors";
import {
  frameViewport,
  inputTransform,
  InputGeometry,
  positive,
} from "./geometry";
import type { DisplayTransform, Viewport } from "./geometry";

/** One selected session's acknowledged adaptation, calibration and painted facts. */
export class DisplayViewport {
  private version = 0;
  private timestamp = -Infinity;
  private painted: Viewport | null = null;
  private appliedScale: number | null = 1;
  private transform: DisplayTransform | null = null;

  get revision(): number {
    return this.version;
  }

  get available(): boolean {
    return this.appliedScale !== null;
  }

  get input(): InputGeometry | null {
    if (!this.painted || !this.transform) return null;
    return new InputGeometry(
      this.version,
      {
        width: this.painted.width * this.transform.frameScale,
        height: this.painted.height * this.transform.frameScale,
      },
      this.transform.wheelScale,
    );
  }

  invalidate(): void {
    this.version++;
    this.painted = null;
    this.transform = null;
  }

  event(method: string): void {
    if (method === "Page.frameResized") this.invalidate();
  }

  apply(transform: DisplayTransform | null): void {
    this.invalidate();
    this.appliedScale = transform?.viewportScale ?? 1;
    this.transform = transform;
  }

  /** A write may have taken effect without a confirming reply. */
  uncertain(): void {
    this.invalidate();
    this.appliedScale = null;
  }

  read(
    layout: Protocol.Page.GetLayoutMetricsResponse,
    revision: number,
  ): InputGeometry | null {
    if (revision !== this.version) return null;
    if (this.appliedScale === null) return null;
    const viewport = layout.cssVisualViewport;
    if (!positive(viewport.clientWidth) || !positive(viewport.clientHeight))
      throw new CdpFault(
        "input",
        "The remote viewport is unavailable for input.",
      );
    this.transform ??= inputTransform(viewport.zoom ?? 1, this.appliedScale);
    return (
      this.input ??
      new InputGeometry(
        this.version,
        {
          width: viewport.clientWidth * this.appliedScale,
          height: viewport.clientHeight * this.appliedScale,
        },
        this.transform.wheelScale,
      )
    );
  }

  /** Null rejects an older capture; geometry is committed only after this image paints. */
  frame(metadata: unknown): (() => void) | null {
    const timestamp = isRecord(metadata) ? metadata.timestamp : null;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      if (timestamp < this.timestamp) return null;
      this.timestamp = timestamp;
    }
    const viewport = frameViewport(metadata);
    const version = this.version;
    return () => {
      if (version === this.version) this.painted = viewport;
    };
  }
}
