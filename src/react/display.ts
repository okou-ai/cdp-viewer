import type { DisplaySize } from "../viewer/display";

/** Committed DOM observations; no transport or per-frame React updates. */
export function observeDisplay(
  canvas: HTMLCanvasElement,
  changed: (size: DisplaySize | null) => void,
): () => void {
  let active = true;
  let density: MediaQueryList | null = null;
  const measure = () => {
    if (!active) return;
    const box = canvas.getBoundingClientRect();
    changed(
      box.width > 0 && box.height > 0
        ? { width: box.width, height: box.height, dpr: window.devicePixelRatio }
        : null,
    );
  };
  const densityChanged = () => {
    if (!active) return;
    density?.removeEventListener("change", densityChanged);
    density =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        : null;
    density?.addEventListener("change", densityChanged);
    measure();
  };
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  observer?.observe(canvas);
  window.addEventListener("resize", measure);
  densityChanged();
  return () => {
    active = false;
    observer?.disconnect();
    density?.removeEventListener("change", densityChanged);
    window.removeEventListener("resize", measure);
  };
}
