import { randomUUID } from "node:crypto";
import type { Protocol } from "devtools-protocol";
import { CdpClient } from "../../src/cdp/client";
import type { SocketFactory } from "../../src/cdp/client";
import { isRecord } from "../../src/cdp/errors";
import { TargetDirectory } from "../../src/cdp/targets";
import { InputSession } from "../../src/input/session";

type Key = Protocol.Input.DispatchKeyEventRequest;
type Intent = { kind: "key"; key: Key } | { kind: "text"; text: string };
export type ProbeReply =
  { type: "ack"; sequence: number; ok: boolean } | { type: "revoked" };

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
  private ready = false;
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
            if (!this.stopped)
              socket.dispatchEvent(new MessageEvent("message", { data }));
          };
          hold.held();
          return;
        }
        const row = this.requests.get(response.id);
        this.requests.delete(response.id);
        if (!row) return;
        row.response = Date.now();
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
  }: {
    endpoint: string;
    targetId: string;
    windowId: number;
    reply: (value: ProbeReply) => void;
    factory?: SocketFactory;
  }): Promise<GuardedProbe> {
    const probe = new GuardedProbe(endpoint, reply, factory);
    try {
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
          await directory.assertMember(targetId);
          return !probe.stopped;
        },
        () => {},
        () => {
          if (probe.ready) probe.revoke();
        },
        () => {},
        (error) => {
          if (error) probe.revoke();
        },
      );
      probe.input = input;
      probe.removeEvents = probe.client.onEvent((event) => input.event(event));
      probe.client.onDisconnected(() => probe.revoke());
      await input.start();
      if (probe.stopped) throw new Error("Fixture admission was cancelled");
      probe.ready = true;
      return probe;
    } catch (error) {
      probe.close();
      throw error;
    }
  }

  receive(raw: unknown): boolean {
    if (this.stopped || !this.ready) return false;
    let value: unknown;
    try {
      if (typeof raw !== "string" || raw.length > 128 * 1024)
        throw new Error("Invalid fixture intent");
      value = JSON.parse(raw) as unknown;
    } catch {
      this.revoke();
      return false;
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

  holdNext(method: "Browser.getWindowForTarget" | "Input.dispatchKeyEvent") {
    if (this.hold) throw new Error("A fixture response is already held");
    let held!: () => void;
    const promise = new Promise<void>((resolve) => {
      held = resolve;
    });
    const hold: Hold = { method, held };
    this.hold = hold;
    return { held: promise, release: () => hold.release?.() };
  }

  private emit(value: ProbeReply): void {
    try {
      this.reply(value);
    } catch {
      this.close();
    }
  }

  private revoke(): void {
    if (this.stopped) return;
    this.close();
    this.emit({ type: "revoked" });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.removeEvents?.();
    this.input?.dispose();
    if (this.sessionId)
      this.client.notify("Target.detachFromTarget", {
        sessionId: this.sessionId,
      });
    this.client.close();
    this.waiting.length = 0;
    this.outstanding.clear();
    this.requests.clear();
    this.completed.clear();
    this.hold = undefined;
  }
}
