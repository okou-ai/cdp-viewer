import { NativeInput } from "../../src/input/native";
import type { NativeInputPort } from "../../src/input/port";
import type { NativeAction } from "./native-actions";

interface NativeStats {
  actions: number;
  batches: number;
  acknowledgements: number[];
  peakOutstanding: number;
  revoked: boolean;
  unsupported: boolean;
}

declare global {
  interface Window {
    installNativeExperiment: (settings: {
      endpoint: string;
      owner: string;
    }) => Promise<void>;
    nativeExperiment: { stats: NativeStats; close: () => void };
  }
}

/** Bundled only by the opt-in fixture; this is the real DOM adapter, not a copy. */
window.installNativeExperiment = ({ endpoint, owner }) => {
  const canvas = document.querySelector<HTMLCanvasElement>("#viewer-a canvas");
  if (!canvas?.parentElement) throw new Error("Owned viewer canvas is missing");
  const proxy = document.createElement("textarea");
  proxy.setAttribute("aria-label", "Native executor input");
  proxy.style.cssText =
    "position:absolute;width:1px;height:1px;opacity:0;resize:none";
  canvas.parentElement.append(proxy);
  const socket = new WebSocket(endpoint);
  const token = Object.freeze({ sessionId: owner, document: 0, focus: 0 });
  const stats: NativeStats = {
    actions: 0,
    batches: 0,
    acknowledgements: [],
    peakOutstanding: 0,
    revoked: false,
    unsupported: false,
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
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stats.revoked = true;
    queued.length = 0;
    pending.clear();
    completed.clear();
    native?.dispose();
    socket.close();
  };
  const unsupported = () => {
    stats.unsupported = true;
    stop();
  };
  const flush = () => {
    scheduled = false;
    if (stopped || !queued.length) return;
    if (socket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    const actions = queued.splice(0, 16);
    pending.set(++sequence, actions.length);
    stats.batches++;
    socket.send(
      JSON.stringify({ kind: "batch", owner, sequence, acknowledged, actions }),
    );
    if (queued.length) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  const send = (action: NativeAction) => {
    if (stopped) return;
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
    blur: stop,
    key: (key) => send({ kind: "key", key }),
    pointer: (type, point, details) =>
      send({ kind: "pointer", type, point, details }),
    text: (text, captured) => {
      if (captured === token) send({ kind: "text", text });
    },
    preedit: unsupported,
    commitComposition: unsupported,
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
    };
    if (value.type === "revoked" || value.ok === false) {
      stop();
      return;
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
