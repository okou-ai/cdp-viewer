import type { KeyboardEvent, PointerEvent } from "react";
import type { ResizeGesture } from "./model";

type ResizePointer = PointerEvent<HTMLButtonElement>;
type Begin = (id: number, gesture: ResizeGesture) => boolean;
type Move = (
  id: number,
  pointerId: number,
  x: number,
  y: number,
  availableWidth: number,
) => boolean;
type End = (id: number, pointerId?: number) => number | null;

/** Read only this handle's committed demo stage, never the viewer's internals. */
function geometry(target: HTMLButtonElement) {
  const frame = target.parentElement;
  const stage = frame?.parentElement;
  if (!frame || !stage) return null;
  const style = getComputedStyle(stage);
  const availableWidth =
    stage.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight);
  if (availableWidth <= 0) return null;
  return { frame: frame.getBoundingClientRect(), availableWidth };
}

export function releaseResize(
  target: HTMLButtonElement,
  id: number,
  end: End,
  pointerId?: number,
) {
  const ended = end(id, pointerId);
  const captured = pointerId ?? ended;
  if (captured !== null && target.hasPointerCapture(captured))
    target.releasePointerCapture(captured);
}

export function beginResize(event: ResizePointer, id: number, begin: Begin) {
  if (!event.isPrimary || event.button !== 0) return;
  const box = geometry(event.currentTarget);
  if (
    !box ||
    !begin(id, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: box.frame.width,
      height: box.frame.height,
    })
  )
    return;
  event.preventDefault();
  event.currentTarget.focus({ preventScroll: true });
  event.currentTarget.setPointerCapture(event.pointerId);
}

export function moveResize(
  event: ResizePointer,
  id: number,
  move: Move,
  end: End,
) {
  const box = geometry(event.currentTarget);
  if (
    !box ||
    !move(id, event.pointerId, event.clientX, event.clientY, box.availableWidth)
  ) {
    releaseResize(event.currentTarget, id, end, event.pointerId);
  }
}

export function finishResize(
  event: ResizePointer,
  id: number,
  move: Move,
  end: End,
) {
  moveResize(event, id, move, end);
  releaseResize(event.currentTarget, id, end, event.pointerId);
}

export function resizeKey(
  event: KeyboardEvent<HTMLButtonElement>,
  id: number,
  nudge: (id: number, width: number, height: number) => number | null,
  end: End,
) {
  if (event.key === "Escape") {
    const pointerId = end(id);
    if (pointerId !== null) {
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(pointerId))
        event.currentTarget.releasePointerCapture(pointerId);
    }
    return;
  }
  const width = event.shiftKey ? 5 : 1;
  const height = event.shiftKey ? 40 : 10;
  let delta: readonly [number, number];
  switch (event.key) {
    case "ArrowLeft":
      delta = [-width, 0];
      break;
    case "ArrowRight":
      delta = [width, 0];
      break;
    case "ArrowUp":
      delta = [0, -height];
      break;
    case "ArrowDown":
      delta = [0, height];
      break;
    default:
      return;
  }
  event.preventDefault();
  const pointerId = nudge(id, ...delta);
  if (pointerId !== null && event.currentTarget.hasPointerCapture(pointerId))
    event.currentTarget.releasePointerCapture(pointerId);
}
