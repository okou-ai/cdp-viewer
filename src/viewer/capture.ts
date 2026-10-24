import { CdpFault, isRecord } from "../cdp/errors";
import { positive } from "../display/geometry";
import type { DisplaySize } from "../display/geometry";
import { maximumFrameArea, maximumFrameDimension } from "../display/limits";
import type { ViewerCaptureOptions } from "./types";

export type CaptureSettings = Readonly<Required<ViewerCaptureOptions>>;

/** Bounded startup fallback until a committed surface can be measured. */
export const defaultCapture: CaptureSettings = Object.freeze({
  quality: 70,
  maxWidth: 1920,
  maxHeight: 1080,
});

function setting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new CdpFault(
      "configuration",
      `${field} must be an integer from ${min} to ${max}.`,
    );
  return value;
}

export function captureSettings(
  options?: ViewerCaptureOptions,
  size: DisplaySize | null = null,
): CaptureSettings {
  if (options !== undefined && !isRecord(options))
    throw new CdpFault(
      "configuration",
      "capture must be an image settings object.",
    );
  let bounds = defaultCapture;
  if (size && [size.width, size.height, size.dpr].every(positive)) {
    const scale = Math.min(
      size.dpr,
      maximumFrameDimension / size.width,
      maximumFrameDimension / size.height,
      Math.sqrt(maximumFrameArea / size.width / size.height),
    );
    bounds = {
      quality: defaultCapture.quality,
      maxWidth: Math.max(1, Math.floor(size.width * scale)),
      maxHeight: Math.max(1, Math.floor(size.height * scale)),
    };
  }
  const quality = setting(
    options?.quality,
    defaultCapture.quality,
    0,
    100,
    "capture.quality",
  );
  let maxWidth = setting(
    options?.maxWidth,
    bounds.maxWidth,
    1,
    maximumFrameDimension,
    "capture.maxWidth",
  );
  let maxHeight = setting(
    options?.maxHeight,
    bounds.maxHeight,
    1,
    maximumFrameDimension,
    "capture.maxHeight",
  );
  // Only automatic axes yield to the shared budget; fixed pairs are validated.
  if (options?.maxWidth === undefined)
    maxWidth = Math.min(maxWidth, Math.floor(maximumFrameArea / maxHeight));
  if (options?.maxHeight === undefined)
    maxHeight = Math.min(maxHeight, Math.floor(maximumFrameArea / maxWidth));
  if (maxWidth * maxHeight > maximumFrameArea)
    throw new CdpFault(
      "configuration",
      `capture.maxWidth × capture.maxHeight must not exceed ${maximumFrameArea} pixels.`,
    );
  return Object.freeze({ quality, maxWidth, maxHeight });
}

/** Retain omitted axes so they can follow the latest committed surface. */
export function capturePreferences(
  options?: ViewerCaptureOptions,
): ViewerCaptureOptions {
  const settings = captureSettings(options);
  return Object.freeze({
    quality: settings.quality,
    ...(options?.maxWidth === undefined ? {} : { maxWidth: settings.maxWidth }),
    ...(options?.maxHeight === undefined
      ? {}
      : { maxHeight: settings.maxHeight }),
  });
}

export function sameCapture(
  a: ViewerCaptureOptions,
  b: ViewerCaptureOptions,
): boolean {
  return (
    a.quality === b.quality &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight
  );
}
