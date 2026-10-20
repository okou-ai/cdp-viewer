import { afterEach, expect, it, vi } from "vitest";
import { CanvasRenderer } from "../../src/render/canvas";
import type { DecodedFrame } from "../../src/render/canvas";

afterEach(() => vi.restoreAllMocks());

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
