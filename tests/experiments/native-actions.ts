import type { Protocol } from "devtools-protocol";
import { isRecord } from "../../src/cdp/errors";
import type { Point } from "../../src/input/geometry";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
type Details = Pick<
  Mouse,
  "button" | "buttons" | "clickCount" | "modifiers" | "deltaX" | "deltaY"
>;
export type NativeAction =
  | { kind: "text"; text: string }
  | { kind: "key"; key: Protocol.Input.DispatchKeyEventRequest }
  | { kind: "pointer"; type: Mouse["type"]; point: Point; details: Details };

function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** Construct an allowlisted action; extra client fields never become CDP fields. */
function action(value: unknown): NativeAction | null {
  if (!isRecord(value)) return null;
  if (value.kind === "text")
    return typeof value.text === "string" &&
      value.text.length > 0 &&
      value.text.length <= 64 * 1024
      ? { kind: "text", text: value.text }
      : null;
  if (value.kind === "key" && isRecord(value.key)) {
    const key = value.key;
    if (
      !["rawKeyDown", "keyDown", "keyUp"].includes(String(key.type)) ||
      typeof key.key !== "string" ||
      key.key.length > 64 ||
      typeof key.code !== "string" ||
      key.code.length > 64 ||
      !Number.isInteger(key.windowsVirtualKeyCode) ||
      !finite(key.windowsVirtualKeyCode, 0, 255) ||
      !Number.isInteger(key.modifiers) ||
      !finite(key.modifiers, 0, 15) ||
      (key.text !== undefined &&
        (typeof key.text !== "string" || key.text.length > 64)) ||
      (key.unmodifiedText !== undefined &&
        (typeof key.unmodifiedText !== "string" ||
          key.unmodifiedText.length > 64)) ||
      (key.autoRepeat !== undefined && typeof key.autoRepeat !== "boolean") ||
      (key.commands !== undefined &&
        (!Array.isArray(key.commands) ||
          key.commands.length > 1 ||
          !key.commands.every((c) =>
            ["selectAll", "undo", "redo"].includes(String(c)),
          )))
    )
      return null;
    return {
      kind: "key",
      key: {
        type: key.type as "rawKeyDown" | "keyDown" | "keyUp",
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.windowsVirtualKeyCode,
        nativeVirtualKeyCode: key.windowsVirtualKeyCode,
        modifiers: key.modifiers,
        ...(typeof key.text === "string" ? { text: key.text } : {}),
        ...(typeof key.unmodifiedText === "string"
          ? { unmodifiedText: key.unmodifiedText }
          : {}),
        ...(typeof key.autoRepeat === "boolean"
          ? { autoRepeat: key.autoRepeat }
          : {}),
        ...(Array.isArray(key.commands)
          ? { commands: key.commands as string[] }
          : {}),
      },
    };
  }
  if (
    value.kind !== "pointer" ||
    !isRecord(value.point) ||
    !isRecord(value.details)
  )
    return null;
  const { point, details } = value;
  if (
    !["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(
      String(value.type),
    ) ||
    !finite(point.x, 0, 1) ||
    !finite(point.y, 0, 1) ||
    !Number.isInteger(details.modifiers) ||
    !finite(details.modifiers, 0, 15) ||
    (details.button !== undefined &&
      (typeof details.button !== "string" ||
        !["none", "left", "middle", "right", "back", "forward"].includes(
          details.button,
        ))) ||
    (["mousePressed", "mouseReleased"].includes(String(value.type)) &&
      (!details.button || details.button === "none")) ||
    (details.buttons !== undefined &&
      (!Number.isInteger(details.buttons) ||
        !finite(details.buttons, 0, 31))) ||
    (details.clickCount !== undefined &&
      (!Number.isInteger(details.clickCount) ||
        !finite(details.clickCount, 0, 2_147_483_647))) ||
    (value.type === "mouseWheel" &&
      (!finite(details.deltaX, -1_000_000, 1_000_000) ||
        !finite(details.deltaY, -1_000_000, 1_000_000)))
  )
    return null;
  return {
    kind: "pointer",
    type: value.type as Mouse["type"],
    point: { x: point.x, y: point.y },
    details: {
      modifiers: details.modifiers,
      ...(details.button !== undefined
        ? { button: details.button as NonNullable<Mouse["button"]> }
        : {}),
      ...(typeof details.buttons === "number"
        ? { buttons: details.buttons }
        : {}),
      ...(typeof details.clickCount === "number"
        ? { clickCount: details.clickCount }
        : {}),
      ...(value.type === "mouseWheel"
        ? { deltaX: Number(details.deltaX), deltaY: Number(details.deltaY) }
        : {}),
    },
  };
}

export function nativeActions(value: unknown): NativeAction[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    return null;
  const result = value.map(action);
  return result.every((item) => item !== null) ? result : null;
}
