import type { Protocol } from "devtools-protocol";
import { NativeComposition } from "./composition";
import { NativeClipboard } from "./clipboard";
import type { ClipboardRecovery } from "./clipboard";
import type { InputOwner, InputTransition } from "./lifecycle";
import { imagePoint, localPoint } from "./geometry";
import type { Point } from "./geometry";
import type { NativeInputPort } from "./port";
import { sameDirection, samePointerState } from "./coalescing";

interface ContinuousPointer {
  input: NativeInputPort;
  owner: InputOwner;
  type: "mouseMoved" | "mouseWheel";
  point: Point;
  details: Parameters<NativeInputPort["pointer"]>[2];
}

const buttons = ["left", "middle", "right", "back", "forward"] as const;
const buttonMasks = [1, 4, 2, 8, 16] as const;
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
  private readonly composition = new NativeComposition();
  private resetting = false;
  private readonly forwarded = new Set<string>();
  private readonly clipboardKeys = new Set<string>();
  private pointerId: number | null = null;
  private readonly pressedButtons = new Set<number>();
  private pointerFrame: number | null = null;
  private continuous: ContinuousPointer | null = null;
  private readonly lifetime = new AbortController();
  private readonly clipboard: NativeClipboard;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly proxy: HTMLTextAreaElement,
    private readonly input: () => NativeInputPort | null,
    private readonly releaseFocus: () => void,
    clipboardChanged: (value: ClipboardRecovery | null) => void = () => {},
  ) {
    const signal = this.lifetime.signal;
    for (const type of ["copy", "paste", "cut"])
      proxy.addEventListener(type, this.flushContinuous, {
        signal,
        capture: true,
      });
    this.clipboard = new NativeClipboard(
      proxy,
      input,
      () => this.composition.composing,
      clipboardChanged,
      signal,
    );
    const stage = canvas.parentElement;
    if (!stage) throw new Error("Input requires an owned stage.");
    stage.addEventListener("pointerdown", this.pointerDown, { signal });
    stage.addEventListener("mousedown", this.mouseDown, { signal });
    window.addEventListener("mouseup", this.mouseUp, { signal });
    stage.addEventListener("pointermove", this.pointerMove, { signal });
    stage.addEventListener("pointerup", this.pointerUp, { signal });
    stage.addEventListener("pointercancel", this.cancel, { signal });
    stage.addEventListener("lostpointercapture", this.lostCapture, { signal });
    stage.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal,
    });
    stage.addEventListener("auxclick", (e) => e.preventDefault(), { signal });
    stage.addEventListener("wheel", this.wheel, { signal, passive: false });
    proxy.addEventListener(
      "focus",
      () => {
        // A pointer gesture establishes remote focus after its release. Avoid
        // querying the previous control before that click has reached Chrome.
        if (this.pointerId === null) {
          this.flushContinuous();
          this.input()?.focus();
        }
      },
      { signal },
    );
    proxy.addEventListener("blur", this.cancel, { signal });
    proxy.addEventListener("keydown", this.keyDown, { signal });
    proxy.addEventListener("keyup", this.keyUp, { signal });
    proxy.addEventListener(
      "compositionstart",
      () => {
        this.flushContinuous();
        this.composition.start(
          document.activeElement === this.proxy
            ? (this.input()?.owner ?? null)
            : null,
          this.proxy.value,
          this.proxy.selectionStart,
          this.proxy.selectionEnd,
        );
        // Leave the native value alone while an OS composition is starting.
      },
      { signal },
    );
    proxy.addEventListener("compositionupdate", this.compositionUpdate, {
      signal,
    });
    proxy.addEventListener("compositionend", this.compositionEnd, { signal });
    proxy.addEventListener("input", this.text, { signal });
    proxy.addEventListener("select", this.selection, { signal });
    window.addEventListener("blur", this.cancel, { signal });
  }

  reset(reason?: InputTransition): void {
    if (this.resetting) return;
    this.resetting = true;
    try {
      this.clipboard.reset(reason === "blur");
      this.composition.reset();
      this.proxy.value = "";
      this.forwarded.clear();
      this.clipboardKeys.clear();
      this.clearContinuous();
      const pointer = this.pointerId;
      this.pointerId = null;
      this.pressedButtons.clear();
      if (
        pointer !== null &&
        this.canvas.parentElement?.hasPointerCapture(pointer)
      ) {
        this.canvas.parentElement.releasePointerCapture(pointer);
      }
      // Same-tab cleanup invalidates old input without ending local focus.
      if (
        reason !== "navigation-started" &&
        reason !== "same-document" &&
        reason !== "document-lost" &&
        reason !== "failed"
      )
        this.proxy.blur();
    } finally {
      this.resetting = false;
    }
  }

  clearClipboard(): void {
    this.clipboard.reset();
  }

  copyClipboard(): void {
    this.clipboard.copyRecovery();
  }

  dispose(): void {
    this.lifetime.abort();
    this.input()?.blur();
    this.reset();
  }

  place(point: Point): void {
    const local = localPoint(this.canvas, point);
    if (![local.x, local.y].every(Number.isFinite)) return;
    this.proxy.style.left = `${local.x}px`;
    this.proxy.style.top = `${Math.max(0, local.y - 20)}px`;
  }

  private readonly cancel = () => {
    if (this.resetting) return;
    this.input()?.blur();
    this.reset("blur");
  };

  private readonly lostCapture = () => {
    if (this.pointerId !== null) this.cancel();
  };

  private readonly pointerDown = (event: PointerEvent) => {
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    const input = this.input();
    if (!point || !input || event.pointerType !== "mouse") return;
    if (this.composition.composing) {
      input.blur();
      this.reset();
    }
    // The press already supplies this position. Do not insert a deferred hover
    // between its press/release; held-button drag movement must still flush.
    if (
      !this.pressedButtons.size &&
      this.continuous?.type === "mouseMoved" &&
      this.continuous.details.buttons === 0 &&
      this.continuous.details.modifiers === modifiers(event) &&
      this.continuous.point.x === point.x &&
      this.continuous.point.y === point.y
    )
      this.clearContinuous();
    this.flushContinuous();
    // Preserve queued gestures, held modifiers and the consumed composition
    // boundary for another click in the same viewer. The ordered press follows
    // preceding committed input on the same CDP session.
    this.place(point);
    this.pointerId = event.pointerId;
    this.proxy.focus({ preventScroll: true });
    this.canvas.parentElement?.setPointerCapture(event.pointerId);
  };

  private readonly mouseDown = (event: MouseEvent) => {
    if (this.pointerId === null) return;
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    if (!point) return;
    // PointerEvent.detail is zero. The compatibility mouse event supplies the
    // browser/OS click count, including native double/triple-click settings.
    event.preventDefault();
    this.flushContinuous();
    this.pressedButtons.add(event.button);
    this.input()?.pointer("mousePressed", point, {
      button: buttons[event.button] ?? "left",
      buttons: this.ownedButtons(event.buttons),
      modifiers: modifiers(event),
      clickCount: event.detail,
    });
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const held = this.ownedButtons(event.buttons);
    const point = imagePoint(
      this.canvas,
      event.clientX,
      event.clientY,
      this.pointerId !== null,
    );
    if (point)
      this.bufferContinuous("mouseMoved", point, {
        button:
          held & 1 ? "left" : held & 2 ? "right" : held & 4 ? "middle" : "none",
        buttons: held,
        modifiers: modifiers(event),
      });
  };

  private bufferContinuous(
    type: ContinuousPointer["type"],
    point: Point,
    details: ContinuousPointer["details"],
  ): void {
    const input = this.input();
    const owner = input?.owner;
    if (!input || !owner) return;
    const previous = this.continuous;
    if (
      previous?.input === input &&
      previous.owner === owner &&
      previous.type === type &&
      samePointerState(previous.details, details)
    ) {
      if (type === "mouseMoved") {
        previous.point = point;
        previous.details = details;
        return;
      }
      const deltaX = details.deltaX ?? 0;
      const deltaY = details.deltaY ?? 0;
      const previousX = previous.details.deltaX ?? 0;
      const previousY = previous.details.deltaY ?? 0;
      const combinedX = previousX + deltaX;
      const combinedY = previousY + deltaY;
      if (
        previous.point.x === point.x &&
        previous.point.y === point.y &&
        sameDirection(previousX, deltaX) &&
        sameDirection(previousY, deltaY) &&
        [combinedX, combinedY].every(Number.isFinite)
      ) {
        previous.details.deltaX = combinedX;
        previous.details.deltaY = combinedY;
        return;
      }
    }
    this.flushContinuous();
    // Flushing may synchronously fail and replace the current input owner.
    if (this.input() !== input || input.owner !== owner) return;
    const pending = { input, owner, type, point, details };
    this.continuous = pending;
    this.pointerFrame = requestAnimationFrame(() => {
      if (this.continuous === pending) this.flushContinuous();
    });
  }

  private readonly flushContinuous = () => {
    const pending = this.continuous;
    this.clearContinuous();
    if (
      pending &&
      this.input() === pending.input &&
      pending.input.owner === pending.owner
    )
      pending.input.pointer(pending.type, pending.point, pending.details);
  };

  private clearContinuous(): void {
    this.continuous = null;
    if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
  }

  private readonly pointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.flushContinuous();
    this.pointerId = null;
    if (this.canvas.parentElement?.hasPointerCapture(event.pointerId)) {
      this.canvas.parentElement.releasePointerCapture(event.pointerId);
    }
  };

  private ownedButtons(physical: number): number {
    let owned = 0;
    for (const button of this.pressedButtons) owned |= buttonMasks[button] ?? 0;
    return physical & owned;
  }

  private readonly mouseUp = (event: MouseEvent) => {
    // Mouseup occurs for every released button, including a chord's non-final
    // button. The window listener also owns release outside the captured stage.
    if (!this.pressedButtons.has(event.button)) return;
    event.preventDefault();
    this.flushContinuous();
    this.pressedButtons.delete(event.button);
    const point = imagePoint(this.canvas, event.clientX, event.clientY, true);
    if (point)
      this.input()?.pointer("mouseReleased", point, {
        button: buttons[event.button] ?? "left",
        buttons: this.ownedButtons(event.buttons),
        modifiers: modifiers(event),
        clickCount: event.detail,
      });
  };

  private readonly wheel = (event: WheelEvent) => {
    const point = imagePoint(this.canvas, event.clientX, event.clientY);
    if (!point || !this.input()) return;
    event.preventDefault();
    event.stopPropagation();
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.canvas.clientHeight
          : 1;
    this.bufferContinuous("mouseWheel", point, {
      buttons: this.ownedButtons(event.buttons),
      modifiers: modifiers(event),
      deltaX: event.deltaX * unit,
      deltaY: event.deltaY * unit,
    });
  };

  private readonly compositionUpdate = (event: CompositionEvent) => {
    this.flushContinuous();
    const input = this.input();
    const owner =
      document.activeElement === this.proxy ? (input?.owner ?? null) : null;
    const preedit = this.composition.update(event.data, owner);
    if (preedit && owner)
      input?.preedit(
        preedit.text,
        owner,
        preedit.selectionStart,
        preedit.selectionEnd,
      );
  };

  private readonly compositionEnd = (event: CompositionEvent) => {
    this.flushContinuous();
    const input = this.input();
    const owner =
      document.activeElement === this.proxy ? (input?.owner ?? null) : null;
    const composed = this.composition.owns(owner);
    const result = this.composition.end(event.data, owner);
    this.proxy.value = result.value;
    if (owner)
      this.proxy.setSelectionRange(result.value.length, result.value.length);
    if (composed && owner) input?.commitComposition(result.text, owner);
  };

  private readonly text = (event: Event) => {
    this.flushContinuous();
    const input = this.input();
    const owner =
      document.activeElement === this.proxy ? (input?.owner ?? null) : null;
    const result = this.composition.input(
      this.proxy.value,
      owner,
      event instanceof InputEvent &&
        (event.isComposing || event.inputType.includes("Composition")),
      event instanceof InputEvent && event.isComposing,
      this.proxy.selectionStart,
      this.proxy.selectionEnd,
    );
    if (result.keep) {
      if (result.preedit && owner)
        input?.preedit(
          result.preedit.text,
          owner,
          result.preedit.selectionStart,
          result.preedit.selectionEnd,
        );
      return;
    }
    this.proxy.value = "";
    if (result.text && owner) input?.text(result.text, owner);
  };

  private readonly selection = (event: Event) => {
    if (this.composition.composing) this.text(event);
  };

  private readonly keyDown = (event: KeyboardEvent) => {
    if (
      this.composition.composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      ["Dead", "Process", "Unidentified"].includes(event.key)
    )
      return;
    event.stopPropagation();
    if (event.key === "F8") {
      event.preventDefault();
      this.cancel();
      this.releaseFocus();
      return;
    }
    this.flushContinuous();
    const shortcut =
      (event.ctrlKey || event.metaKey) && !event.getModifierState("AltGraph");
    const printable = Array.from(event.key).length === 1;
    if (shortcut && ["c", "v", "x"].includes(event.key.toLowerCase()))
      this.clipboardKeys.add(event.code || event.key);
    // Clipboard events carry local gesture activation and the actual paste data.
    // Let the browser generate them; do not also send a remote C/V chord.
    if (shortcut && ["c", "v"].includes(event.key.toLowerCase())) return;
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
      event.preventDefault();
    if (shortcut && event.key.toLowerCase() === "x") return;
    const text =
      event.key === "Enter"
        ? "\r"
        : printable && !shortcut
          ? event.key
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
    this.forwarded.add(event.code || event.key);
    this.input()?.key(key);
  };

  private readonly keyUp = (event: KeyboardEvent) => {
    const id = event.code || event.key;
    const clipboard = this.clipboardKeys.delete(id);
    if (!this.forwarded.delete(id)) {
      if (clipboard) event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.flushContinuous();
    this.input()?.key({
      type: "keyUp",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: modifiers(event),
    });
  };
}
