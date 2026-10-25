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
function bitmap(width = 4, height = 4): DecodedFrame {
  return {
    source: document.createElement("canvas"),
    width,
    height,
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

it.each([
  [5000, 4],
  [4096, 4096],
  [4096, 2026],
  [2026, 4096],
])(
  "rejects an oversized %ix%i decoded frame and closes its bitmap",
  async (width, height) => {
    const drawing = context();
    const image = bitmap(width, height);
    const canvas = document.createElement("canvas");
    const previous = { width: canvas.width, height: canvas.height };
    const renderer = new CanvasRenderer(canvas, () => Promise.resolve(image));
    const failure = vi.fn();
    const painted = vi.fn();
    renderer.push("invalid", painted, failure);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "frame" }),
    );
    expect(drawing.drawImage).not.toHaveBeenCalled();
    expect(painted).not.toHaveBeenCalled();
    expect({ width: canvas.width, height: canvas.height }).toEqual(previous);
    expect(image.close).toHaveBeenCalledTimes(1);
    renderer.dispose();
  },
);

it.each([
  [3840, 2160],
  [4096, 2025],
  [2025, 4096],
])(
  "paints a %ix%i frame at the common pixel ceiling",
  async (width, height) => {
    const drawing = context();
    const image = bitmap(width, height);
    const canvas = document.createElement("canvas");
    const renderer = new CanvasRenderer(canvas, () => Promise.resolve(image));
    const painted = vi.fn();
    const failed = vi.fn();
    renderer.push("bounded", painted, failed);
    await vi.waitFor(() => expect(painted).toHaveBeenCalledOnce());
    expect(painted).toHaveBeenCalledWith({ width, height });
    expect(failed).not.toHaveBeenCalled();
    expect(drawing.drawImage).toHaveBeenCalledOnce();
    expect({ width: canvas.width, height: canvas.height }).toEqual({
      width,
      height,
    });
    expect(image.close).toHaveBeenCalledOnce();
    renderer.dispose();
  },
);

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

it("invalidates decode work while retaining the displayed image during capture updates", async () => {
  const drawing = context();
  const wait = deferred();
  const old = bitmap(8);
  const renderer = new CanvasRenderer(
    document.createElement("canvas"),
    (data) => (data === "pending" ? wait.promise : Promise.resolve(bitmap())),
  );
  renderer.push("visible", vi.fn(), vi.fn());
  await vi.waitFor(() => expect(drawing.drawImage).toHaveBeenCalledOnce());
  const painted = vi.fn();
  renderer.push("pending", painted, vi.fn());
  renderer.invalidate();
  expect(drawing.clearRect).not.toHaveBeenCalled();
  renderer.push("replacement", painted, vi.fn());
  wait.resolve(old);
  await vi.waitFor(() => expect(drawing.drawImage).toHaveBeenCalledTimes(2));
  expect(old.close).toHaveBeenCalledOnce();
  expect(painted).toHaveBeenCalledOnce();
  renderer.dispose();
});

it("decodes JPEG bytes with the required native base64 API", async () => {
  context();
  const bytes = new Uint8Array([0, 127, 128, 255]);
  const fromBase64 = vi.fn(() => bytes);
  const from = vi.spyOn(Uint8Array, "from");
  Object.defineProperty(Uint8Array, "fromBase64", {
    configurable: true,
    value: fromBase64,
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
  expect(fromBase64).toHaveBeenCalledOnce();
  expect(image.close).toHaveBeenCalledOnce();
  renderer.dispose();
});
