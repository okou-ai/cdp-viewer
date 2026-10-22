import { NativeInput } from "../../src/input/native";
import type { NativeInputPort } from "../../src/input/port";
import type { InputOwner, InputTransition } from "../../src/input/lifecycle";
import type { NativeAction } from "./native-actions";

interface NativeStats {
  actions: number;
  batches: number;
  acknowledgements: number[];
  peakOutstanding: number;
  revoked: boolean;
  unsupported: boolean;
  ready: boolean;
  resets: number;
  generation: string | null;
  discardedReplies: number;
}

declare global {
  interface Window {
    installNativeExperiment: (settings: {
      endpoint: string;
      owner: string;
      ownership?: { generation: string; document: number; focus: number };
    }) => Promise<void>;
    nativeExperiment: { stats: NativeStats; close: () => void };
  }
}

/** Bundled only by the opt-in fixture; this is the real DOM adapter, not a copy. */
window.installNativeExperiment = ({ endpoint, owner, ownership }) => {
  const canvas = document.querySelector<HTMLCanvasElement>("#viewer-a canvas");
  if (!canvas?.parentElement) throw new Error("Owned viewer canvas is missing");
  const proxy = document.createElement("textarea");
  proxy.setAttribute("aria-label", "Native executor input");
  proxy.style.cssText =
    "position:absolute;width:1px;height:1px;opacity:0;resize:none";
  canvas.parentElement.append(proxy);
  const socket = new WebSocket(endpoint);
  const composition = ownership !== undefined;
  let generation = ownership?.generation ?? null;
  let token: InputOwner | null = Object.freeze({
    sessionId: owner,
    document: ownership?.document ?? 0,
    focus: ownership?.focus ?? 0,
  });
  const stats: NativeStats = {
    actions: 0,
    batches: 0,
    acknowledgements: [],
    peakOutstanding: 0,
    revoked: false,
    unsupported: false,
    ready: true,
    resets: 0,
    generation,
    discardedReplies: 0,
  };
  const queued: NativeAction[] = [];
  const pending = new Map<number, number>();
  const completed = new Set<number>();
  let sequence = 0;
  let acknowledged = 0;
  let unconfirmed = 0;
  let scheduled = false;
  let stopped = false;
  let native: NativeInput | undefined;
  const discard = () => {
    token = null;
    queued.length = 0;
    pending.clear();
    completed.clear();
    sequence = 0;
    acknowledged = 0;
    unconfirmed = 0;
    stats.ready = false;
    if (composition) {
      stats.actions = 0;
      stats.batches = 0;
      stats.acknowledgements.length = 0;
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stats.revoked = true;
    discard();
    native?.dispose();
    socket.close();
  };
  const unsupported = () => {
    stats.unsupported = true;
    stop();
  };
  const flush = () => {
    scheduled = false;
    if (stopped || !token || !queued.length) return;
    if (socket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    const actions = queued.splice(0, 16);
    pending.set(++sequence, actions.length);
    stats.batches++;
    socket.send(
      JSON.stringify({
        kind: "batch",
        owner,
        sequence,
        acknowledged,
        actions,
        ...(composition ? { generation } : {}),
      }),
    );
    if (queued.length) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  const send = (action: NativeAction) => {
    if (stopped || !token) return;
    if (unconfirmed >= 64) {
      stop();
      return;
    }
    unconfirmed++;
    stats.actions++;
    stats.peakOutstanding = Math.max(stats.peakOutstanding, unconfirmed);
    queued.push(action);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  const port: NativeInputPort = {
    get owner() {
      return stopped ? null : token;
    },
    // Optional remote caret metadata is not used to authorize native focus.
    focus: () => {},
    blur: () => {
      if (!composition) {
        stop();
        return;
      }
      if (stopped || !token) return;
      discard();
      socket.send(JSON.stringify({ kind: "blur", owner, generation }));
    },
    key: (key) => send({ kind: "key", key }),
    pointer: (type, point, details) =>
      send({ kind: "pointer", type, point, details }),
    text: (text, captured) => {
      if (captured === token) send({ kind: "text", text });
    },
    preedit: (text, captured, selectionStart, selectionEnd) => {
      if (!composition) {
        unsupported();
        return;
      }
      if (captured === token)
        send({
          kind: "preedit",
          text,
          selectionStart: selectionStart ?? text.length,
          selectionEnd: selectionEnd ?? selectionStart ?? text.length,
        });
    },
    commitComposition: (text, captured) => {
      if (!composition) {
        unsupported();
        return;
      }
      if (captured === token) send({ kind: "commit", text });
    },
    selection: () => {
      unsupported();
      return Promise.reject(new Error("Selection is outside this experiment"));
    },
    clipboardError: () => {},
  };
  native = new NativeInput(canvas, proxy, () => (stopped ? null : port), stop);
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    if (stopped) return;
    const value = JSON.parse(event.data) as {
      type: string;
      sequence?: number;
      ok?: boolean;
      generation?: string;
      previous?: string;
      reason?: InputTransition;
      document?: number;
      focus?: number;
    };
    // A reply already crossing the link may arrive after local blur discarded
    // its pending batch, before the server's suspension reaches this client.
    if (
      composition &&
      value.type === "ack" &&
      (!token || value.generation !== generation)
    ) {
      stats.discardedReplies++;
      return;
    }
    if (value.type === "revoked" || value.ok === false) {
      stop();
      return;
    }
    if (composition) {
      if (value.type === "suspended") {
        if (value.previous !== generation) return;
        if (typeof value.generation !== "string") {
          stop();
          return;
        }
        generation = value.generation;
        stats.generation = generation;
        stats.resets++;
        discard();
        native?.reset(value.reason);
        return;
      }
      if (value.generation !== generation) return;
      if (value.type === "ready") {
        if (
          typeof value.document !== "number" ||
          !Number.isSafeInteger(value.document) ||
          value.document < 0 ||
          typeof value.focus !== "number" ||
          !Number.isSafeInteger(value.focus) ||
          value.focus < 0
        ) {
          stop();
          return;
        }
        token = Object.freeze({
          sessionId: owner,
          document: value.document,
          focus: value.focus,
        });
        stats.ready = true;
        return;
      }
    }
    if (
      value.type !== "ack" ||
      value.sequence === undefined ||
      !pending.has(value.sequence)
    ) {
      stop();
      return;
    }
    completed.add(value.sequence);
    stats.acknowledgements.push(Date.now());
    while (completed.delete(acknowledged + 1)) {
      unconfirmed -= pending.get(++acknowledged)!;
      pending.delete(acknowledged);
    }
  });
  socket.addEventListener("close", stop);
  socket.addEventListener("error", stop);
  window.nativeExperiment = { stats, close: stop };
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Native fixture channel failed")),
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => reject(new Error("Native fixture channel closed")),
      { once: true },
    );
  });
};
