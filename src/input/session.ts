import type { Protocol } from "devtools-protocol";
import type { CdpClient, CdpEvent } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import type { ViewerNavigation } from "../viewer/types";
import { frameViewport } from "./geometry";
import type { Point, Viewport } from "./geometry";
import { InputLifecycle } from "./lifecycle";
import type { InputOwner, InputStop, InputTransition } from "./lifecycle";
import { InputQueue } from "./queue";
import type { InputJob } from "./queue";

type Mouse = Protocol.Input.DispatchMouseEventRequest;
type Key = Protocol.Input.DispatchKeyEventRequest;
interface FocusDetails {
  editable: boolean;
  range: boolean;
  point: Point;
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
  private viewport: Viewport | null = null;
  private viewportVersion = 0;
  private readonly lifecycle: InputLifecycle;
  private readonly queue: InputQueue;
  private historyOwner: InputOwner | null = null;
  private navigationKnown = false;
  private frameId: string | null = null;
  private contextId: number | null = null;
  private caretJob: InputJob | null = null;
  private caretReading = false;
  private caretVersion = 0;

  constructor(
    private readonly client: CdpClient,
    readonly sessionId: string,
    owner: () => Promise<boolean>,
    private readonly changed: (value: ViewerNavigation | null) => void,
    private readonly resetLocal: () => void,
    private readonly caret: (point: Point) => void,
    private readonly setError: (error: CdpFault | null) => void,
  ) {
    this.lifecycle = new InputLifecycle(sessionId);
    this.queue = new InputQueue(client, this.lifecycle, owner, (error) =>
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
    this.queue.enqueue(async (job) => {
      await this.readFocus(job);
      if (!this.navigationKnown) this.updateHistory();
    });
  }

  blur(): void {
    this.transition("blur");
  }

  private beginFocus(job: InputJob): void {
    this.invalidateCaret();
    this.releaseObject(this.lifecycle.beginFocus(job.owner));
  }

  private releaseObject(objectId: string | null): void {
    if (objectId)
      this.client.notify("Runtime.releaseObject", { objectId }, this.sessionId);
  }

  private transition(reason: InputTransition): void {
    const cleanup = this.lifecycle.transition(reason);
    if (!cleanup) return;
    if (reason !== "blur" && reason !== "failed") this.invalidateViewport();
    this.invalidateCaret();
    this.queue.clear();
    this.releaseObject(cleanup.objectId);
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
    this.resetLocal();
  }

  dispose(reason: InputStop = "disposed"): void {
    if (!this.available) return;
    this.transition(reason);
    this.changed(null);
  }

  event(event: CdpEvent): void {
    if (!this.available || event.sessionId !== this.sessionId) return;
    const { method, params } = event;
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
      if (type === "mousePressed") this.beginFocus(job);
      this.lifecycle.pointer(
        job.owner,
        pointInViewport,
        type === "mousePressed" ? details.button : undefined,
      );
      await job.request("Input.dispatchMouseEvent", {
        type,
        ...pointInViewport,
        ...details,
        ...(job.wheel
          ? { deltaX: job.wheel.deltaX, deltaY: job.wheel.deltaY }
          : {}),
      });
      if (type === "mouseReleased" && details.button) {
        this.lifecycle.releaseButton(job.owner, details.button);
        await this.readFocus(job);
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
    let details: FocusDetails | null = null;
    this.queue.text(
      text,
      async (job) => {
        if (!details?.editable)
          throw new CdpFault(
            "input",
            "Focus a supported remote text control before typing.",
          );
        this.setError(null);
        await job.request("Input.insertText", { text: job.text! });
        if (details.range) this.refreshCaret(job);
      },
      async (job) => {
        details = await this.readFocusDetails(job);
      },
    );
  }

  key(key: Key): void {
    this.queue.enqueue(
      async (job) => {
        this.setError(null);
        if (key.type !== "keyUp") this.lifecycle.pressKey(job.owner, key);
        await job.request("Input.dispatchKeyEvent", key);
        // Keep ownership until release is confirmed so failure/blur can still
        // perform the original session's best-effort release cleanup.
        if (key.type === "keyUp") this.lifecycle.releaseKey(job.owner, key);
        if (key.key === "Tab" && key.type !== "keyUp")
          await this.readFocus(job);
        else if (
          key.type !== "keyUp" &&
          !["Shift", "Control", "Alt", "Meta"].includes(key.key ?? "")
        )
          this.refreshCaret(job);
      },
      false,
      async (job) => {
        await this.readFocusDetails(job);
      },
    );
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
    this.transition("navigation-started");
    this.queue.enqueue(async (job) => {
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

  private async verifyFocus(job: InputJob) {
    const detail = await this.readFocusDetails(job);
    this.setError(null);
    return detail;
  }

  private async readFocusDetails(job: InputJob): Promise<FocusDetails> {
    const objectId = this.lifecycle.focusedObject(job.owner);
    if (!objectId)
      throw new CdpFault(
        "input",
        "Click the remote page to establish input focus.",
      );
    const result = await job.request("Runtime.callFunctionOn", {
      objectId,
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
    return {
      editable: value.editable,
      range: value.range === true,
      point: {
        x: Math.max(0, Math.min(1, (value.x - value.offsetX) / value.width)),
        y: Math.max(0, Math.min(1, (value.y - value.offsetY) / value.height)),
      },
    };
  }

  private async readFocus(job: InputJob): Promise<void> {
    this.beginFocus(job);
    const response = await job.request("Runtime.evaluate", {
      expression: focusedElement,
      objectGroup: "cdpv-input",
      returnByValue: false,
    });
    if (response.exceptionDetails || !response.result.objectId) return;
    this.lifecycle.acceptFocus(job.owner, response.result.objectId);
    await this.readCaret(job);
  }

  private async readCaret(job: InputJob): Promise<void> {
    if (!this.lifecycle.focusedObject(job.owner)) return;
    const detail = await this.verifyFocus(job);
    if (detail.editable) this.caret(detail.point);
  }

  private invalidateCaret(): void {
    this.caretVersion++;
    this.caretJob = null;
  }

  private refreshCaret(job: InputJob): void {
    this.caretVersion++;
    this.caretJob = job;
    if (!this.caretReading) void this.drainCaret();
  }

  private async drainCaret(): Promise<void> {
    this.caretReading = true;
    try {
      while (this.caretJob && this.available) {
        const job = this.caretJob;
        const version = this.caretVersion;
        const objectId = this.lifecycle.focusedObject(job.owner);
        this.caretJob = null;
        if (!objectId) continue;
        try {
          const detail = await this.readFocusDetails(job);
          if (
            version === this.caretVersion &&
            objectId === this.lifecycle.focusedObject(job.owner) &&
            detail.editable
          )
            this.caret(detail.point);
        } catch {
          // Optional geometry never authorizes a write. The next write still
          // verifies focus; stale/failed reads cannot cancel or clear its error.
        }
      }
    } finally {
      this.caretReading = false;
    }
  }

  private updateHistory(): void {
    const owner = this.lifecycle.owner;
    if (this.historyOwner === owner) return;
    this.historyOwner = owner;
    this.queue.enqueue(async (job) => {
      try {
        const history = await job.request(
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
        if (this.historyOwner === owner) this.historyOwner = null;
      }
    });
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
