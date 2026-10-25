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
import type { ViewerNavigation } from "../../src/viewer/types";
import type { ProbeReply } from "./probe-replies";
export type { ProbeReply } from "./probe-replies";

type Key = Protocol.Input.DispatchKeyEventRequest;
type Intent = { kind: "key"; key: Key } | { kind: "text"; text: string };
export type ProbeMode = "keys" | "native" | "composition";

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
  private retirement: Promise<boolean> | undefined;
  private retirementFailed: (() => void) | undefined;
  private readonly batches = new Map<number, number>();
  private ready = false;
  private transitioning = false;
  private transitionDeadline: ReturnType<typeof setTimeout> | undefined;
  private currentGeneration = randomUUID();
  private selectionReceivedThrough = 0;
  private selectionThrough = 0;
  private currentNavigation: ViewerNavigation | null = null;
  private readonly outstanding = new Set<number>();
  private readonly waiting: number[] = [];
  private readonly requests = new Map<number, Trace>();
  private readonly client: CdpClient;
  private directory: TargetDirectory | null = null;
  private admission: Promise<void> = Promise.resolve();
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
      // Installed before CdpClient's listener: a hold blocks its real await.
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (this.hold?.id === undefined || typeof event.data !== "string")
          return;
        let response: unknown;
        try {
          response = JSON.parse(event.data);
        } catch {
          // The following CdpClient listener owns malformed-protocol failure
          // and original-connection cleanup. This observer must not throw first.
          return;
        }
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
      });
      return socket;
    });
    this.client.onTraffic((event) => {
      if (event.type === "command") {
        const row: Trace = { method: event.method, sent: Date.now() };
        if (
          !this.stopped &&
          (event.method === "Input.dispatchKeyEvent" ||
            event.method === "Input.insertText")
        ) {
          const sequence = this.waiting.shift();
          if (sequence !== undefined) row.sequence = sequence;
        }
        this.trace.push(row);
        this.requests.set(event.id, row);
        if (this.hold?.method === event.method && this.hold.id === undefined)
          this.hold.id = event.id;
        return;
      }
      const row = this.requests.get(event.id);
      this.requests.delete(event.id);
      if (!row) return;
      row.response = Date.now();
      if (row.sequence === undefined || this.stopped) return;
      this.outstanding.delete(row.sequence);
      if (event.ok) {
        this.completed.add(row.sequence);
        while (this.completed.delete(this.completedThrough + 1))
          this.completedThrough++;
      }
      this.emit({ type: "ack", sequence: row.sequence, ok: event.ok });
      if (!event.ok) this.revoke();
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
      probe.directory = directory;
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
      await directory.assertMember(targetId);
      const input = new InputSession(
        probe.client,
        sessionId,
        () => !probe.stopped,
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
    const owner = this.input!.owner!;
    this.admit(owner, this.currentGeneration, () => {
      this.waiting.push(sequence);
      if (action.kind === "key") this.input!.key(action.key, owner);
      else this.input!.text(action.text, owner);
    });
    return true;
  }

  private current(owner: InputOwner, generation: string): boolean {
    return (
      !this.stopped &&
      generation === this.currentGeneration &&
      this.input?.owner === owner
    );
  }

  /** The adjacent experiment owns real remote admission; production validity is local. */
  private admit(
    owner: InputOwner,
    generation: string,
    dispatch: () => void,
  ): void {
    this.admission = this.admission
      .then(async () => {
        if (!this.current(owner, generation)) return;
        await this.directory!.assertMember(this.targetId);
        if (this.current(owner, generation)) dispatch();
      })
      .catch(() => {
        if (this.current(owner, generation)) this.revoke();
      });
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
    let selection = this.selectionReceivedThrough;
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
    // Pending admission retains its actions and one native completion fence.
    // Completed actions still consume wire credit, but no longer queue space.
    const pending = [...this.batches].reduce(
      (sum, [sequence, size]) =>
        sum + (sequence > this.completedThrough ? size + 1 : 0),
      actions.length + 1,
    );
    if (count > 64 || pending > 64) {
      this.revoke();
      return false;
    }
    const sequence = this.next++;
    this.batches.set(sequence, actions.length);
    this.peakOutstanding = Math.max(this.peakOutstanding, count);
    const owner = this.input!.owner!;
    const generation = this.currentGeneration;
    this.selectionReceivedThrough = selection;
    for (const action of actions) {
      if (this.stopped || generation !== this.currentGeneration) return false;
      this.admit(owner, generation, () => {
        if (action.kind === "key") this.input!.key(action.key, owner);
        else if (action.kind === "text") this.input!.text(action.text, owner);
        else if (action.kind === "pointer")
          this.input!.pointer(action.type, action.point, action.details, owner);
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
      });
    }
    void this.admission
      .then(() => {
        if (!this.current(owner, generation))
          throw new Error("Fixture action was cancelled");
        return this.input!.completion(owner);
      })
      .then(
        () => {
          if (this.stopped || generation !== this.currentGeneration) return;
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
      request === this.selectionReceivedThrough;
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
    // Read-only guards from the old generation cannot delay fresh admission.
    // Their captured owner/generation still prevents late dispatch or credit.
    this.admission = Promise.resolve();
    this.next = 1;
    this.receivedThrough = 0;
    this.completedThrough = 0;
    this.completed.clear();
    this.batches.clear();
    this.selectionReceivedThrough = 0;
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
      .then(() => {
        if (!current()) return;
        this.transitioning = false;
        this.clearTransitionDeadline();
        this.ready = true;
        this.emit({
          type: "ready",
          generation,
          document: owner.document,
          focus: owner.focus,
        });
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
    const joined = this.input?.retire(reason) ?? Promise.resolve();
    this.emit({ type: "revoked" });
    const failed = new Promise<boolean>((resolve) => {
      this.retirementFailed = () => resolve(false);
    });
    const deadline = setTimeout(() => this.retirementFailed?.(), deadlineMs);
    const confirmed = joined
      .then(async () => {
        if (this.sessionId)
          await this.client.request("Target.detachFromTarget", {
            sessionId: this.sessionId,
          });
        return !this.closed;
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
    this.waiting.length = 0;
    this.outstanding.clear();
    this.requests.clear();
    this.completed.clear();
    this.batches.clear();
    this.hold = undefined;
  }
}
