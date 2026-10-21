import type { Protocol } from "devtools-protocol";
import type { Point } from "./geometry";

type Key = Protocol.Input.DispatchKeyEventRequest;
type Button = NonNullable<Protocol.Input.DispatchMouseEventRequest["button"]>;

/** Object identity also binds this token to its viewer/connection/session. */
export interface InputOwner {
  readonly sessionId: string;
  readonly document: number;
  readonly focus: number;
}

export type InputStop =
  "target-replaced" | "paused" | "disconnected" | "disposed";

export type InputTransition =
  | InputStop
  | "blur"
  | "navigation-started"
  | "same-document"
  | "document-lost"
  | "failed";

const policy = {
  blur: { release: true, documentLost: false, terminal: false },
  "navigation-started": { release: true, documentLost: false, terminal: false },
  "same-document": { release: true, documentLost: false, terminal: false },
  "document-lost": { release: false, documentLost: true, terminal: false },
  "target-replaced": { release: true, documentLost: false, terminal: true },
  paused: { release: true, documentLost: false, terminal: true },
  disconnected: { release: false, documentLost: false, terminal: true },
  disposed: { release: true, documentLost: false, terminal: true },
  failed: { release: true, documentLost: false, terminal: false },
} satisfies Record<
  InputTransition,
  { release: boolean; documentLost: boolean; terminal: boolean }
>;

type Focus =
  { kind: "idle" } | { kind: "pending" } | { kind: "active"; objectId: string };

/** State and cleanup decisions only: no DOM, sockets, callbacks or timers. */
export class InputLifecycle {
  private current: InputOwner;
  private closed = false;
  private focus: Focus = { kind: "idle" };
  private readonly keys = new Map<string, Key>();
  private readonly buttons = new Set<Button>();
  private point: Point = { x: 0, y: 0 };

  constructor(sessionId: string) {
    this.current = Object.freeze({ sessionId, document: 0, focus: 0 });
  }

  get owner(): InputOwner {
    return this.current;
  }

  get available(): boolean {
    return !this.closed;
  }

  owns(owner: InputOwner): boolean {
    return !this.closed && owner === this.current;
  }

  beginFocus(owner: InputOwner): string | null {
    if (!this.owns(owner)) return null;
    const previous = this.focus.kind === "active" ? this.focus.objectId : null;
    this.focus = { kind: "pending" };
    return previous;
  }

  acceptFocus(owner: InputOwner, objectId: string): void {
    if (this.owns(owner) && this.focus.kind === "pending")
      this.focus = { kind: "active", objectId };
  }

  focusedObject(owner: InputOwner): string | null {
    return this.owns(owner) && this.focus.kind === "active"
      ? this.focus.objectId
      : null;
  }

  pressKey(owner: InputOwner, key: Key): void {
    if (this.owns(owner)) this.keys.set(key.code ?? key.key ?? "", key);
  }

  releaseKey(owner: InputOwner, key: Key): void {
    if (this.owns(owner)) this.keys.delete(key.code ?? key.key ?? "");
  }

  pointer(owner: InputOwner, point: Point, pressed?: Button): void {
    if (!this.owns(owner)) return;
    this.point = point;
    if (pressed) this.buttons.add(pressed);
  }

  releaseButton(owner: InputOwner, button: Button): void {
    if (this.owns(owner)) this.buttons.delete(button);
  }

  transition(reason: InputTransition) {
    if (this.closed) return null;
    const rule = policy[reason];
    const cleanup = {
      owner: this.current,
      objectId: this.focus.kind === "active" ? this.focus.objectId : null,
      keys: rule.release ? [...this.keys.values()] : [],
      buttons: rule.release ? [...this.buttons] : [],
      point: this.point,
    };
    // Publish the new owner before running any effects, including DOM blur.
    this.current = Object.freeze({
      sessionId: this.current.sessionId,
      document: this.current.document + (rule.documentLost ? 1 : 0),
      focus: this.current.focus + 1,
    });
    this.closed = rule.terminal;
    this.focus = { kind: "idle" };
    this.keys.clear();
    this.buttons.clear();
    return cleanup;
  }
}
