import { NativeInput } from "../../src/input/native";
import { isRecord } from "../../src/cdp/errors";
import type { NativeInputPort } from "../../src/input/port";
import type { InputOwner, InputTransition } from "../../src/input/lifecycle";
import type { NativeAction } from "./native-actions";
import { compositionMessageLimit, selectionResult } from "./native-actions";
import type { NavigationAction } from "./native-actions";
import type { SelectionResult } from "../../src/input/selection";
import type { ViewerNavigation } from "../../src/viewer/types";
import { nativeControls } from "./native-controls";

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
  navigation: ViewerNavigation | null;
  error: string | null;
}

declare global {
  interface Window {
    installNativeExperiment: (settings: {
      endpoint: string;
      owner: string;
      ownership?: { generation: string; document: number; focus: number };
      navigation?: ViewerNavigation | null;
    }) => Promise<void>;
    nativeExperiment: { stats: NativeStats; close: () => void };
  }
}

/** Bundled only by the opt-in fixture; this is the real DOM adapter, not a copy. */
window.installNativeExperiment = ({
  endpoint,
  owner,
  ownership,
  navigation,
}) => {
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
    navigation: navigation ?? null,
    error: null,
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
  let selectionVersion = 0;
  let selection: {
    request: number;
    owner: InputOwner;
    resolve: (value: SelectionResult) => void;
    reject: (error: Error) => void;
    deadline: ReturnType<typeof setTimeout>;
  } | null = null;
  let controls: ReturnType<typeof nativeControls> | undefined;
  const cancelSelection = () => {
    if (!selection) return;
    clearTimeout(selection.deadline);
    selection.reject(new Error("Selection cancelled"));
    selection = null;
  };
  const discard = () => {
    cancelSelection();
    token = null;
    queued.length = 0;
    pending.clear();
    completed.clear();
    sequence = 0;
    acknowledged = 0;
    unconfirmed = 0;
    stats.ready = false;
    controls?.ready(false);
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
    controls?.dispose();
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
    const envelope = {
      kind: "batch",
      owner,
      sequence: sequence + 1,
      acknowledged,
      ...(composition ? { generation } : {}),
    };
    let count = Math.min(16, queued.length);
    if (composition) {
      let length = JSON.stringify({ ...envelope, actions: [] }).length;
      count = 0;
      for (const action of queued.slice(0, 16)) {
        const addition = JSON.stringify(action).length + (count ? 1 : 0);
        if (length + addition > compositionMessageLimit) break;
        length += addition;
        count++;
      }
      if (!count) {
        stop();
        return;
      }
    }
    const actions = queued.splice(0, count);
    pending.set(++sequence, actions.length);
    stats.batches++;
    socket.send(JSON.stringify({ ...envelope, actions }));
    if (queued.length) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  const send = (action: NativeAction) => {
    if (stopped || !token) return;
    if (
      action.kind !== "selection" &&
      (action.kind !== "key" || action.key.type !== "keyUp")
    ) {
      stats.error = null;
      controls?.error(null);
    }
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
  const navigate = (action: NavigationAction) => {
    if (stopped || !token) return;
    send({ kind: "navigate", action });
    while (!stopped && queued.length) flush();
    // No more old-generation effects while the navigation is crossing the link.
    discard();
    native?.reset("navigation-started");
  };
  if (composition) {
    controls = nativeControls(
      canvas.parentElement,
      navigate,
      () => native?.copyClipboard(),
      () => native?.clearClipboard(),
    );
    controls.navigation(stats.navigation);
  }
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
    selection: (captured) => {
      if (!composition) {
        unsupported();
        return Promise.reject(
          new Error("Selection is outside this experiment"),
        );
      }
      if (stopped || !token || captured !== token)
        return Promise.reject(new Error("Selection cancelled"));
      cancelSelection();
      const request = ++selectionVersion;
      return new Promise<SelectionResult>((resolve, reject) => {
        const deadline = setTimeout(() => {
          if (selection?.request !== request || selection.owner !== captured)
            return;
          selection = null;
          reject(new Error("Selection unavailable"));
        }, 10_000);
        selection = { request, owner: captured, resolve, reject, deadline };
        send({ kind: "selection", request });
      });
    },
    clipboardError: (message) => {
      stats.error = message;
      controls?.error(message);
    },
  };
  native = new NativeInput(
    canvas,
    proxy,
    () => (stopped ? null : port),
    () => (composition ? controls?.focus() : stop()),
    (value) => controls?.recovery(value),
  );
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    if (stopped) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(event.data);
    } catch {
      stop();
      return;
    }
    if (!isRecord(decoded) || typeof decoded.type !== "string") {
      stop();
      return;
    }
    const value = decoded as {
      type: string;
      sequence?: number;
      ok?: boolean;
      generation?: string;
      previous?: string;
      reason?: InputTransition;
      document?: number;
      focus?: number;
      request?: number;
      result?: unknown;
      through?: number;
      value?: ViewerNavigation | null;
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
        selectionVersion = 0;
        native?.reset(value.reason);
        return;
      }
      if (value.generation !== generation) return;
      if (value.type === "selection") {
        const pending = selection;
        if (!pending || value.request !== pending.request) return;
        selection = null;
        clearTimeout(pending.deadline);
        const result = selectionResult(value.result);
        if (
          pending.owner === token &&
          value.request === selectionVersion &&
          result
        )
          pending.resolve(result);
        else pending.reject(new Error("Selection unavailable"));
        return;
      }
      if (value.type === "clipboard-reset") {
        if (
          Number.isSafeInteger(value.through) &&
          Number(value.through) >= selectionVersion
        ) {
          cancelSelection();
          native?.clearClipboard();
        }
        return;
      }
      if (value.type === "navigation") {
        const navigation = value.value;
        if (
          navigation !== null &&
          (!navigation ||
            typeof navigation.url !== "string" ||
            navigation.url.length > 64 * 1024 ||
            typeof navigation.canGoBack !== "boolean" ||
            typeof navigation.canGoForward !== "boolean")
        ) {
          stop();
          return;
        }
        stats.navigation = navigation;
        controls?.navigation(navigation);
        return;
      }
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
        controls?.ready(true);
        return;
      }
    }
    if (
      value.type !== "ack" ||
      value.ok !== true ||
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
