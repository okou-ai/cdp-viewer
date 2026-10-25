import { CdpFault } from "../cdp/errors";
import type { BrowserByteArrayConstructor } from "../browser";
import {
  maximumEncodedFrameLength,
  maximumFrameArea,
  maximumFrameDimension,
} from "../display/limits";
import type { Viewport } from "../display/geometry";

export interface FrameSink {
  push(
    data: string,
    painted: (raster: Viewport) => void,
    failed: (error: CdpFault) => void,
    accept?: (raster: Viewport) => boolean,
  ): void;
  invalidate(): void;
  reset(): void;
  dispose(): void;
}

export interface DecodedFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

type Decode = (data: string) => Promise<DecodedFrame>;
interface QueuedFrame {
  data: string;
  generation: number;
  painted: (raster: Viewport) => void;
  failed: (error: CdpFault) => void;
  accept: ((raster: Viewport) => boolean) | undefined;
}

async function decodeJpeg(data: string): Promise<DecodedFrame> {
  const bytes = (Uint8Array as BrowserByteArrayConstructor).fromBase64(data);
  const image = await createImageBitmap(
    new Blob([bytes], { type: "image/jpeg" }),
  );
  return {
    source: image,
    width: image.width,
    height: image.height,
    close: () => image.close(),
  };
}

/** One active decode and one latest queued frame; no per-frame React state. */
export class CanvasRenderer implements FrameSink {
  private readonly context: CanvasRenderingContext2D;
  private generation = 0;
  private queued: QueuedFrame | null = null;
  private decoding = false;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly decode: Decode = decodeJpeg,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new CdpFault("frame", "Canvas 2D is unavailable.");
    this.context = context;
  }

  push(
    data: string,
    painted: (raster: Viewport) => void,
    failed: (error: CdpFault) => void,
    accept?: (raster: Viewport) => boolean,
  ): void {
    if (this.disposed) return;
    if (data.length > maximumEncodedFrameLength) {
      failed(new CdpFault("frame", "The browser sent an oversized frame."));
      return;
    }
    this.queued = {
      data,
      generation: this.generation,
      painted,
      failed,
      accept,
    };
    if (!this.decoding) {
      const generation = this.generation;
      this.drain().catch(() => {
        if (!this.disposed && generation === this.generation)
          failed(
            new CdpFault("frame", "The live frame could not be rendered."),
          );
      });
    }
  }

  invalidate(): void {
    this.generation++;
    this.queued = null;
  }

  reset(): void {
    this.invalidate();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private async drain(): Promise<void> {
    this.decoding = true;
    while (this.queued && !this.disposed) {
      const frame = this.queued;
      this.queued = null;
      let decoded: DecodedFrame | undefined;
      try {
        decoded = await this.decode(frame.data);
        if (this.disposed || frame.generation !== this.generation) continue;
        if (
          decoded.width < 1 ||
          decoded.height < 1 ||
          decoded.width > maximumFrameDimension ||
          decoded.height > maximumFrameDimension ||
          decoded.width * decoded.height > maximumFrameArea
        ) {
          throw new CdpFault(
            "frame",
            "The browser sent invalid frame dimensions.",
          );
        }
        const raster = { width: decoded.width, height: decoded.height };
        if (frame.accept && !frame.accept(raster)) continue;
        if (this.canvas.width !== decoded.width)
          this.canvas.width = decoded.width;
        if (this.canvas.height !== decoded.height)
          this.canvas.height = decoded.height;
        this.context.drawImage(decoded.source, 0, 0);
        frame.painted(raster);
      } catch (error) {
        if (!this.disposed && frame.generation === this.generation) {
          frame.failed(
            error instanceof CdpFault
              ? error
              : new CdpFault(
                  "frame",
                  "The browser frame could not be decoded.",
                ),
          );
        }
      } finally {
        decoded?.close();
      }
    }
    this.decoding = false;
  }
}
