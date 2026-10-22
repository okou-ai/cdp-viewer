import type { Protocol } from "devtools-protocol";
import { isRecord } from "../../src/cdp/errors";
import { navigationAddress } from "../../src/input/address";
import { clipboardTextLimit } from "../../src/input/selection";
import type { SelectionResult } from "../../src/input/selection";
import type { Point } from "../../src/input/geometry";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
type Details = Pick<
  Mouse,
  "button" | "buttons" | "clickCount" | "modifiers" | "deltaX" | "deltaY"
>;
export type NavigationAction = "back" | "forward" | "reload" | { url: string };
export type NativeAction =
  | { kind: "text"; text: string }
  | { kind: "key"; key: Protocol.Input.DispatchKeyEventRequest }
  | { kind: "pointer"; type: Mouse["type"]; point: Point; details: Details }
  | {
      kind: "preedit";
      text: string;
      selectionStart: number;
      selectionEnd: number;
    }
  | { kind: "commit"; text: string }
  | { kind: "selection"; request: number }
  | { kind: "navigate"; action: NavigationAction };

export function selectionResult(value: unknown): SelectionResult | null {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !["ok", "empty", "unsupported", "stale", "too-large"].includes(
      value.status,
    ) ||
    typeof value.text !== "string" ||
    value.text.length > clipboardTextLimit ||
    (value.status !== "ok" && value.text !== "")
  )
    return null;
  return {
    status: value.status as SelectionResult["status"],
    text: value.text,
  };
}

function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** Construct an allowlisted action; extra client fields never become CDP fields. */
function action(value: unknown, composition: boolean): NativeAction | null {
  if (!isRecord(value)) return null;
  if (composition && value.kind === "selection")
    return Number.isSafeInteger(value.request) && Number(value.request) > 0
      ? { kind: "selection", request: Number(value.request) }
      : null;
  if (composition && value.kind === "navigate") {
    if (
      typeof value.action === "string" &&
      ["back", "forward", "reload"].includes(value.action)
    )
      return {
        kind: "navigate",
        action: value.action as "back" | "forward" | "reload",
      };
    if (
      !isRecord(value.action) ||
      typeof value.action.url !== "string" ||
      value.action.url.length > 64 * 1024
    )
      return null;
    const url = navigationAddress(value.action.url);
    return url ? { kind: "navigate", action: { url } } : null;
  }
  if (composition && (value.kind === "preedit" || value.kind === "commit")) {
    if (typeof value.text !== "string" || value.text.length > 64 * 1024)
      return null;
    if (value.kind === "commit") return { kind: "commit", text: value.text };
    if (
      !Number.isInteger(value.selectionStart) ||
      !finite(value.selectionStart, 0, value.text.length) ||
      !Number.isInteger(value.selectionEnd) ||
      !finite(value.selectionEnd, value.selectionStart, value.text.length)
    )
      return null;
    return {
      kind: "preedit",
      text: value.text,
      selectionStart: value.selectionStart,
      selectionEnd: value.selectionEnd,
    };
  }
  if (value.kind === "text")
    return typeof value.text === "string" &&
      value.text.length > 0 &&
      value.text.length <= 64 * 1024
      ? { kind: "text", text: value.text }
      : null;
  if (value.kind === "key" && isRecord(value.key)) {
    const key = value.key;
    if (
      typeof key.type !== "string" ||
      !["rawKeyDown", "keyDown", "keyUp"].includes(key.type) ||
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
          !key.commands.every(
            (c) =>
              typeof c === "string" &&
              ["selectAll", "undo", "redo"].includes(c),
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
    typeof value.type !== "string" ||
    !["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(
      value.type,
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
    (["mousePressed", "mouseReleased"].includes(value.type) &&
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

export function nativeActions(
  value: unknown,
  composition = false,
): NativeAction[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    return null;
  const result = value.map((value) => action(value, composition));
  return result.every((item) => item !== null) &&
    result.every(
      (item, index) => item.kind !== "navigate" || index === result.length - 1,
    )
    ? result
    : null;
}
