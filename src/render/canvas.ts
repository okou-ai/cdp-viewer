import { CdpFault } from "../cdp/errors";

export interface FrameSink {
  push(
    data: string,
    painted: () => void,
    failed: (error: CdpFault) => void,
  ): void;
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
  painted: () => void;
  failed: (error: CdpFault) => void;
}

async function decodeJpeg(data: string): Promise<DecodedFrame> {
  if (typeof createImageBitmap !== "function") {
    throw new CdpFault(
      "unsupported-capability",
      "This browser cannot decode live frames.",
    );
  }
  const base64 = Uint8Array as typeof Uint8Array & {
    fromBase64?: (value: string) => Uint8Array<ArrayBuffer>;
  };
  let bytes: Uint8Array<ArrayBuffer>;
  if (typeof base64.fromBase64 === "function") bytes = base64.fromBase64(data);
  else {
    const raw = atob(data);
    bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++)
      bytes[index] = raw.charCodeAt(index);
  }
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
    painted: () => void,
    failed: (error: CdpFault) => void,
  ): void {
    if (this.disposed) return;
    if (data.length > 12 * 1024 * 1024) {
      failed(new CdpFault("frame", "The browser sent an oversized frame."));
      return;
    }
    this.queued = { data, generation: this.generation, painted, failed };
    if (!this.decoding) void this.drain();
  }

  reset(): void {
    this.generation++;
    this.queued = null;
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
          decoded.width > 4096 ||
          decoded.height > 4096
        ) {
          throw new CdpFault(
            "frame",
            "The browser sent invalid frame dimensions.",
          );
        }
        if (this.canvas.width !== decoded.width)
          this.canvas.width = decoded.width;
        if (this.canvas.height !== decoded.height)
          this.canvas.height = decoded.height;
        this.context.drawImage(decoded.source, 0, 0);
        frame.painted();
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
