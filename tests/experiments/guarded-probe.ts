import { randomUUID } from "node:crypto";
import type { Protocol } from "devtools-protocol";
import { CdpClient } from "../../src/cdp/client";
import type { SocketFactory } from "../../src/cdp/client";
import { isRecord } from "../../src/cdp/errors";
import { TargetDirectory } from "../../src/cdp/targets";
import { InputSession } from "../../src/input/session";
import type {
  InputOwner,
  InputStop,
  InputTransition,
} from "../../src/input/lifecycle";
import { compositionMessageLimit, nativeActions } from "./native-actions";
import type { SelectionResult } from "../../src/input/selection";
import type { ViewerNavigation } from "../../src/viewer/types";

type Key = Protocol.Input.DispatchKeyEventRequest;
type Intent = { kind: "key"; key: Key } | { kind: "text"; text: string };
export type ProbeMode = "keys" | "native" | "composition";
export type ProbeReply =
  | { type: "ack"; sequence: number; ok: boolean; generation?: string }
  | { type: "revoked" }
  | {
      type: "selection";
      generation: string;
      request: number;
      result: SelectionResult | null;
    }
  | { type: "clipboard-reset"; generation: string; through: number }
  | { type: "navigation"; generation: string; value: ViewerNavigation | null }
  | {
      type: "suspended";
      previous: string;
      generation: string;
      reason: InputTransition;
      document: number;
      focus: number;
    }
  | { type: "ready"; generation: string; document: number; focus: number };

interface Trace {
  method: string;
  sent: number;
  response?: number;
  sequence?: number;
}

interface Hold {
  method: string;
  id?: number;
  held: () => void;
  release?: () => void;
}

interface NativeReply {
  done: Promise<boolean>;
  settle: (ok: boolean) => void;
}

function intent(value: Record<string, unknown>): Intent | null {
  if (value.kind === "text")
    return typeof value.text === "string" &&
      value.text.length > 0 &&
      value.text.length <= 64 * 1024
      ? { kind: "text", text: value.text }
      : null;
  const key = value.key;
  if (
    value.kind !== "key" ||
    !isRecord(key) ||
    (key.type !== "rawKeyDown" && key.type !== "keyUp") ||
    typeof key.key !== "string" ||
    key.key.length > 64 ||
    typeof key.code !== "string" ||
    key.code.length > 64 ||
    !Number.isInteger(key.modifiers) ||
    Number(key.modifiers) < 0 ||
    Number(key.modifiers) > 15 ||
    !Number.isInteger(key.windowsVirtualKeyCode) ||
    Number(key.windowsVirtualKeyCode) < 0 ||
    Number(key.windowsVirtualKeyCode) > 255
  )
    return null;
  return {
    kind: "key",
    key: {
      type: key.type,
      key: key.key,
      code: key.code,
      modifiers: Number(key.modifiers),
      windowsVirtualKeyCode: Number(key.windowsVirtualKeyCode),
      nativeVirtualKeyCode: Number(key.windowsVirtualKeyCode),
    },
  };
}

/** Test-only admission. This is neither an exposed service nor a public adapter. */
export class GuardedProbe {
  readonly owner = randomUUID();
  readonly trace: Trace[] = [];
  peakOutstanding = 0;
  private next = 1;
  private receivedThrough = 0;
  private completedThrough = 0;
  private readonly completed = new Set<number>();
  private stopped = false;
  private closed = false;
  private writeFailed = false;
  private imeSupported = false;
  private retirement: Promise<boolean> | undefined;
  private retirementFailed: (() => void) | undefined;
  private readonly native = new Map<number, NativeReply>();
  private readonly batches = new Map<number, number>();
  private ready = false;
  private transitioning = false;
  private transitionDeadline: ReturnType<typeof setTimeout> | undefined;
  private currentGeneration = randomUUID();
  private selectionThrough = 0;
  private currentNavigation: ViewerNavigation | null = null;
  private readonly outstanding = new Set<number>();
  private readonly waiting: number[] = [];
  private readonly requests = new Map<number, Trace>();
  private readonly client: CdpClient;
  private input: InputSession | null = null;
  private sessionId: string | null = null;
  private removeEvents: (() => void) | undefined;
  private hold: Hold | undefined;

  private constructor(
    endpoint: string,
    readonly targetId: string,
    private readonly mode: ProbeMode,
    private readonly transitionDeadlineMs: number,
    private readonly reply: (value: ProbeReply) => void,
    factory: SocketFactory,
  ) {
    this.client = new CdpClient(endpoint, (url) => {
      const socket = factory(url);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const command: unknown = JSON.parse(data);
          if (
            isRecord(command) &&
            typeof command.id === "number" &&
            typeof command.method === "string"
          ) {
            const row: Trace = { method: command.method, sent: Date.now() };
            if (
              !this.stopped &&
              ["Input.dispatchKeyEvent", "Input.insertText"].includes(
                command.method,
              )
            ) {
              const sequence = this.waiting.shift();
              if (sequence !== undefined) row.sequence = sequence;
            }
            this.trace.push(row);
            this.requests.set(command.id, row);
            if (
              command.method.startsWith("Input.") ||
              [
                "Page.navigate",
                "Page.reload",
                "Page.navigateToHistoryEntry",
              ].includes(command.method)
            ) {
              // Normal in-flight intent is capped at 64; cleanup gets one more
              // bounded window, never an unlimited receipt collection.
              if (this.native.size >= 128) {
                this.writeFailed = true;
                this.shutdown();
                return;
              }
              let settle!: (ok: boolean) => void;
              const done = new Promise<boolean>((resolve) => {
                settle = resolve;
              });
              this.native.set(command.id, { done, settle });
            }
            if (
              this.hold?.method === command.method &&
              this.hold.id === undefined
            )
              this.hold.id = command.id;
          }
        }
        send(data);
      };
      // Installed before CdpClient's listener: a hold blocks its real await.
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data !== "string") return;
        const response: unknown = JSON.parse(event.data);
        if (!isRecord(response) || typeof response.id !== "number") return;
        const hold = this.hold;
        if (hold?.id === response.id) {
          event.stopImmediatePropagation();
          const data = event.data;
          hold.release = () => {
            if (this.hold !== hold) return;
            this.hold = undefined;
            if (!this.closed)
              socket.dispatchEvent(new MessageEvent("message", { data }));
          };
          hold.held();
          return;
        }
        const row = this.requests.get(response.id);
        this.requests.delete(response.id);
        if (!row) return;
        row.response = Date.now();
        const native = this.native.get(response.id);
        if (native) {
          // Definite unsupported IME is the real session's final-text fallback,
          // not an uncertain native effect or permission/transport failure.
          const unsupported =
            this.mode === "composition" &&
            row.method === "Input.imeSetComposition" &&
            !this.imeSupported &&
            isRecord(response.error) &&
            response.error.code === -32601;
          if (
            row.method === "Input.imeSetComposition" &&
            !isRecord(response.error)
          )
            this.imeSupported = true;
          const ok = !isRecord(response.error) || unsupported;
          if (!ok) this.writeFailed = true;
          this.native.delete(response.id);
          native.settle(ok);
          if (!ok && !this.stopped) {
            this.revoke();
            return;
          }
        }
        if (row.sequence !== undefined && !this.stopped) {
          this.outstanding.delete(row.sequence);
          this.completed.add(row.sequence);
          while (this.completed.delete(this.completedThrough + 1))
            this.completedThrough++;
          this.emit({
            type: "ack",
            sequence: row.sequence,
            ok: !isRecord(response.error),
          });
        }
      });
      return socket;
    });
  }

  static async open({
    endpoint,
    targetId,
    windowId,
    reply,
    factory = (url) => new WebSocket(url),
    signal,
    mode = "keys",
    transitionDeadlineMs = 10_000,
  }: {
    endpoint: string;
    targetId: string;
    windowId: number;
    reply: (value: ProbeReply) => void;
    factory?: SocketFactory;
    signal?: AbortSignal;
    mode?: ProbeMode;
    transitionDeadlineMs?: number;
  }): Promise<GuardedProbe> {
    const probe = new GuardedProbe(
      endpoint,
      targetId,
      mode,
      transitionDeadlineMs,
      reply,
      factory,
    );
    const abort = () => probe.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) probe.close();
      await probe.client.opened;
      const directory = new TargetDirectory(probe.client, windowId);
      await directory.assertMember(targetId);
      const { sessionId } = await probe.client.request(
        "Target.attachToTarget",
        {
          targetId,
          flatten: true,
        },
      );
      probe.sessionId = sessionId;
      await probe.client.request("Page.enable", undefined, sessionId);
      const input = new InputSession(
        probe.client,
        sessionId,
        async () => {
          // Terminal admission and blur have discarded every old queued job.
          // Only the trusted new-owner no-op completion fence can run now.
          // Original-session cleanup must remain joinable after an external
          // move; replacement admission performs its own destination check.
          if (
            mode === "composition" &&
            probe.retirement !== undefined &&
            !probe.closed
          )
            return true;
          await directory.assertMember(targetId);
          return !probe.stopped;
        },
        (value) => {
          probe.currentNavigation = value;
          if (mode === "composition" && !probe.stopped)
            probe.emit({
              type: "navigation",
              generation: probe.currentGeneration,
              value,
            });
        },
        (reason) => {
          if (probe.ready || probe.transitioning) {
            if (mode === "composition" && reason !== "failed")
              probe.suspend(reason);
            else probe.revoke();
          }
        },
        () => {},
        (error) => {
          if (error) probe.revoke();
        },
        () => {
          if (mode === "composition" && !probe.stopped)
            probe.emit({
              type: "clipboard-reset",
              generation: probe.currentGeneration,
              through: probe.selectionThrough,
            });
        },
      );
      probe.input = input;
      probe.removeEvents = probe.client.onEvent((event) => input.event(event));
      probe.client.onDisconnected(() => {
        probe.retirementFailed?.();
        probe.revoke();
      });
      await input.start();
      if (probe.stopped) throw new Error("Fixture admission was cancelled");
      probe.ready = true;
      return probe;
    } catch (error) {
      probe.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  receive(raw: unknown): boolean {
    if (this.stopped || !this.ready) return false;
    let value: unknown;
    try {
      const limit =
        this.mode === "composition" ? compositionMessageLimit : 128 * 1024;
      if (typeof raw !== "string" || raw.length > limit)
        throw new Error("Invalid fixture intent");
      value = JSON.parse(raw) as unknown;
    } catch {
      this.revoke();
      return false;
    }
    if (this.mode !== "keys") {
      if (this.mode === "composition") {
        // Old-generation traffic can still be crossing the viewer link after
        // invalidation. It has no effects or credit in the new generation.
        if (
          isRecord(value) &&
          value.owner === this.owner &&
          value.generation !== this.currentGeneration
        )
          return false;
        if (isRecord(value) && value.kind === "blur") {
          if (
            value.owner !== this.owner ||
            value.generation !== this.currentGeneration
          ) {
            this.revoke();
            return false;
          }
          this.input!.blur();
          return !this.stopped;
        }
      }
      return this.receiveBatch(value);
    }
    const action = isRecord(value) ? intent(value) : null;
    if (
      !isRecord(value) ||
      value.owner !== this.owner ||
      value.sequence !== this.next ||
      !Number.isSafeInteger(value.sequence) ||
      !Number.isSafeInteger(value.acknowledged) ||
      Number(value.acknowledged) < this.receivedThrough ||
      Number(value.acknowledged) > this.completedThrough ||
      !action ||
      this.next - 1 - Number(value.acknowledged) >= 64
    ) {
      this.revoke();
      return false;
    }
    const sequence = this.next++;
    this.receivedThrough = Number(value.acknowledged);
    this.outstanding.add(sequence);
    this.peakOutstanding = Math.max(
      this.peakOutstanding,
      this.outstanding.size,
    );
    this.waiting.push(sequence);
    if (action.kind === "key") this.input!.key(action.key);
    else this.input!.text(action.text);
    return true;
  }

  private receiveBatch(value: unknown): boolean {
    const actions =
      isRecord(value) && value.kind === "batch"
        ? nativeActions(value.actions, this.mode === "composition")
        : null;
    if (
      !isRecord(value) ||
      value.owner !== this.owner ||
      value.sequence !== this.next ||
      !Number.isSafeInteger(value.sequence) ||
      !Number.isSafeInteger(value.acknowledged) ||
      Number(value.acknowledged) < this.receivedThrough ||
      Number(value.acknowledged) > this.completedThrough ||
      !actions
    ) {
      this.revoke();
      return false;
    }
    let selection = this.selectionThrough;
    for (const action of actions)
      if (action.kind === "selection" && action.request !== ++selection) {
        this.revoke();
        return false;
      }
    this.receivedThrough = Number(value.acknowledged);
    for (const sequence of this.batches.keys())
      if (sequence <= this.receivedThrough) this.batches.delete(sequence);
    const count =
      [...this.batches.values()].reduce((sum, n) => sum + n, 0) +
      actions.length;
    if (count > 64) {
      this.revoke();
      return false;
    }
    const sequence = this.next++;
    this.batches.set(sequence, actions.length);
    this.peakOutstanding = Math.max(this.peakOutstanding, count);
    const owner = this.input!.owner!;
    const generation = this.currentGeneration;
    for (const action of actions) {
      if (this.stopped || generation !== this.currentGeneration) return false;
      if (action.kind === "key") this.input!.key(action.key);
      else if (action.kind === "text") this.input!.text(action.text, owner);
      else if (action.kind === "pointer")
        this.input!.pointer(action.type, action.point, action.details);
      else if (action.kind === "preedit")
        this.input!.preedit(
          action.text,
          owner,
          action.selectionStart,
          action.selectionEnd,
        );
      else if (action.kind === "commit")
        this.input!.commitComposition(action.text, owner);
      else if (action.kind === "selection") {
        this.selectionThrough = action.request;
        void this.readSelection(action.request, generation, owner);
      } else this.input!.navigate(action.action);
    }
    void this.input!.completion(owner).then(
      () => {
        if (
          this.stopped ||
          this.writeFailed ||
          generation !== this.currentGeneration
        )
          return;
        this.completed.add(sequence);
        while (this.completed.delete(this.completedThrough + 1))
          this.completedThrough++;
        this.emit({
          type: "ack",
          sequence,
          ok: true,
          ...(this.mode === "composition" ? { generation } : {}),
        });
      },
      () => {
        if (generation === this.currentGeneration) this.revoke();
      },
    );
    return !this.stopped;
  }

  get generation(): string {
    return this.currentGeneration;
  }

  get navigation(): ViewerNavigation | null {
    return this.currentNavigation;
  }

  private async readSelection(
    request: number,
    generation: string,
    owner: InputOwner,
  ): Promise<void> {
    const current = () =>
      !this.stopped &&
      generation === this.currentGeneration &&
      this.input!.owner === owner &&
      request === this.selectionThrough;
    try {
      const result = await this.input!.selection(owner);
      if (current())
        this.emit({ type: "selection", generation, request, result });
    } catch {
      if (current())
        this.emit({ type: "selection", generation, request, result: null });
    }
  }

  get ownership() {
    const owner = this.input!.owner!;
    return {
      generation: this.currentGeneration,
      document: owner.document,
      focus: owner.focus,
    };
  }

  private nativeSettled(): Promise<boolean> {
    return Promise.all(
      [...this.native.values()].map((value) => value.done),
    ).then(
      (results) => !this.closed && !this.writeFailed && results.every(Boolean),
    );
  }

  private suspend(reason: InputTransition): void {
    if (this.stopped) return;
    this.ready = false;
    this.transitioning = true;
    // Repeated document events do not extend one unresolved cleanup's budget.
    this.transitionDeadline ??= setTimeout(() => {
      this.transitionDeadline = undefined;
      this.revoke();
    }, this.transitionDeadlineMs);
    const previous = this.currentGeneration;
    const generation = (this.currentGeneration = randomUUID());
    this.next = 1;
    this.receivedThrough = 0;
    this.completedThrough = 0;
    this.completed.clear();
    this.batches.clear();
    this.selectionThrough = 0;
    const owner: InputOwner = this.input!.owner!;
    const current = () =>
      !this.stopped &&
      this.currentGeneration === generation &&
      this.input!.owner === owner;
    this.emit({
      type: "suspended",
      previous,
      generation,
      reason,
      document: owner.document,
      focus: owner.focus,
    });
    // Navigation publishes its transition before synchronously enqueueing its
    // barrier. Join after that enqueue, never ahead of the action it invalidates.
    void Promise.resolve()
      .then(() => this.input!.completion(owner))
      .then(async () => {
        if (!current()) return;
        const ok = await this.nativeSettled();
        if (!current()) return;
        if (!ok) this.revoke();
        else {
          this.transitioning = false;
          this.clearTransitionDeadline();
          this.ready = true;
          this.emit({
            type: "ready",
            generation,
            document: owner.document,
            focus: owner.focus,
          });
        }
      })
      .catch(() => {
        if (current()) this.revoke();
      });
  }

  holdNext(
    method:
      | "Browser.getWindowForTarget"
      | "Input.dispatchKeyEvent"
      | "Input.imeSetComposition"
      | "Page.navigate",
  ) {
    if (this.hold) throw new Error("A fixture response is already held");
    let held!: () => void;
    const promise = new Promise<void>((resolve) => {
      held = resolve;
    });
    const hold: Hold = { method, held };
    this.hold = hold;
    return { held: promise, release: () => hold.release?.() };
  }

  private clearTransitionDeadline(): void {
    if (this.transitionDeadline !== undefined)
      clearTimeout(this.transitionDeadline);
    this.transitionDeadline = undefined;
  }

  private emit(value: ProbeReply): void {
    try {
      this.reply(value);
    } catch {
      // Viewer loss does not destroy a still-live original cleanup connection.
      // A revoked notification needs no delivery receipt to that lost viewer.
      if (!this.stopped) void this.retire();
    }
  }

  private revoke(): void {
    if (this.stopped) return;
    this.close();
    this.emit({ type: "revoked" });
  }

  /** A positive receipt covers original native effects, releases and detach. */
  retire(
    reason: Exclude<InputStop, "disconnected"> = "disposed",
    deadlineMs = 10_000,
  ): Promise<boolean> {
    if (this.retirement) return this.retirement;
    if (this.closed) return Promise.resolve(false);
    let finish!: (confirmed: boolean) => void;
    this.retirement = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    this.stopped = true;
    this.ready = false;
    this.transitioning = false;
    this.clearTransitionDeadline();
    // Publish terminal admission before disposal or reentrant reply callbacks.
    let joined = Promise.resolve();
    if (this.mode === "composition" && this.input) {
      // Keep the original session/document observer alive through the old job's
      // finally continuation. Its late native cleanup must precede our snapshot.
      this.input.blur();
      joined = this.input.completion(this.input.owner!);
    } else {
      this.removeEvents?.();
      this.input?.dispose(reason);
    }
    this.emit({ type: "revoked" });
    const failed = new Promise<boolean>((resolve) => {
      this.retirementFailed = () => resolve(false);
    });
    const deadline = setTimeout(() => this.retirementFailed?.(), deadlineMs);
    const confirmed = joined
      .then(() => this.nativeSettled())
      .then(async (ok) => {
        if (!ok) return false;
        if (this.mode === "composition") {
          this.input?.dispose(reason);
          if (!(await this.nativeSettled())) return false;
        }
        if (this.sessionId)
          await this.client.request("Target.detachFromTarget", {
            sessionId: this.sessionId,
          });
        return !this.closed && !this.writeFailed;
      })
      .catch(() => false);
    void Promise.race([confirmed, failed]).then((ok) => {
      clearTimeout(deadline);
      this.shutdown();
      finish(ok);
    });
    return this.retirement;
  }

  /** Emergency teardown is not an acknowledged handover. */
  close(): void {
    if (this.closed) return;
    this.stopped = true;
    this.ready = false;
    this.removeEvents?.();
    this.input?.dispose();
    if (this.sessionId)
      this.client.notify("Target.detachFromTarget", {
        sessionId: this.sessionId,
      });
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTransitionDeadline();
    this.stopped = true;
    this.ready = false;
    this.removeEvents?.();
    this.retirementFailed?.();
    this.client.close();
    for (const reply of this.native.values()) reply.settle(false);
    this.native.clear();
    this.waiting.length = 0;
    this.outstanding.clear();
    this.requests.clear();
    this.completed.clear();
    this.batches.clear();
    this.hold = undefined;
  }
}
