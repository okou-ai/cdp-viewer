import { timeout } from "signal-timers";
import { CdpClient } from "../cdp/client";
import type { CdpEvent, SocketFactory } from "../cdp/client";
import {
  CdpFault,
  diagnostic,
  requestDetails,
  isRecord,
  validateConfiguration,
} from "../cdp/errors";
import { TargetDirectory } from "../cdp/targets";
import { openTab } from "../cdp/tabs";
import { ExtensionRuntime } from "../extensions/runtime";
import type { ViewerExtension } from "../extensions/types";
import { InputSession } from "../input/session";
import type { InputTransition } from "../input/lifecycle";
import type { InputStop } from "../input/lifecycle";
import type { Point } from "../input/geometry";
import type { FrameSink } from "../render/canvas";
import { DisplaySync } from "../display/sync";
import { DisplayViewport } from "../display/viewport";
import type { DisplaySize } from "../display/geometry";
import { positive } from "../display/geometry";
import type { TabAction, ViewerIntentTransition, ViewerModel } from "./model";
import type {
  ViewerCaptureOptions,
  CdpViewerProps,
  ViewerError,
  WindowSizeSync,
} from "./types";
import { captureSettings, capturePreferences, sameCapture } from "./capture";
import type { CaptureSettings } from "./capture";
import { Screencast } from "./screencast";
import { readFavicon } from "./favicon";
import { TargetDiscovery } from "./discovery";
import { ImageRecoveryRuntime } from "./image-recovery-runtime";
import type { ImageRetirement, ImageSelection } from "./image-recovery-runtime";
import type { ViewerIntent } from "./lifecycle";

interface FaviconDocument {
  wanted: boolean;
  waiting: boolean;
  ready: boolean;
}

interface Selection extends ImageSelection {
  frameSessionId: string | null;
  favicon: FaviconDocument;
}

const minimumCaptureIntervalMs = 150;
const captureSettleMs = 200;
const maximumCaptureWaitMs = 1000;

interface CaptureChange {
  readonly settings: CaptureSettings;
  readonly first: number;
  readonly last: number;
}

interface Retirement {
  input: InputSession;
  complete: Promise<void>;
  start: () => void;
}

interface SelectionRetirement {
  readonly selection: Selection | null;
  readonly image: ImageRetirement | null;
  readonly control: Retirement | null;
}

interface ControllerOptions {
  url: string;
  windowId?: number;
  paused?: boolean;
  socketFactory?: SocketFactory;
  requestTimeout?: number;
  interactive?: boolean;
  transport?: CdpViewerProps["transport"];
  capture?: ViewerCaptureOptions;
  onInputReset?: (reason: InputTransition) => void;
  onClipboardReset?: () => void;
  onCaret?: (point: Point) => void;
  onTabCreated?: () => void;
  onTabClosed?: (targetId: string) => void;
}

/** Lifetime is one mounted connection, never an endpoint-keyed global. */
export class ViewerController {
  private readonly lifetime = new AbortController();
  private readonly ownedSessions = new Set<string>();
  private readonly ownedFrameSessions = new Set<string>();
  private readonly retirements = new Map<string, Retirement>();
  private readonly imageRecovery: ImageRecoveryRuntime;
  private client: CdpClient | null = null;
  private frames: CdpClient | null = null;
  private directory: TargetDirectory | null = null;
  private discovery: TargetDiscovery | null = null;
  private selection: Selection | null = null;
  private disposed = false;
  private connected = false;
  private chosenOnce = false;
  private targetRevision = 0;
  private extensionRequest = 0;
  private extensionDescriptors: readonly ViewerExtension[] = [];
  private extensions: ExtensionRuntime | null = null;
  private display: DisplaySync | null = null;
  private displayMode: WindowSizeSync = "off";
  private displaySize: DisplaySize | null = null;
  private capture: ViewerCaptureOptions = Object.freeze({});
  private captureSize: DisplaySize | null = null;
  private captureUpdate: AbortController | null = null;
  private captureUpdated = -Infinity;
  private captureStarted: CaptureSettings | null = null;
  private captureChange: CaptureChange | null = null;
  private captureError: ViewerError | null = null;
  private waitingForCapture = false;
  private faviconPending = false;
  private faviconAvailable = true;

  constructor(
    private readonly model: ViewerModel,
    private readonly sink: FrameSink,
    private readonly options: ControllerOptions,
  ) {
    this.imageRecovery = new ImageRecoveryRuntime(model, sink, {
      client: () => this.client!,
      display: () => this.display,
      current: (selection) => this.isCurrent(selection),
      available: () => !this.disposed && this.connected && !this.paused,
      disposed: () => this.disposed,
      assertMember: (targetId) => this.directory!.assertMember(targetId),
      select: (targetId) => this.select(targetId),
      lost: (error) => this.loseSelection(error),
    });
  }

  start(): void {
    this.model.run(this.model.commitIntent$, {
      type: "pause",
      paused: this.options.paused ?? false,
    });
    this.model.run(this.model.configure$, {
      interactive: this.options.interactive ?? false,
      scoped: this.options.windowId !== undefined,
    });
    this.waitingForCapture = true;
    this.setCapture(this.options.capture);
  }

  private get paused(): boolean {
    return this.model.read(this.model.intent$).paused;
  }

  private get selectionRevision(): object {
    return this.model.read(this.model.intent$).selection;
  }

  get input(): InputSession | null {
    const selection = this.selection;
    return selection?.painted &&
      selection.inputReady &&
      selection.input?.available &&
      this.isCurrent(selection)
      ? selection.input
      : null;
  }

  select(targetId: string): void {
    if (
      this.disposed ||
      !this.connected ||
      !this.model.getSnapshot().targets.some((t) => t.id === targetId)
    )
      return;
    this.chosenOnce = true;
    this.extensionRequest++;
    const controls = this.model.read(this.model.controls$);
    const preview =
      !this.paused && (controls.streaming || controls.loadingPreview);
    const revision = this.changeSelection(
      { type: "select", targetId, paused: this.paused, preview },
      "target-replaced",
      { retainFrame: preview },
    );
    if (
      this.paused ||
      this.disposed ||
      !this.connected ||
      revision !== this.model.read(this.model.intent$)
    )
      return;
    const selection: Selection = {
      intent: revision,
      targetId,
      sessionId: null,
      frameSessionId: null,
      painted: false,
      stream: null,
      input: null,
      inputReady: !this.options.interactive,
      geometry: new DisplayViewport(),
      favicon: { wanted: true, waiting: false, ready: false },
    };
    this.selection = selection;
    this.discovery?.watch(targetId);
    this.attach(selection).catch((error: unknown) => {
      if (this.isCurrent(selection)) this.fail(error);
    });
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    const intent = this.changeSelection({ type: "pause", paused }, "paused");
    if (
      !paused &&
      !this.disposed &&
      this.connected &&
      intent === this.model.read(this.model.intent$) &&
      !this.model.read(this.model.imageRecovery$)
    ) {
      const id = intent.targetId;
      if (id) this.select(id);
      else this.refresh();
    }
  }

  retryImage(): void {
    this.imageRecovery.retry(this.selection);
  }

  setExtensions(extensions: readonly ViewerExtension[]): void {
    if (this.disposed) return;
    this.extensionDescriptors = extensions;
    this.extensions?.reconcile(extensions);
  }

  setWindowSizeSync(mode: WindowSizeSync): void {
    this.displayMode = mode;
    this.display?.setMode(mode);
  }

  measureDisplay(size: DisplaySize | null): void {
    if (this.disposed) return;
    this.displaySize = size;
    this.display?.measure(size);
    if (size && [size.width, size.height, size.dpr].every(positive)) {
      this.captureSize = size;
      this.scheduleCapture();
    } else this.cancelCaptureUpdate();
  }

  syncDisplay(): void {
    this.display?.sync();
  }

  setCapture(options?: ViewerCaptureOptions): void {
    if (this.disposed) return;
    let settings: ViewerCaptureOptions;
    try {
      settings = capturePreferences(options);
    } catch (error) {
      const next = diagnostic(error);
      if (this.captureError?.message === next.message) return;
      this.captureError = next;
      if (this.waitingForCapture)
        this.model.transition({ type: "failed", error: next });
      else this.model.update({ error: next });
      return;
    }
    const changed = !sameCapture(this.capture, settings);
    this.capture = settings;
    if (
      this.captureError &&
      this.model.getSnapshot().error === this.captureError
    )
      this.model.update({ error: null });
    this.captureError = null;
    if (this.waitingForCapture) {
      this.waitingForCapture = false;
      this.model.transition({ type: "reset" });
      this.connect().catch((error: unknown) => {
        if (!this.disposed && !this.lifetime.signal.aborted) this.fail(error);
      });
    } else if (changed) this.configureCapture();
  }

  private cancelCaptureUpdate(): void {
    this.captureUpdate?.abort();
    this.captureUpdate = null;
    this.captureChange = null;
  }

  private configureCapture(): void {
    this.cancelCaptureUpdate();
    const selection = this.selection;
    if (!selection?.stream || !this.isCurrent(selection)) return;
    this.captureUpdated = performance.now();
    selection.stream.configure(captureSettings(this.capture, this.captureSize));
  }

  private scheduleCapture(): void {
    const selection = this.selection;
    if (
      !selection?.stream ||
      !this.isCurrent(selection) ||
      !this.displaySize ||
      ![
        this.displaySize.width,
        this.displaySize.height,
        this.displaySize.dpr,
      ].every(positive) ||
      this.model.read(this.model.display$).pending
    )
      return;
    const settings = captureSettings(this.capture, this.captureSize);
    if (this.captureStarted && sameCapture(this.captureStarted, settings)) {
      this.cancelCaptureUpdate();
      return;
    }
    const now = performance.now();
    let change = this.captureChange;
    if (change && sameCapture(change.settings, settings)) {
      if (this.captureUpdate) return;
    } else {
      change = {
        settings,
        first: change?.first ?? now,
        last: now,
      };
      this.captureChange = change;
    }
    this.captureUpdate?.abort();
    const update = new AbortController();
    this.captureUpdate = update;
    const deadline = Math.max(
      this.captureUpdated + minimumCaptureIntervalMs,
      Math.min(
        change.last + captureSettleMs,
        change.first + maximumCaptureWaitMs,
      ),
    );
    timeout(
      () => {
        if (this.captureUpdate !== update) return;
        this.captureUpdate = null;
        if (!this.isCurrent(selection)) return;
        // A delayed stop/start may have begun a capture after this timer was
        // queued. Retain the interval from that actual start as well.
        if (performance.now() - this.captureUpdated < minimumCaptureIntervalMs)
          this.scheduleCapture();
        else this.configureCapture();
      },
      Math.max(0, Math.ceil(deadline - now)),
      { signal: update.signal },
    );
  }

  private async requestExtensionSelection(
    targetId: string,
    ownerCurrent: () => boolean,
  ): Promise<boolean> {
    const snapshot = this.model.getSnapshot();
    if (
      this.disposed ||
      !this.connected ||
      !ownerCurrent() ||
      typeof targetId !== "string" ||
      !targetId.trim() ||
      !snapshot.targets.some((target) => target.id === targetId)
    )
      return false;
    const request = ++this.extensionRequest;
    // The current target still supersedes an older pending suggestion.
    if (snapshot.selectedTargetId === targetId) return false;
    const selectionRevision = this.selectionRevision;
    const targetRevision = this.targetRevision;
    const current = () =>
      !this.disposed &&
      this.connected &&
      ownerCurrent() &&
      request === this.extensionRequest &&
      selectionRevision === this.selectionRevision &&
      targetRevision === this.targetRevision;
    try {
      const result: unknown = await this.client!.request(
        "Target.getTargetInfo",
        {
          targetId,
        },
      );
      if (
        !current() ||
        !isRecord(result) ||
        !isRecord(result.targetInfo) ||
        result.targetInfo.targetId !== targetId ||
        result.targetInfo.type !== "page" ||
        result.targetInfo.subtype === "prerender"
      )
        return false;
      await this.directory!.assertMember(targetId);
      if (
        !current() ||
        !this.model
          .getSnapshot()
          .targets.some((target) => target.id === targetId)
      )
        return false;
      this.select(targetId);
      return true;
    } catch {
      // Invalid/stale suggestions must not tear down the established stream.
      return false;
    }
  }

  createTab(): void {
    const source = this.selection;
    const owner = source?.input?.owner;
    const revision = this.selectionRevision;
    if (
      !this.canMutateTab() ||
      (source
        ? !source.sessionId || !owner
        : !this.model.read(this.model.controls$).emptyUnscoped)
    )
      return;
    const client = this.client!;
    const directory = this.directory!;
    const current = () =>
      this.connected &&
      !this.disposed &&
      this.selectionRevision === revision &&
      (!source ||
        (this.isCurrent(source) &&
          source.input?.owner?.document === owner?.document));
    this.chosenOnce = true;
    this.mutateTab(
      { type: "create" },
      async () => {
        const targetId = await openTab(
          client,
          directory,
          source?.sessionId
            ? {
                targetId: source.targetId,
                sessionId: source.sessionId,
              }
            : null,
          current,
        );
        if (!current()) return;
        const observation = this.discovery!.beginCreation(targetId);
        const targets = await directory.list();
        if (!current()) return;
        if (!targets.some((target) => target.id === targetId))
          throw new CdpFault(
            "tab",
            "The new tab is no longer available in this scope.",
          );
        this.targetRevision++;
        const created = targets.find((target) => target.id === targetId)!;
        const accepted = this.discovery!.created(created, observation);
        if (!current()) return;
        if (!accepted)
          throw new CdpFault(
            "tab",
            "The new tab is no longer available in this scope.",
          );
        this.model.update({ error: null });
        if (!current()) return;
        this.model.run(this.model.resetAddress$);
        if (!current()) return;
        this.select(targetId);
        if (
          !this.disposed &&
          this.connected &&
          this.model.getSnapshot().selectedTargetId === targetId
        )
          this.options.onTabCreated?.();
      },
      current,
    );
  }

  closeTab(targetId: string): void {
    if (!this.canMutateTab()) return;
    const snapshot = this.model.getSnapshot();
    const index = snapshot.targets.findIndex(
      (target) => target.id === targetId,
    );
    if (index < 0) return;
    const selected = snapshot.selectedTargetId === targetId;
    const revision = this.selectionRevision;
    this.mutateTab({ type: "close", targetId }, async () => {
      await this.directory!.assertMember(targetId);
      if (this.disposed || !this.connected) return;
      if (
        !this.model
          .getSnapshot()
          .targets.some((target) => target.id === targetId)
      )
        return;
      const result = await this.client!.request("Target.closeTarget", {
        targetId,
      });
      if (this.disposed || !this.connected) return;
      if (!result.success)
        throw new CdpFault("tab", "The browser did not close the tab.");
      this.targetRevision++;
      this.discovery?.removed(targetId);
      if (this.disposed || !this.connected) return;
      this.options.onTabClosed?.(targetId);
      if (this.disposed || !this.connected) return;
      const targets = this.model.getSnapshot().targets;
      this.model.update({ error: null });
      if (this.disposed || !this.connected) return;
      if (this.model.getSnapshot().selectedTargetId === targetId) {
        this.loseSelection(null);
      }
      if (selected && revision === this.selectionRevision) {
        // Discovery can remove preceding tabs while closure is pending.
        const preceding = new Set(
          snapshot.targets.slice(0, index).map((target) => target.id),
        );
        const next =
          targets.find((target) => !preceding.has(target.id)) ?? targets.at(-1);
        if (next) this.select(next.id);
        else this.loseSelection(null);
      }
    });
  }

  private canMutateTab(): boolean {
    return (
      this.connected &&
      !this.disposed &&
      this.model.read(this.model.controls$).canMutateTabs
    );
  }

  private mutateTab(
    action: TabAction,
    task: () => Promise<void>,
    report: () => boolean = () => true,
  ): void {
    this.model.run(this.model.setTabAction$, action);
    this.model.update({ error: null });
    task()
      .catch((error: unknown) => {
        if (!this.disposed && this.connected && report())
          this.model.update({
            error: diagnostic(
              error instanceof CdpFault &&
                ["tab", "scope", "unsupported-capability"].includes(error.kind)
                ? error
                : new CdpFault(
                    "tab",
                    "The tab operation could not be completed. Check the browser before trying again.",
                    undefined,
                    requestDetails(error),
                  ),
            ),
          });
      })
      .finally(() => {
        if (!this.disposed) this.model.run(this.model.setTabAction$, null);
      });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.changeSelection({ type: "closed" }, "disposed");
    } finally {
      // A publication may close us before its outer retirement has started.
      for (const retirement of this.retirements.values()) retirement.start();
      this.display?.close();
      this.sink.dispose();
      this.frames?.close();
      this.client?.close();
      this.ownedSessions.clear();
      this.ownedFrameSessions.clear();
      this.retirements.clear();
      this.imageRecovery.close();
    }
  }

  private async connect(): Promise<void> {
    validateConfiguration(this.options.url, this.options.windowId);
    const transport = this.options.transport ?? "shared";
    if (transport !== "shared" && transport !== "split")
      throw new CdpFault("configuration", "The transport mode is invalid.");
    const client = new CdpClient(
      this.options.url,
      this.options.socketFactory,
      this.options.requestTimeout,
    );
    this.client = client;
    this.frames = client;
    this.directory = new TargetDirectory(client, this.options.windowId);
    client.onEvent((event) => this.onEvent(event, client));
    client.onDisconnected((error) => this.disconnected(error, client));
    if (this.options.interactive && transport === "split") {
      try {
        const frames = new CdpClient(
          this.options.url,
          this.options.socketFactory,
          this.options.requestTimeout,
        );
        this.frames = frames;
        frames.onEvent((event) => this.onEvent(event, frames));
        frames.onDisconnected((error) => this.disconnected(error, frames));
      } catch (error) {
        client.close();
        // Closing rejects opening; observe it even if the second socket cannot exist.
        await Promise.allSettled([client.opened]);
        throw error;
      }
    }
    await Promise.all([client.opened, this.frames.opened]);
    if (this.disposed || this.lifetime.signal.aborted) return;
    await client.request("Target.setDiscoverTargets", { discover: true });
    if (this.disposed || this.lifetime.signal.aborted) return;
    this.connected = true;
    this.model.run(this.model.setConnected$, true);
    let displayError: ViewerError | null = null;
    this.display = new DisplaySync(client, {
      signal: this.lifetime.signal,
      presentationTimeout: this.options.requestTimeout,
      windowId: this.options.windowId,
      changed: (state) => {
        if (this.disposed) return;
        this.model.run(this.model.setDisplay$, state);
        if (state.pending) this.cancelCaptureUpdate();
        else this.scheduleCapture();
      },
      failed: (error) => {
        displayError = diagnostic(error);
        this.model.update({ error: displayError });
      },
      synchronized: () => {
        if (displayError && this.model.getSnapshot().error === displayError)
          this.model.update({ error: null });
        displayError = null;
      },
      refresh: async (prepare) => {
        const selection = this.selection;
        if (selection && this.isCurrent(selection))
          await this.restartCapture(selection, prepare);
      },
    });
    this.display.setMode(this.displayMode);
    this.display.measure(this.displaySize);
    this.extensions = new ExtensionRuntime({
      signal: this.lifetime.signal,
      subscribe: (listener) => client.onEvent(listener),
      getState: () => {
        const snapshot = this.model.getSnapshot();
        return Object.freeze({
          status: snapshot.status,
          selectedTargetId: snapshot.selectedTargetId,
          capabilities: Object.freeze({
            windowScoped: this.options.windowId !== undefined,
            interactive: this.options.interactive ?? false,
          }),
        });
      },
      requestTargetSelection: (targetId, current) =>
        this.requestExtensionSelection(targetId, current),
      reportError: (message) => {
        if (!this.disposed && this.connected)
          this.model.update({
            error: Object.freeze({ kind: "extension", message }),
          });
      },
    });
    this.extensions.reconcile(this.extensionDescriptors);
    this.discovery = new TargetDiscovery(this.directory, this.model, {
      signal: this.lifetime.signal,
      scoped: this.options.windowId !== undefined,
      changed: () => this.discovered(),
      failed: (error) => {
        if (this.disposed || !this.connected) return;
        this.changeSelection({
          type: "discovery-failed",
          error: diagnostic(error),
        });
      },
    });
    this.discovery.start();
  }

  private disconnected(error: CdpFault, source: CdpClient): void {
    if (this.disposed || this.lifetime.signal.aborted) return;
    const established = this.connected;
    const drainControl = source !== this.client;
    this.connected = false;
    this.changeSelection(
      { type: "disconnected", established, error: diagnostic(error) },
      "disconnected",
      { drainControl },
    );
    this.display?.close();
    this.frames?.close();
    this.ownedFrameSessions.clear();
    const closeControl = () => {
      this.client?.close();
      this.ownedSessions.clear();
      this.retirements.clear();
      this.imageRecovery.close();
    };
    // Video loss revokes admission immediately, but a live control socket can
    // still acknowledge its original pressed/composing cleanup. Never replay it.
    if (drainControl && this.retirements.size)
      Promise.allSettled(
        [...this.retirements.values()].map((value) => value.complete),
      ).then(closeControl, closeControl);
    else closeControl();
  }

  private refresh(): void {
    if (this.disposed || !this.connected) return;
    this.discovery?.refresh();
  }

  private discovered(): void {
    if (this.disposed || !this.connected) return;
    const targets = this.model.getSnapshot().targets;
    const selected = this.model.getSnapshot().selectedTargetId;
    if (selected && !targets.some((t) => t.id === selected)) {
      this.loseSelection(
        diagnostic(
          new CdpFault(
            "target-unavailable",
            "The selected target is no longer available in this scope.",
          ),
        ),
      );
    } else if (!selected && !this.chosenOnce && targets[0]) {
      this.select(targets[0].id);
    } else if (!selected) {
      this.model.transition({
        type: "target-lost",
        error: diagnostic(
          new CdpFault(
            "target-unavailable",
            targets.length
              ? "Select a target to resume viewing."
              : "No page targets are available in this scope.",
          ),
        ),
      });
    }
  }

  private async attach(selection: Selection): Promise<void> {
    const client = this.client!;
    const imageRetirement = this.imageRecovery.settle(selection.targetId);
    if (imageRetirement) await imageRetirement;
    if (!this.isCurrent(selection)) return;
    await this.retirements.get(selection.targetId)?.complete;
    if (!this.isCurrent(selection)) return;
    await this.directory!.assertMember(selection.targetId);
    if (!this.isCurrent(selection)) return;
    // A background tab may have no compositor surface until it is activated.
    await client.request("Target.activateTarget", {
      targetId: selection.targetId,
    });
    if (!this.isCurrent(selection)) return;
    await this.directory!.assertMember(selection.targetId);
    if (!this.isCurrent(selection)) return;
    const sessionId = await this.attachSession(client, selection.targetId);
    selection.sessionId = sessionId;
    this.ownedSessions.add(sessionId);
    if (!this.isCurrent(selection)) {
      this.release(selection);
      return;
    }
    const frames = this.frames!;
    if (frames === client) selection.frameSessionId = sessionId;
    else {
      await this.directory!.assertMember(selection.targetId);
      if (!this.isCurrent(selection)) return;
      const frameSessionId = await this.attachSession(
        frames,
        selection.targetId,
      );
      selection.frameSessionId = frameSessionId;
      this.ownedFrameSessions.add(frameSessionId);
      if (!this.isCurrent(selection)) {
        this.releaseFrames(selection);
        return;
      }
    }
    await this.directory!.assertMember(selection.targetId);
    if (!this.isCurrent(selection)) return;
    // Attach both owners before input/display calibrate native emulation.
    await client.request("Page.enable", undefined, sessionId);
    if (!this.isCurrent(selection)) return;
    let inputReady: Promise<void> = Promise.resolve();
    if (this.options.interactive) {
      const input = new InputSession(
        client,
        sessionId,
        // Discovery invalidates moved targets; stable input uses the selected session.
        async () => this.isCurrent(selection),
        (navigation) => {
          if (this.isCurrent(selection)) this.model.update({ navigation });
        },
        (reason) => {
          if (this.isCurrent(selection)) this.options.onInputReset?.(reason);
        },
        (point) => {
          if (!this.isCurrent(selection)) return;
          this.options.onCaret?.(point);
        },
        (error) => {
          if (
            this.isCurrent(selection) &&
            (error || this.model.getSnapshot().error?.kind === "input")
          )
            this.model.update({ error: error ? diagnostic(error) : null });
        },
        () => {
          if (this.isCurrent(selection)) this.options.onClipboardReset?.();
        },
        selection.geometry,
      );
      selection.input = input;
      inputReady = input.start().then(() => {
        if (!this.isCurrent(selection)) return;
        selection.inputReady = true;
        this.streaming(selection);
      });
    }
    const stream = new Screencast(
      {
        client: frames,
        sessionId: selection.frameSessionId!,
        sink: this.sink,
        current: () => this.isCurrent(selection),
        failed: (error) => {
          if (this.isCurrent(selection)) this.imageFailed(selection, error);
        },
        starting: (settings) => {
          this.captureUpdated = performance.now();
          this.captureStarted = settings;
          selection.geometry.setCapture({
            width: settings.maxWidth,
            height: settings.maxHeight,
          });
          this.scheduleCapture();
        },
      },
      captureSettings(this.capture, this.captureSize),
    );
    selection.stream = stream;
    await Promise.all([inputReady, stream.start()]);
    if (!this.isCurrent(selection)) return;
    this.display?.setTarget({
      targetId: selection.targetId,
      sessionId,
      current: () => this.isCurrent(selection),
      geometry: selection.geometry,
    });
  }

  private async attachSession(
    client: CdpClient,
    targetId: string,
  ): Promise<string> {
    const attached: unknown = await client.request(
      "Target.attachToTarget",
      { targetId, flatten: true },
      undefined,
      (late) => {
        if (isRecord(late) && typeof late.sessionId === "string") {
          client.notify("Target.detachFromTarget", {
            sessionId: late.sessionId,
          });
        }
      },
    );
    if (!isRecord(attached) || typeof attached.sessionId !== "string") {
      throw new CdpFault(
        "protocol",
        "The browser returned an invalid target session.",
      );
    }
    return attached.sessionId;
  }

  private isCurrent(selection: ImageSelection): boolean {
    const intent = this.model.read(this.model.intent$);
    return (
      !this.disposed &&
      this.connected &&
      !intent.paused &&
      selection.intent === intent &&
      this.selection === selection &&
      this.discovery?.current(selection.targetId) === true
    );
  }

  private async restartCapture(
    selection: Selection,
    prepare?: () => Promise<void>,
  ): Promise<void> {
    const stream = selection.stream;
    if (!stream) return;
    await stream.exclusive(async () => {
      let phase: "stopping" | "stopped" | "starting" = "stopping";
      try {
        await stream.stop();
        phase = "stopped";
        if (!this.isCurrent(selection)) return;
        await prepare?.();
        if (!this.isCurrent(selection)) return;
        phase = "starting";
        await stream.begin(
          captureSettings(this.capture, this.captureSize),
          !selection.painted,
        );
      } catch (error) {
        // Retain the original session's positive-stop restoration contract.
        const stopRejected =
          phase === "stopping" &&
          error instanceof CdpFault &&
          error.code !== undefined;
        if (this.isCurrent(selection)) {
          if (stopRejected) stream.resume();
          else
            try {
              if (phase !== "stopped") await stream.stop();
              if (!this.isCurrent(selection)) return;
              await stream.begin(
                captureSettings(this.capture, this.captureSize),
                !selection.painted,
              );
            } catch (restoreError) {
              if (this.isCurrent(selection))
                this.imageFailed(selection, restoreError);
            }
        }
        throw error;
      } finally {
        if (this.isCurrent(selection)) this.configureCapture();
      }
    });
  }

  private streaming(selection: Selection): void {
    if (
      this.isCurrent(selection) &&
      selection.painted &&
      selection.inputReady
    ) {
      if (!this.imageRecovery.ready(selection)) {
        this.display?.setSuspended(false);
        if (!this.isCurrent(selection)) return;
        this.model.transition({ type: "streaming" });
      }
      if (!this.isCurrent(selection)) return;
      if (this.captureError) this.model.update({ error: this.captureError });
      this.refreshFavicon(selection);
    }
  }

  private refreshFavicon(selection: Selection): void {
    const client = this.client;
    const sessionId = selection.sessionId;
    const document = selection.favicon;
    if (
      !client ||
      !sessionId ||
      !this.isCurrent(selection) ||
      !selection.painted ||
      !selection.inputReady ||
      !document.wanted ||
      !this.faviconAvailable ||
      this.faviconPending
    )
      return;
    document.wanted = false;
    document.waiting = !document.ready;
    this.faviconPending = true;
    readFavicon(client, sessionId)
      .then((url) => {
        if (!this.isCurrent(selection) || selection.favicon !== document)
          return;
        if (url === undefined) return;
        document.ready = true;
        document.waiting = false;
        this.model.run(this.model.setFavicon$, {
          targetId: selection.targetId,
          url,
        });
      })
      .catch((error: unknown) => {
        // A definite session/context rejection retires its request slot, so a
        // newer document can still be inspected. Never retry this failed read.
        // Unsupported or uncertain failures (including timeouts with a late
        // reply owner) stop further reads on this connection to bound that work.
        if (
          !(error instanceof CdpFault) ||
          error.code === undefined ||
          error.code === -32601
        )
          this.faviconAvailable = false;
        if (selection.favicon === document) {
          document.ready = true;
          document.waiting = false;
          document.wanted = false;
          if (this.isCurrent(selection))
            this.model.run(this.model.setFavicon$, {
              targetId: selection.targetId,
              url: null,
            });
        }
      })
      .finally(() => {
        this.faviconPending = false;
        if (this.selection) this.refreshFavicon(this.selection);
      });
  }

  private loseSelection(error: ViewerError | null): void {
    this.changeSelection({ type: "target-lost", error });
  }

  /** Register original obligations before publication can acquire a successor. */
  private takeSelection(
    reason: InputStop,
    { drainControl = false }: { drainControl?: boolean },
  ): SelectionRetirement {
    this.cancelCaptureUpdate();
    this.captureStarted = null;
    const selection = this.selection;
    const image = selection ? this.imageRecovery.retire(selection) : null;
    this.selection = null;
    const input = selection?.input;
    let control: Retirement | null = null;
    if (
      selection &&
      input &&
      (reason !== "disconnected" || drainControl) &&
      !this.disposed
    ) {
      let start!: () => void;
      const complete = new Promise<void>((resolve, reject) => {
        start = () => {
          try {
            resolve(
              input.retire(reason === "disconnected" ? "disposed" : reason),
            );
          } catch (error) {
            reject(error);
          }
        };
      });
      const retirement = { input, complete, start };
      control = retirement;
      this.retirements.set(selection.targetId, retirement);
      complete.then(
        () => {
          if (this.retirements.get(selection.targetId) === retirement)
            this.retirements.delete(selection.targetId);
          this.release(selection);
        },
        () => {
          // Unknown cleanup remains a same-target fence for this connection.
          this.release(selection);
        },
      );
    }
    return { selection, image, control };
  }

  /** One entry binds original retirement, originating intent and unconditional cleanup. */
  private changeSelection(
    event: ViewerIntentTransition,
    reason: InputStop = "target-replaced",
    options: { drainControl?: boolean; retainFrame?: boolean } = {},
  ): ViewerIntent {
    const retiring =
      event.type === "pause" && !event.paused
        ? null
        : this.takeSelection(reason, options);
    let intent: ViewerIntent | undefined;
    try {
      if (event.type === "closed" || event.type === "disconnected") {
        this.discovery?.close();
        if (event.type === "closed")
          this.model.run(this.model.setConnected$, false);
        this.lifetime.abort();
      }
      intent = this.model.run(this.model.commitIntent$, event);
      if (event.type === "pause" && event.paused)
        this.imageRecovery.cancel(retiring!.image);
      return intent;
    } finally {
      if (retiring) this.finishSelection(retiring, intent, reason, options);
    }
  }

  private finishSelection(
    retiring: SelectionRetirement,
    intent: ViewerIntent | undefined,
    reason: InputStop = "target-replaced",
    { retainFrame = false }: { retainFrame?: boolean } = {},
  ): void {
    const current = () =>
      intent === this.model.read(this.model.intent$) && this.selection === null;
    const old = retiring.selection;
    try {
      if (current()) this.discovery?.watch(null);
      if (current()) this.display?.setTarget(null);
      if (current()) this.display?.setSuspended(false);
      if (current()) {
        if (retainFrame) this.sink.invalidate();
        else this.sink.reset();
      }
      if (current()) this.model.transition({ type: "stopped", retainFrame });
    } finally {
      if (old) {
        const input = old.input;
        if (retiring.control) retiring.control.start();
        else input?.dispose(reason);
        this.stopStream(old);
        this.releaseFrames(old);
        if (!retiring.control) this.release(old);
        if (input && current()) {
          this.options.onClipboardReset?.();
          if (current()) this.options.onInputReset?.(reason);
        }
      }
    }
  }

  private release(selection: Selection): void {
    this.releaseFrames(selection);
    const id = selection.sessionId;
    if (!id || !this.ownedSessions.has(id)) return;
    this.stopStream(selection);
    this.ownedSessions.delete(id);
    this.client?.notify("Target.detachFromTarget", { sessionId: id });
  }

  private releaseFrames(selection: Selection): void {
    const id = selection.frameSessionId;
    if (this.frames === this.client || !id || !this.ownedFrameSessions.has(id))
      return;
    this.stopStream(selection);
    this.ownedFrameSessions.delete(id);
    this.frames?.notify("Target.detachFromTarget", { sessionId: id });
  }

  private stopStream(selection: Selection): void {
    selection.stream?.dispose();
  }

  private fail(error: unknown): void {
    if (this.lifetime.signal.aborted) return;
    this.changeSelection({
      type: "failed",
      error: diagnostic(error),
    });
  }

  private imageFailed(selection: Selection, error: unknown): void {
    const fault = diagnostic(error);
    const captureRequest = fault.request?.method;
    if (
      fault.kind !== "frame" &&
      !(
        fault.kind === "protocol" &&
        (captureRequest === "Page.startScreencast" ||
          captureRequest === "Page.stopScreencast")
      )
    ) {
      this.fail(error);
      return;
    }
    this.imageRecovery.fail(selection, fault);
  }

  private onEvent(event: CdpEvent, client: CdpClient): void {
    if (this.disposed) return;
    if (client === this.client) {
      const selected = this.selection;
      if (selected && event.sessionId === selected.sessionId) {
        if (
          event.method === "Page.frameStartedNavigating" &&
          typeof event.params.frameId === "string"
        )
          selected.stream?.navigationStarted(event.params.frameId);
        else if (
          event.method === "Page.frameNavigated" &&
          isRecord(event.params.frame) &&
          typeof event.params.frame.id === "string"
        )
          selected.stream?.navigationFinished(event.params.frame.id);
        else if (
          [
            "Page.frameStoppedLoading",
            "Page.frameDetached",
            "Page.navigatedWithinDocument",
          ].includes(event.method) &&
          typeof event.params.frameId === "string"
        )
          selected.stream?.navigationFinished(event.params.frameId);
        if (
          event.method === "Page.frameNavigated" &&
          isRecord(event.params.frame) &&
          !event.params.frame.parentId
        ) {
          // A restored document does not fire DOMContentLoaded again.
          const restored = event.params.type === "BackForwardCacheRestore";
          selected.favicon = {
            wanted: restored,
            waiting: !restored,
            ready: restored,
          };
          this.model.run(this.model.setFavicon$, {
            targetId: selected.targetId,
            url: null,
          });
          if (restored) this.refreshFavicon(selected);
        } else if (
          event.method === "Page.domContentEventFired" &&
          !selected.favicon.ready
        ) {
          selected.favicon.ready = true;
          if (selected.favicon.waiting) {
            selected.favicon.waiting = false;
            selected.favicon.wanted = true;
            this.refreshFavicon(selected);
          }
        }
      }
      if (event.sessionId === this.selection?.sessionId)
        this.selection?.geometry.event(event.method);
      this.selection?.input?.event(event);
      for (const retirement of this.retirements.values())
        retirement.input.event(event);
    }
    const params = event.params;
    if (event.method === "Page.screencastFrame") {
      const id = event.sessionId;
      if (
        !id ||
        client !== this.frames ||
        !(
          client === this.client ? this.ownedSessions : this.ownedFrameSessions
        ).has(id) ||
        !Number.isSafeInteger(params.sessionId)
      )
        return;
      client.notify(
        "Page.screencastFrameAck",
        { sessionId: params.sessionId as number },
        id,
      );
      const selection = this.selection;
      if (
        !selection ||
        selection.frameSessionId !== id ||
        !this.isCurrent(selection) ||
        !selection.stream?.acceptingFrames ||
        typeof params.data !== "string"
      )
        return;
      const paintedViewport = selection.geometry.frame(params.metadata);
      if (!paintedViewport) return;
      selection.stream.push(
        params.data,
        (raster) => {
          if (!this.isCurrent(selection)) return;
          paintedViewport.painted(raster);
          if (selection.painted) return;
          selection.painted = true;
          this.streaming(selection);
        },
        paintedViewport.accept,
      );
    } else if (event.method === "Target.detachedFromTarget") {
      const id = params.sessionId;
      if (typeof id !== "string") return;
      const control = client === this.client;
      (control ? this.ownedSessions : this.ownedFrameSessions).delete(id);
      if (
        this.selection &&
        (control ? this.selection.sessionId : this.selection.frameSessionId) ===
          id
      ) {
        this.loseSelection(
          diagnostic(
            new CdpFault("target-unavailable", "The selected target detached."),
          ),
        );
      }
    } else if (
      client === this.client &&
      [
        "Target.targetCreated",
        "Target.targetInfoChanged",
        "Target.targetDestroyed",
      ].includes(event.method)
    ) {
      this.targetRevision++;
      if (
        event.method === "Target.targetDestroyed" &&
        params.targetId === this.model.getSnapshot().selectedTargetId
      ) {
        this.loseSelection(
          diagnostic(
            new CdpFault("target-unavailable", "The selected target closed."),
          ),
        );
      }
      if (
        event.method === "Target.targetDestroyed" &&
        typeof params.targetId === "string"
      )
        this.retirements.delete(params.targetId);
      if (
        event.method === "Target.targetDestroyed" &&
        typeof params.targetId === "string"
      )
        this.imageRecovery.forget(params.targetId);
      this.discovery?.event(event);
    }
  }
}
