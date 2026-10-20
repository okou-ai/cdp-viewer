import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient, CdpEvent } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import type { ViewerNavigation } from "../viewer/types";
import type { Point } from "./geometry";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
type Key = Protocol.Input.DispatchKeyEventRequest;
interface Job {
  epoch: number;
  run: (job: Job) => Promise<void>;
  move: boolean;
  text?: string;
}

const focusedElement = `(() => {
  let e = document.activeElement;
  while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
  return e;
})()`;

const focusDetails = `function () {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active !== this || !this.isConnected) return null;
  const editable = !this.disabled && !this.readOnly &&
    (this.isContentEditable || this.localName === 'textarea' ||
      (this.localName === 'input' &&
       ['text','search','email','url','tel','password','number'].includes(this.type)));
  const rect = this.getBoundingClientRect();
  let x = rect.left + 4, y = rect.top + Math.min(rect.height, 20);
  const selection = getSelection();
  if (this.isContentEditable && selection?.rangeCount &&
      this.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const caret = range.getBoundingClientRect();
    if (caret.height) { x = caret.left; y = caret.bottom; }
  }
  const viewport = window.visualViewport;
  return { editable, range: !!this.isContentEditable,
    supported: !['iframe','frame'].includes(this.localName), x, y,
    width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
    offsetX: viewport?.offsetLeft ?? 0, offsetY: viewport?.offsetTop ?? 0 };
}`;

/** One selected session owns a bounded, non-retrying input queue. */
export class InputSession {
  private epoch = 0;
  private disposed = false;
  private running = false;
  private executingEpoch = 0;
  private readonly jobs: Job[] = [];
  private focusObject: string | null = null;
  private readonly keys = new Map<string, Key>();
  private readonly buttons = new Set<NonNullable<Mouse["button"]>>();
  private lastPoint = { x: 0, y: 0 };
  private historyEpoch = -1;
  private navigationKnown = false;
  private frameId: string | null = null;
  private contextId: number | null = null;

  constructor(
    private readonly client: CdpClient,
    readonly sessionId: string,
    private readonly owner: () => Promise<boolean>,
    private readonly changed: (value: ViewerNavigation | null) => void,
    private readonly resetLocal: () => void,
    private readonly caret: (point: Point) => void,
    private readonly setError: (error: CdpFault | null) => void,
  ) {}

  async start(): Promise<void> {
    const tree = await this.client.request(
      "Page.getFrameTree",
      undefined,
      this.sessionId,
    );
    if (this.disposed) return;
    this.frameId = tree.frameTree.frame.id;
    await this.client.request("Runtime.enable", undefined, this.sessionId);
    if (!this.disposed) this.updateHistory();
  }

  focus(): void {
    this.enqueue(async () => {
      await this.readFocus();
      if (!this.navigationKnown) this.updateHistory();
    });
  }

  blur(): void {
    this.invalidate(true);
  }

  private clearFocus(): void {
    if (this.focusObject) {
      this.client.notify(
        "Runtime.releaseObject",
        { objectId: this.focusObject },
        this.sessionId,
      );
      this.focusObject = null;
    }
  }

  private invalidate(release: boolean): void {
    this.epoch++;
    this.jobs.length = 0;
    this.clearFocus();
    if (release) {
      for (const key of this.keys.values()) {
        this.client.notify(
          "Input.dispatchKeyEvent",
          { ...key, type: "keyUp", modifiers: 0 },
          this.sessionId,
        );
      }
      for (const button of this.buttons) {
        this.client.notify(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            ...this.lastPoint,
            button,
            buttons: 0,
          },
          this.sessionId,
        );
      }
    }
    this.keys.clear();
    this.buttons.clear();
    this.resetLocal();
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate(true);
    this.disposed = true;
    this.changed(null);
  }

  event(event: CdpEvent): void {
    if (this.disposed || event.sessionId !== this.sessionId) return;
    const { method, params } = event;
    if (
      method === "Runtime.executionContextCreated" &&
      isRecord(params.context)
    ) {
      const context = params.context;
      if (
        typeof context.id === "number" &&
        isRecord(context.auxData) &&
        context.auxData.isDefault === true &&
        context.auxData.frameId === this.frameId
      ) {
        this.contextId = context.id;
      }
    }
    const mainNavigation =
      method === "Page.frameNavigated" &&
      isRecord(params.frame) &&
      !params.frame.parentId;
    if (
      mainNavigation &&
      isRecord(params.frame) &&
      typeof params.frame.id === "string"
    )
      this.frameId = params.frame.id;
    const mainFrameEvent = params.frameId === this.frameId;
    if (
      mainNavigation ||
      (mainFrameEvent &&
        [
          "Page.frameStartedNavigating",
          "Page.frameStartedLoading",
          "Page.navigatedWithinDocument",
        ].includes(method)) ||
      method === "Runtime.executionContextsCleared" ||
      (method === "Runtime.executionContextDestroyed" &&
        params.executionContextId === this.contextId)
    ) {
      this.invalidate(false);
      this.changed(null);
      this.navigationKnown = false;
    }
    if (
      method === "Page.loadEventFired" ||
      (mainFrameEvent &&
        ["Page.frameStoppedLoading", "Page.navigatedWithinDocument"].includes(
          method,
        ))
    ) {
      this.updateHistory();
    }
  }

  pointer(
    type: Mouse["type"],
    point: Point,
    details: Pick<
      Mouse,
      "button" | "buttons" | "clickCount" | "modifiers" | "deltaX" | "deltaY"
    >,
  ): void {
    this.enqueue(async () => {
      const viewport = (await this.request("Page.getLayoutMetrics", undefined))
        .cssVisualViewport;
      if (
        ![viewport.clientWidth, viewport.clientHeight].every(
          (v) => Number.isFinite(v) && v > 0,
        )
      ) {
        throw new CdpFault(
          "input",
          "The remote viewport is unavailable for input.",
        );
      }
      this.lastPoint = {
        // Input coordinates are relative to the visible CSS viewport. Adding
        // its layout offset would apply pinch-pan translation a second time.
        x: point.x * viewport.clientWidth,
        y: point.y * viewport.clientHeight,
      };
      if (type === "mousePressed") this.clearFocus();
      if (type === "mousePressed" && details.button)
        this.buttons.add(details.button);
      await this.request("Input.dispatchMouseEvent", {
        type,
        ...this.lastPoint,
        ...details,
      });
      if (type === "mouseReleased" && details.button) {
        this.buttons.delete(details.button);
        await this.readFocus();
        if (!this.navigationKnown) this.updateHistory();
      }
    }, type === "mouseMoved");
  }

  text(text: string): void {
    if (!text) return;
    if (text.length > 64 * 1024) {
      this.reportFailure();
      return;
    }
    const tail = this.jobs.at(-1);
    if (
      tail?.text !== undefined &&
      tail.epoch === this.epoch &&
      tail.text.length + text.length <= 64 * 1024
    ) {
      tail.text += text;
      return;
    }
    this.enqueue(
      async (job) => {
        const details = await this.verifyFocus();
        if (!details.editable) {
          throw new CdpFault(
            "input",
            "Focus a supported remote text control before typing.",
          );
        }
        await this.request("Input.insertText", { text: job.text! });
        if (details.range) await this.readCaret();
      },
      false,
      text,
    );
  }

  key(key: Key): void {
    this.enqueue(async () => {
      await this.verifyFocus();
      if (key.type === "keyUp") this.keys.delete(key.code ?? key.key ?? "");
      else this.keys.set(key.code ?? key.key ?? "", key);
      await this.request("Input.dispatchKeyEvent", key);
      if (key.key === "Tab" && key.type !== "keyUp") await this.readFocus();
      else if (
        key.type !== "keyUp" &&
        !["Shift", "Control", "Alt", "Meta"].includes(key.key ?? "")
      )
        await this.readCaret();
    });
  }

  navigate(action: "back" | "forward" | "reload" | { url: string }): void {
    let url = "";
    if (typeof action !== "string") {
      try {
        const parsed = new URL(action.url);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
        url = parsed.href;
      } catch {
        this.setError(
          new CdpFault(
            "input",
            "Enter an absolute http:// or https:// page address.",
          ),
        );
        return;
      }
    }
    this.invalidate(true);
    this.enqueue(async () => {
      if (action === "reload") await this.request("Page.reload", undefined);
      else if (action === "back" || action === "forward") {
        const history = await this.request(
          "Page.getNavigationHistory",
          undefined,
        );
        const entry =
          history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
        if (entry)
          await this.request("Page.navigateToHistoryEntry", {
            entryId: entry.id,
          });
      } else {
        const result = await this.request("Page.navigate", { url });
        if (result.errorText)
          throw new CdpFault(
            "input",
            "The remote page could not be navigated.",
          );
      }
    });
  }

  private async verifyFocus(): Promise<{
    editable: boolean;
    range: boolean;
    point: Point;
  }> {
    if (!this.focusObject)
      throw new CdpFault(
        "input",
        "Click the remote page to establish input focus.",
      );
    const result = await this.request("Runtime.callFunctionOn", {
      objectId: this.focusObject,
      functionDeclaration: focusDetails,
      returnByValue: true,
    });
    const value: unknown = result.result.value;
    if (
      result.exceptionDetails ||
      !isRecord(value) ||
      !value.supported ||
      typeof value.editable !== "boolean" ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      value.width <= 0 ||
      typeof value.height !== "number" ||
      value.height <= 0 ||
      typeof value.offsetX !== "number" ||
      typeof value.offsetY !== "number"
    ) {
      throw new CdpFault(
        "input",
        "Remote focus changed or the focused frame is unsupported. Click a supported control again.",
      );
    }
    this.setError(null);
    return {
      editable: value.editable,
      range: value.range === true,
      point: {
        x: Math.max(0, Math.min(1, (value.x - value.offsetX) / value.width)),
        y: Math.max(0, Math.min(1, (value.y - value.offsetY) / value.height)),
      },
    };
  }

  private async readFocus(): Promise<void> {
    this.clearFocus();
    const response = await this.request("Runtime.evaluate", {
      expression: focusedElement,
      objectGroup: "cdpv-input",
      returnByValue: false,
    });
    if (response.exceptionDetails || !response.result.objectId) return;
    this.focusObject = response.result.objectId;
    await this.readCaret();
  }

  private async readCaret(): Promise<void> {
    if (!this.focusObject) return;
    const detail = await this.verifyFocus();
    if (!detail.editable) return;
    this.caret(detail.point);
  }

  private updateHistory(): void {
    const epoch = this.epoch;
    if (this.historyEpoch === epoch) return;
    this.historyEpoch = epoch;
    this.enqueue(async () => {
      try {
        const history = await this.request(
          "Page.getNavigationHistory",
          undefined,
        );
        const current = history.entries[history.currentIndex];
        if (current) {
          this.navigationKnown = true;
          this.changed(
            Object.freeze({
              url: current.url,
              canGoBack: history.currentIndex > 0,
              canGoForward: history.currentIndex < history.entries.length - 1,
            }),
          );
        }
      } finally {
        if (this.historyEpoch === epoch) this.historyEpoch = -1;
      }
    });
  }

  private enqueue(run: Job["run"], move = false, text?: string): void {
    if (this.disposed) return;
    const last = this.jobs.at(-1);
    if (move && last?.move) this.jobs.pop();
    if (this.jobs.length >= 64) {
      this.reportFailure();
      return;
    }
    this.jobs.push({
      epoch: this.epoch,
      run,
      move,
      ...(text === undefined ? {} : { text }),
    });
    if (!this.running) void this.drain();
  }

  private async request<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    const epoch = this.executingEpoch;
    if (this.disposed || epoch !== this.epoch)
      throw new Error("Input cancelled");
    const releaseResult = (result: unknown) => {
      if (
        isRecord(result) &&
        isRecord(result.result) &&
        typeof result.result.objectId === "string"
      ) {
        this.client.notify(
          "Runtime.releaseObject",
          { objectId: result.result.objectId },
          this.sessionId,
        );
      }
    };
    const result = await this.client.request(
      method,
      params,
      this.sessionId,
      method === "Runtime.evaluate" ? releaseResult : undefined,
    );
    if (this.disposed || epoch !== this.epoch) {
      // A focus lookup can resolve after its local owner has already gone away.
      releaseResult(result);
      throw new Error("Input cancelled");
    }
    return result;
  }

  private reportFailure(error?: unknown): void {
    this.invalidate(true);
    this.setError(
      error instanceof CdpFault && error.kind === "input"
        ? error
        : new CdpFault(
            "input",
            "Remote input could not be completed. Unsent input was discarded; it will not be replayed.",
          ),
    );
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.jobs.length && !this.disposed) {
        const job = this.jobs.shift()!;
        if (job.epoch !== this.epoch) continue;
        try {
          if (
            (await this.owner()) &&
            !this.disposed &&
            job.epoch === this.epoch
          ) {
            this.executingEpoch = job.epoch;
            await job.run(job);
          }
        } catch (error) {
          if (!this.disposed && job.epoch === this.epoch)
            this.reportFailure(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
