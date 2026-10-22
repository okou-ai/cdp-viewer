import { afterEach, expect, it, vi } from "vitest";
import { CanvasRenderer } from "../../src/render/canvas";
import type { DecodedFrame } from "../../src/render/canvas";

const base64Descriptor = Object.getOwnPropertyDescriptor(
  Uint8Array,
  "fromBase64",
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (base64Descriptor)
    Object.defineProperty(Uint8Array, "fromBase64", base64Descriptor);
  else Reflect.deleteProperty(Uint8Array, "fromBase64");
});

function context() {
  const drawing = { clearRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    drawing as unknown as CanvasRenderingContext2D,
  );
  return drawing;
}
function bitmap(width = 4): DecodedFrame {
  return {
    source: document.createElement("canvas"),
    width,
    height: 4,
    close: vi.fn(),
  };
}
function deferred() {
  let resolve!: (value: DecodedFrame) => void;
  const promise = new Promise<DecodedFrame>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("bounds decode work to one active frame and one newest pending frame", async () => {
  const drawing = context();
  const first = deferred();
  const next = bitmap();
  const decode = vi.fn((data: string) =>
    data === "first" ? first.promise : Promise.resolve(next),
  );
  const renderer = new CanvasRenderer(document.createElement("canvas"), decode);
  const painted = vi.fn();
  renderer.push("first", painted, vi.fn());
  renderer.push("dropped", painted, vi.fn());
  renderer.push("newest", painted, vi.fn());
  expect(decode).toHaveBeenCalledTimes(1);
  const image = bitmap();
  first.resolve(image);
  await vi.waitFor(() => expect(painted).toHaveBeenCalledTimes(2));
  expect(decode.mock.calls.map((c) => c[0])).toEqual(["first", "newest"]);
  expect(image.close).toHaveBeenCalledTimes(1);
  expect(next.close).toHaveBeenCalledTimes(1);
  expect(drawing.drawImage).toHaveBeenCalledTimes(2);
  renderer.dispose();
});

it("closes old decoded images without painting after reset or disposal", async () => {
  const drawing = context();
  const wait = deferred();
  const image = bitmap();
  const renderer = new CanvasRenderer(
    document.createElement("canvas"),
    () => wait.promise,
  );
  const painted = vi.fn();
  renderer.push("old", painted, vi.fn());
  renderer.reset();
  renderer.dispose();
  wait.resolve(image);
  await vi.waitFor(() => expect(image.close).toHaveBeenCalledTimes(1));
  expect(drawing.drawImage).not.toHaveBeenCalled();
  expect(painted).not.toHaveBeenCalled();
});

it("reports invalid dimensions and closes the bitmap", async () => {
  const drawing = context();
  const image = bitmap(5000);
  const renderer = new CanvasRenderer(document.createElement("canvas"), () =>
    Promise.resolve(image),
  );
  const failure = vi.fn();
  renderer.push("invalid", vi.fn(), failure);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
  expect(drawing.drawImage).not.toHaveBeenCalled();
  expect(image.close).toHaveBeenCalledTimes(1);
  renderer.dispose();
});

it("checks actual decoded dimensions before drawing and commits only after draw", async () => {
  const drawing = context();
  const canvas = document.createElement("canvas");
  const first = deferred();
  const image = bitmap(12);
  const renderer = new CanvasRenderer(canvas, () => first.promise);
  let current = true;
  const accept = vi.fn(
    (raster: { width: number; height: number }) =>
      current && raster.width === 12 && raster.height === 4,
  );
  const painted = vi.fn();
  renderer.push("late", painted, vi.fn(), accept);
  current = false;
  first.resolve(image);
  await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
  expect(accept).toHaveBeenCalledWith({ width: 12, height: 4 });
  expect(drawing.drawImage).not.toHaveBeenCalled();
  expect(painted).not.toHaveBeenCalled();
  current = true;
  renderer.push(
    "current",
    (raster) => {
      expect(drawing.drawImage).toHaveBeenCalledOnce();
      expect(canvas.width).toBe(12);
      painted(raster);
    },
    vi.fn(),
    accept,
  );
  await vi.waitFor(() =>
    expect(painted).toHaveBeenCalledWith({ width: 12, height: 4 }),
  );
  renderer.dispose();
});

it.each([true, false])(
  "decodes JPEG bytes with native base64 available: %s",
  async (native) => {
    context();
    const bytes = new Uint8Array([0, 127, 128, 255]);
    const fromBase64 = vi.fn(() => bytes);
    const from = vi.spyOn(Uint8Array, "from");
    Object.defineProperty(Uint8Array, "fromBase64", {
      configurable: true,
      value: native ? fromBase64 : undefined,
    });
    const image = { width: 2, height: 2, close: vi.fn() };
    const decode = vi.fn(async (blob: Blob) => {
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      return image;
    });
    vi.stubGlobal("createImageBitmap", decode);
    const renderer = new CanvasRenderer(document.createElement("canvas"));
    const painted = vi.fn();
    const failed = vi.fn();
    renderer.push("AH+A/w==", painted, failed);
    await vi.waitFor(() => expect(painted).toHaveBeenCalledOnce());
    expect(failed).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(fromBase64).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(image.close).toHaveBeenCalledOnce();
    renderer.dispose();
  },
);
