import type { Protocol } from "devtools-protocol";
import type { CdpClient, CdpEvent } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import type { ViewerNavigation } from "../viewer/types";
import { navigationAddress } from "./address";
import { frameViewport } from "./geometry";
import type { Point, Viewport } from "./geometry";
import { InputLifecycle } from "./lifecycle";
import type { InputOwner, InputStop, InputTransition } from "./lifecycle";
import { InputQueue } from "./queue";
import type { InputJob } from "./queue";
import { readSelection } from "./selection";
import type { SelectionResult } from "./selection";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
type Key = Protocol.Input.DispatchKeyEventRequest;
const caretPosition = `(() => {
  let doc = document, ox = 0, oy = 0;
  for (let depth = 0; depth < 8; depth++) {
    let e = doc.activeElement;
    while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
    if (!e) return null;
    if (['iframe','frame'].includes(e.localName)) {
      let inner;
      try { inner = e.contentDocument; } catch { return null; }
      if (!inner) return null;
      const rect = e.getBoundingClientRect();
      ox += rect.left + e.clientLeft; oy += rect.top + e.clientTop;
      doc = inner;
      continue;
    }
    if (e.disabled || e.readOnly || !(e.isContentEditable || e.localName === 'textarea' ||
        (e.localName === 'input' &&
         ['text','search','email','url','tel','password','number'].includes(e.type)))) return null;
    const rect = e.getBoundingClientRect();
    let x = rect.left + 4, y = rect.top + Math.min(rect.height, 20);
    const selection = doc.getSelection();
    if (e.isContentEditable && selection?.rangeCount && e.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(false);
      const caret = range.getBoundingClientRect();
      if (caret.height) { x = caret.left; y = caret.bottom; }
    }
    const viewport = window.visualViewport;
    return { x: x + ox, y: y + oy,
      width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
      offsetX: viewport?.offsetLeft ?? 0, offsetY: viewport?.offsetTop ?? 0 };
  }
  return null;
})()`;

/** Native focus belongs to Chromium; each selected session owns its input work. */
export class InputSession {
  private viewport: Viewport | null = null;
  private viewportVersion = 0;
  private readonly lifecycle: InputLifecycle;
  private readonly queue: InputQueue;
  private historyJob: InputJob | null = null;
  private historyReading = false;
  private historyVersion = 0;
  private navigationKnown = false;
  private frameId: string | null = null;
  private contextId: number | null = null;
  private caretJob: InputJob | null = null;
  private caretReading = false;
  private caretVersion = 0;
  private preeditSupported = true;
  private clipboardVersion = 0;

  constructor(
    private readonly client: CdpClient,
    readonly sessionId: string,
    private readonly member: () => Promise<boolean>,
    private readonly changed: (value: ViewerNavigation | null) => void,
    private readonly resetLocal: (reason: InputTransition) => void,
    private readonly caret: (point: Point) => void,
    private readonly setError: (error: CdpFault | null) => void,
    private readonly resetClipboard: () => void = () => {},
  ) {
    this.lifecycle = new InputLifecycle(sessionId);
    this.queue = new InputQueue(client, this.lifecycle, member, (error) =>
      this.reportFailure(error),
    );
  }

  get available(): boolean {
    return this.lifecycle.available;
  }

  get owner(): InputOwner | null {
    return this.available ? this.lifecycle.owner : null;
  }

  async start(): Promise<void> {
    const tree = await this.client.request(
      "Page.getFrameTree",
      undefined,
      this.sessionId,
    );
    if (!this.available) return;
    this.frameId = tree.frameTree.frame.id;
    await this.client.request("Runtime.enable", undefined, this.sessionId);
    if (this.available) this.updateHistory();
  }

  focus(): void {
    this.refreshCaret(this.queue.capture());
  }

  blur(): void {
    this.transition("blur");
  }

  private transition(reason: InputTransition): void {
    const cleanup = this.lifecycle.transition(reason);
    if (!cleanup) return;
    const refreshHistory = this.historyReading || this.historyJob !== null;
    this.historyVersion++;
    this.historyJob = null;
    this.clipboardVersion++;
    if (reason !== "blur") this.resetClipboard();
    if (reason !== "blur" && reason !== "failed") this.invalidateViewport();
    this.invalidateCaret();
    this.queue.clear();
    if (cleanup.composition) this.cancelComposition(cleanup.owner);
    for (const key of cleanup.keys)
      this.client.notify(
        "Input.dispatchKeyEvent",
        { ...key, type: "keyUp", modifiers: 0 },
        cleanup.owner.sessionId,
      );
    for (const button of cleanup.buttons)
      this.client.notify(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...cleanup.point, button, buttons: 0 },
        cleanup.owner.sessionId,
      );
    this.resetLocal(reason);
    if (reason === "blur" && refreshHistory) this.updateHistory();
  }

  dispose(reason: InputStop = "disposed"): void {
    if (!this.available) return;
    this.transition(reason);
    this.changed(null);
  }

  event(event: CdpEvent): void {
    if (!this.available || event.sessionId !== this.sessionId) return;
    const { method, params } = event;
    if (
      [
        "Page.frameNavigated",
        "Page.frameStartedNavigating",
        "Page.frameDetached",
        "Page.navigatedWithinDocument",
        "Runtime.executionContextDestroyed",
        "Runtime.executionContextsCleared",
      ].includes(method)
    )
      this.invalidateClipboard();
    if (method === "Page.frameResized") this.invalidateViewport();
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
    const mainNavigating =
      mainFrameEvent && method === "Page.frameStartedNavigating";
    const sameDocument =
      mainFrameEvent && method === "Page.navigatedWithinDocument";
    if (
      mainNavigation ||
      mainNavigating ||
      sameDocument ||
      method === "Runtime.executionContextsCleared" ||
      (method === "Runtime.executionContextDestroyed" &&
        params.executionContextId === this.contextId)
    ) {
      this.transition(
        mainNavigating
          ? "navigation-started"
          : sameDocument
            ? "same-document"
            : "document-lost",
      );
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

  /** The renderer calls this only when this exact frame has been painted. */
  frame(metadata: unknown): () => void {
    const viewport = frameViewport(metadata);
    const version = this.viewportVersion;
    const document = this.lifecycle.owner.document;
    return () => {
      if (
        this.available &&
        version === this.viewportVersion &&
        document === this.lifecycle.owner.document
      )
        this.viewport = viewport;
    };
  }

  private invalidateViewport(): void {
    this.viewportVersion++;
    this.viewport = null;
  }

  private async readViewport(job: InputJob): Promise<Viewport> {
    const viewport = (await job.request("Page.getLayoutMetrics", undefined))
      .cssVisualViewport;
    if (
      ![viewport.clientWidth, viewport.clientHeight].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new CdpFault(
        "input",
        "The remote viewport is unavailable for input.",
      );
    return { width: viewport.clientWidth, height: viewport.clientHeight };
  }

  pointer(
    type: Mouse["type"],
    point: Point,
    details: Pick<
      Mouse,
      "button" | "buttons" | "clickCount" | "modifiers" | "deltaX" | "deltaY"
    >,
  ): void {
    if (type === "mousePressed") this.invalidateClipboard();
    let viewport: Viewport | null = null;
    let version = this.viewportVersion;
    const prepare = async (job: InputJob) => {
      version = this.viewportVersion;
      viewport = this.viewport ?? (await this.readViewport(job));
    };
    const run = async (job: InputJob) => {
      if (!viewport || version !== this.viewportVersion)
        viewport = await this.readViewport(job);
      const pointInViewport = {
        // Input coordinates are relative to the visible CSS viewport. Adding
        // its layout offset would apply pinch-pan translation a second time.
        x: point.x * viewport.width,
        y: point.y * viewport.height,
      };
      if (type === "mousePressed") this.invalidateCaret();
      this.lifecycle.pointer(
        job.owner,
        pointInViewport,
        type === "mousePressed" ? details.button : undefined,
      );
      const button = type === "mouseReleased" ? details.button : undefined;
      const pressed = button
        ? this.lifecycle.pressedButton(job.owner, button)
        : undefined;
      this.setError(null);
      job.dispatch(
        "Input.dispatchMouseEvent",
        {
          type,
          ...pointInViewport,
          ...details,
          ...(job.wheel
            ? { deltaX: job.wheel.deltaX, deltaY: job.wheel.deltaY }
            : {}),
        },
        () => {
          if (button) this.lifecycle.releaseButton(job.owner, button, pressed);
        },
      );
      if (type === "mouseReleased" && details.button) {
        this.refreshCaret(job);
        if (!this.navigationKnown) this.updateHistory();
      }
    };
    if (type === "mouseWheel")
      this.queue.wheel(
        {
          point,
          modifiers: details.modifiers ?? 0,
          deltaX: details.deltaX ?? 0,
          deltaY: details.deltaY ?? 0,
        },
        run,
        prepare,
      );
    else this.queue.enqueue(run, type === "mouseMoved", prepare);
  }

  text(text: string, owner: InputOwner = this.lifecycle.owner): void {
    if (!this.lifecycle.owns(owner)) return;
    this.invalidateClipboard();
    this.queue.text(text, (job) => {
      this.setError(null);
      const token = this.lifecycle.composition(job.owner);
      job.dispatch("Input.insertText", { text: job.text! }, () =>
        this.lifecycle.finishComposition(job.owner, token),
      );
      this.refreshCaret(job);
    });
  }

  preedit(
    text: string,
    owner: InputOwner,
    selectionStart = text.length,
    selectionEnd = selectionStart,
  ): void {
    if (!this.preeditSupported || !this.lifecycle.owns(owner)) return;
    this.invalidateClipboard();
    this.queue.preedit({ text, selectionStart, selectionEnd }, async (job) => {
      if (!this.preeditSupported) return;
      const value = job.preedit!;
      const token = value.text
        ? this.lifecycle.compose(job.owner)
        : this.lifecycle.composition(job.owner);
      try {
        await job.request("Input.imeSetComposition", value);
        if (!value.text) this.lifecycle.finishComposition(job.owner, token);
        this.refreshCaret(job);
      } catch (error) {
        if (error instanceof CdpFault && error.code === -32601) {
          this.preeditSupported = false;
          this.lifecycle.finishComposition(job.owner, token);
        } else throw error;
      } finally {
        // Finish original-document cleanup before the queue admits a new owner.
        if (
          !this.lifecycle.owns(job.owner) &&
          this.lifecycle.retainsDocument(job.owner)
        )
          this.cancelComposition(job.owner);
      }
    });
  }

  commitComposition(text: string, owner: InputOwner): void {
    if (!this.lifecycle.owns(owner)) return;
    // The final result replaces the composing range; an unsent preview is obsolete.
    this.queue.discardPreedit();
    if (text) {
      this.text(text, owner);
      return;
    }
    this.queue.enqueue(async (job) => {
      const token = this.lifecycle.composition(job.owner);
      if (!token) return;
      await job.request("Input.imeSetComposition", {
        text: "",
        selectionStart: 0,
        selectionEnd: 0,
      });
      this.lifecycle.finishComposition(job.owner, token);
    });
  }

  private cancelComposition(owner: InputOwner): void {
    this.client.notify(
      "Input.imeSetComposition",
      {
        text: "",
        selectionStart: 0,
        selectionEnd: 0,
      },
      owner.sessionId,
    );
  }

  key(key: Key): void {
    if (
      key.type !== "keyUp" &&
      !["Shift", "Control", "Alt", "Meta"].includes(key.key ?? "")
    )
      this.invalidateClipboard();
    this.queue.enqueue((job) => {
      // Releasing the clipboard shortcut's modifier is cleanup, not a new
      // successful edit. Preserve any copy/paste diagnostic until a new action.
      if (key.type !== "keyUp") this.setError(null);
      const pressed = this.lifecycle.pressedKey(job.owner, key);
      if (key.type !== "keyUp") this.lifecycle.pressKey(job.owner, key);
      job.dispatch("Input.dispatchKeyEvent", key, () => {
        if (key.type === "keyUp")
          this.lifecycle.releaseKey(job.owner, key, pressed);
      });
      if (
        key.type !== "keyUp" &&
        !["Shift", "Control", "Alt", "Meta"].includes(key.key ?? "")
      )
        this.refreshCaret(job);
    });
  }

  selection(owner: InputOwner): Promise<SelectionResult> {
    if (!this.lifecycle.owns(owner))
      return Promise.reject(new Error("Selection cancelled"));
    const version = ++this.clipboardVersion;
    const frameId = this.frameId;
    const current = () =>
      this.lifecycle.owns(owner) && version === this.clipboardVersion;
    return this.queue.read(
      owner,
      async (job) => {
        if (!frameId) throw new Error("Selection unavailable");
        return readSelection(job, frameId, current, (objectId) =>
          this.client.notify(
            "Runtime.releaseObject",
            { objectId },
            this.sessionId,
          ),
        );
      },
      current,
    );
  }

  clipboardError(message: string): void {
    this.setError(new CdpFault("input", message));
  }

  private invalidateClipboard(): void {
    this.clipboardVersion++;
    this.resetClipboard();
  }

  navigate(action: "back" | "forward" | "reload" | { url: string }): void {
    let url = "";
    if (typeof action !== "string") {
      url = navigationAddress(action.url) ?? "";
      if (!url) {
        this.setError(
          new CdpFault(
            "input",
            "Enter a page address, such as example.com or about:blank.",
          ),
        );
        return;
      }
    }
    this.transition("navigation-started");
    this.queue.barrier(async (job) => {
      if (action === "reload") await job.request("Page.reload", undefined);
      else if (action === "back" || action === "forward") {
        const history = await job.request(
          "Page.getNavigationHistory",
          undefined,
        );
        const entry =
          history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
        if (entry)
          await job.request("Page.navigateToHistoryEntry", {
            entryId: entry.id,
          });
      } else {
        const result = await job.request("Page.navigate", { url });
        if (result.errorText)
          throw new CdpFault(
            "input",
            "The remote page could not be navigated.",
          );
      }
    });
  }

  private async readCaret(job: InputJob): Promise<Point | null> {
    const result = await job.request("Runtime.evaluate", {
      expression: caretPosition,
      returnByValue: true,
    });
    const value: unknown = result.result.value;
    if (
      result.exceptionDetails ||
      !isRecord(value) ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      value.width <= 0 ||
      typeof value.height !== "number" ||
      value.height <= 0 ||
      typeof value.offsetX !== "number" ||
      typeof value.offsetY !== "number" ||
      ![
        value.x,
        value.y,
        value.width,
        value.height,
        value.offsetX,
        value.offsetY,
      ].every(Number.isFinite)
    )
      return null;
    return {
      x: Math.max(0, Math.min(1, (value.x - value.offsetX) / value.width)),
      y: Math.max(0, Math.min(1, (value.y - value.offsetY) / value.height)),
    };
  }

  private invalidateCaret(): void {
    this.caretVersion++;
    this.caretJob = null;
  }

  private refreshCaret(job: InputJob): void {
    this.caretVersion++;
    this.caretJob = job;
    if (!this.caretReading)
      this.drainCaret().catch((error: unknown) => {
        if (this.available) this.reportFailure(error);
      });
  }

  private async drainCaret(): Promise<void> {
    this.caretReading = true;
    try {
      while (this.caretJob && this.available) {
        const job = this.caretJob;
        const version = this.caretVersion;
        this.caretJob = null;
        try {
          const point = await this.readCaret(job);
          if (
            version === this.caretVersion &&
            this.lifecycle.owns(job.owner) &&
            point
          )
            this.caret(point);
        } catch {
          // Optional metadata never authorizes input or changes its error state.
        }
      }
    } finally {
      this.caretReading = false;
    }
  }

  private updateHistory(): void {
    if (!this.available) return;
    this.historyVersion++;
    this.historyJob = this.queue.capture();
    if (!this.historyReading)
      this.drainHistory().catch(() => {
        // Optional failures never discard input or change its diagnostic.
        // Resume only a refresh already requested while this read was active.
        if (this.historyJob && !this.historyReading) this.updateHistory();
      });
  }

  private async drainHistory(): Promise<void> {
    this.historyReading = true;
    try {
      while (this.historyJob && this.available) {
        const job = this.historyJob;
        const version = this.historyVersion;
        this.historyJob = null;
        const current = () =>
          version === this.historyVersion && this.lifecycle.owns(job.owner);
        if (!current() || !(await this.member()) || !current()) continue;
        const history = await job.request(
          "Page.getNavigationHistory",
          undefined,
        );
        if (!current()) continue;
        const entry = history.entries[history.currentIndex];
        this.navigationKnown = !!entry;
        this.changed(
          entry
            ? Object.freeze({
                url: entry.url,
                canGoBack: history.currentIndex > 0,
                canGoForward: history.currentIndex < history.entries.length - 1,
              })
            : null,
        );
      }
    } finally {
      this.historyReading = false;
    }
  }

  private reportFailure(error?: unknown): void {
    this.transition("failed");
    this.setError(
      error instanceof CdpFault && error.kind === "input"
        ? error
        : new CdpFault(
            "input",
            "Remote input could not be completed. Unsent input was discarded; it will not be replayed.",
          ),
    );
  }
}
