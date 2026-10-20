import type { Protocol } from "devtools-protocol";
import { imagePoint, localPoint } from "./geometry";
import type { Point } from "./geometry";
import type { InputSession } from "./session";

const buttons = ["left", "middle", "right", "back", "forward"] as const;
const controlKeys = new Set([
  " ",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

function modifiers(event: MouseEvent | KeyboardEvent): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** DOM listeners belong to this surface only; the textarea stays uncontrolled. */
export class NativeInput {
  private composing = false;
  private consumed = "";
  private readonly forwarded = new Set<string>();
  private pointerId: number | null = null;
  private moveFrame: number | null = null;
  private latestMove: PointerEvent | null = null;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly proxy: HTMLTextAreaElement,
    private readonly input: () => InputSession | null,
  ) {
    const signal = this.lifetime.signal;
    const stage = canvas.parentElement;
    if (!stage) throw new Error("Input requires an owned stage.");
    stage.addEventListener("pointerdown", this.pointerDown, { signal });
    stage.addEventListener("pointermove", this.pointerMove, { signal });
    stage.addEventListener("pointerup", this.pointerUp, { signal });
    stage.addEventListener("pointercancel", this.cancel, { signal });
    stage.addEventListener("lostpointercapture", this.lostCapture, { signal });
    stage.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal,
    });
    stage.addEventListener("wheel", this.wheel, { signal, passive: false });
    proxy.addEventListener(
      "focus",
      () => {
        // A pointer gesture establishes remote focus after its release. Avoid
        // querying the previous control before that click has reached Chrome.
        if (this.pointerId === null) this.input()?.focus();
      },
      { signal },
    );
    proxy.addEventListener("blur", this.cancel, { signal });
    proxy.addEventListener("keydown", this.keyDown, { signal });
    proxy.addEventListener("keyup", this.keyUp, { signal });
    proxy.addEventListener(
      "compositionstart",
      () => {
        this.composing = true;
        this.consumed = "";
        // Leave the native value alone while an OS composition is starting.
      },
      { signal },
    );
    proxy.addEventListener("compositionend", this.compositionEnd, { signal });
    proxy.addEventListener("input", this.text, { signal });
    for (const event of ["copy", "cut", "paste"] as const) {
      proxy.addEventListener(event, (e) => e.preventDefault(), { signal });
    }
    window.addEventListener("blur", this.cancel, { signal });
  }

  reset(): void {
    this.composing = false;
    this.consumed = "";
    this.proxy.value = "";
    this.forwarded.clear();
    this.latestMove = null;
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
    const pointer = this.pointerId;
    this.pointerId = null;
    if (
      pointer !== null &&
      this.canvas.parentElement?.hasPointerCapture(pointer)
    ) {
      this.canvas.parentElement.releasePointerCapture(pointer);
    }
    this.proxy.blur();
  }

  dispose(): void {
    this.input()?.blur();
    this.reset();
    this.lifetime.abort();
  }

  place(point: Point): void {
    const local = localPoint(this.canvas, point);
    if (![local.x, local.y].every(Number.isFinite)) return;
    this.proxy.style.left = `${local.x}px`;
    this.proxy.style.top = `${Math.max(0, local.y - 20)}px`;
  }

  private readonly cancel = () => {
    this.input()?.blur();
    this.reset();
  };

  private readonly lostCapture = () => {
    if (this.pointerId !== null) this.cancel();
  };

  private readonly pointerDown = (event: PointerEvent) => {
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    const input = this.input();
    if (!point || !input || event.pointerType !== "mouse") return;
    event.preventDefault();
    input.blur();
    this.reset();
    this.place(point);
    this.pointerId = event.pointerId;
    this.proxy.focus({ preventScroll: true });
    this.canvas.parentElement?.setPointerCapture(event.pointerId);
    input.pointer("mousePressed", point, {
      button: buttons[event.button] ?? "left",
      buttons: event.buttons,
      modifiers: modifiers(event),
      clickCount: event.detail || 1,
    });
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    this.latestMove = event;
    if (this.moveFrame === null)
      this.moveFrame = requestAnimationFrame(this.flushMove);
  };

  private readonly flushMove = () => {
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
    const event = this.latestMove;
    this.latestMove = null;
    if (!event) return;
    const point = imagePoint(
      this.canvas,
      event.clientX,
      event.clientY,
      this.pointerId !== null,
    );
    if (point)
      this.input()?.pointer("mouseMoved", point, {
        button:
          event.buttons & 1
            ? "left"
            : event.buttons & 2
              ? "right"
              : event.buttons & 4
                ? "middle"
                : "none",
        buttons: event.buttons,
        modifiers: modifiers(event),
      });
  };

  private readonly pointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.flushMove();
    const point = imagePoint(this.canvas, event.clientX, event.clientY, true);
    this.pointerId = null;
    if (this.canvas.parentElement?.hasPointerCapture(event.pointerId)) {
      this.canvas.parentElement.releasePointerCapture(event.pointerId);
    }
    if (point)
      this.input()?.pointer("mouseReleased", point, {
        button: buttons[event.button] ?? "left",
        buttons: event.buttons,
        modifiers: modifiers(event),
        clickCount: event.detail || 1,
      });
  };

  private readonly wheel = (event: WheelEvent) => {
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    if (!point || !this.input()) return;
    event.preventDefault();
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.canvas.clientHeight
          : 1;
    this.input()?.pointer("mouseWheel", point, {
      modifiers: modifiers(event),
      deltaX: event.deltaX * unit,
      deltaY: event.deltaY * unit,
    });
  };

  private readonly compositionEnd = (event: CompositionEvent) => {
    if (!this.composing || document.activeElement !== this.proxy) return;
    this.composing = false;
    // Preserve the consumed value until the browser's final input event. Reading
    // the value delta also preserves a subsequent identical character.
    this.consumed = event.data;
    this.proxy.value = event.data;
    this.proxy.setSelectionRange(event.data.length, event.data.length);
    if (event.data) this.input()?.text(event.data);
  };

  private readonly text = (event: Event) => {
    if (
      this.composing ||
      (event instanceof InputEvent && event.isComposing) ||
      document.activeElement !== this.proxy
    )
      return;
    const value = this.proxy.value;
    const text =
      this.consumed && value.startsWith(this.consumed)
        ? value.slice(this.consumed.length)
        : value;
    this.consumed = "";
    this.proxy.value = "";
    if (text) this.input()?.text(text);
  };

  private readonly keyDown = (event: KeyboardEvent) => {
    if (
      this.composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      ["Dead", "Process", "Unidentified"].includes(event.key)
    )
      return;
    if (event.key === "F8") {
      event.preventDefault();
      this.cancel();
      this.canvas
        .closest(".cdpv-root")
        ?.querySelector<HTMLSelectElement>(".cdpv-toolbar select")
        ?.focus();
      return;
    }
    const shortcut =
      (event.ctrlKey || event.metaKey) && !event.getModifierState("AltGraph");
    if (!controlKeys.has(event.key) && !shortcut) return;
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
      event.preventDefault();
    if (shortcut && ["c", "v", "x"].includes(event.key.toLowerCase())) return;
    const text =
      event.key === "Enter"
        ? "\r"
        : event.key === " " && !shortcut
          ? " "
          : undefined;
    const key: Protocol.Input.DispatchKeyEventRequest = {
      type: text === undefined ? "rawKeyDown" : "keyDown",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: modifiers(event),
      autoRepeat: event.repeat,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    };
    if (shortcut) {
      const letter = event.key.toLowerCase();
      if (letter === "a") key.commands = ["selectAll"];
      else if (letter === "z")
        key.commands = [event.shiftKey ? "redo" : "undo"];
      else if (letter === "y") key.commands = ["redo"];
    }
    this.forwarded.add(event.code);
    this.input()?.key(key);
  };

  private readonly keyUp = (event: KeyboardEvent) => {
    if (!this.forwarded.delete(event.code)) return;
    event.preventDefault();
    this.input()?.key({
      type: "keyUp",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: modifiers(event),
    });
  };
}
