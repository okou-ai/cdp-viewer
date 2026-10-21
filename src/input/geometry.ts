import { isRecord } from "../cdp/errors";

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export function frameViewport(metadata: unknown): Viewport | null {
  if (!isRecord(metadata)) return null;
  const { deviceWidth, deviceHeight, pageScaleFactor } = metadata;
  if (
    ![deviceWidth, deviceHeight, pageScaleFactor].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const width = (deviceWidth as number) / (pageScaleFactor as number);
  const height = (deviceHeight as number) / (pageScaleFactor as number);
  return [width, height].every((value) => Number.isFinite(value) && value > 0)
    ? { width, height }
    : null;
}

/** Image-relative position, independent of JPEG resolution and client DPR. */
export function imagePoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  captured = false,
): Point | null {
  const box = canvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  const x = (clientX - box.left - (box.width - width) / 2) / width;
  const y = (clientY - box.top - (box.height - height) / 2) / height;
  if (!captured && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

export function localPoint(canvas: HTMLCanvasElement, point: Point): Point {
  const box = canvas.getBoundingClientRect();
  const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  return {
    x: (box.width - width) / 2 + point.x * width,
    y: (box.height - height) / 2 + point.y * height,
  };
}
