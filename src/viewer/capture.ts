import { CdpFault, isRecord } from "../cdp/errors";
import { maximumFrameDimension } from "../display/limits";
import type { ViewerCaptureOptions } from "./types";

export type CaptureSettings = Readonly<Required<ViewerCaptureOptions>>;

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
  highDensity = false,
): CaptureSettings {
  if (options !== undefined && !isRecord(options))
    throw new CdpFault(
      "configuration",
      "capture must be an image settings object.",
    );
  const quality = setting(
    options?.quality,
    defaultCapture.quality,
    0,
    100,
    "capture.quality",
  );
  const maxWidth = setting(
    options?.maxWidth,
    highDensity ? maximumFrameDimension : defaultCapture.maxWidth,
    1,
    maximumFrameDimension,
    "capture.maxWidth",
  );
  const maxHeight = setting(
    options?.maxHeight,
    highDensity ? maximumFrameDimension : defaultCapture.maxHeight,
    1,
    maximumFrameDimension,
    "capture.maxHeight",
  );
  return Object.freeze({ quality, maxWidth, maxHeight });
}

/** Retain omitted bounds so explicit display adaptation keeps its existing profile. */
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

export function sameCapture(a: CaptureSettings, b: CaptureSettings): boolean {
  return (
    a.quality === b.quality &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight
  );
}
