import { interval, timeout } from "signal-timers";
import { CdpClient } from "../cdp/client";
import type { CdpEvent, SocketFactory } from "../cdp/client";
import {
  CdpFault,
  diagnostic,
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
import type { TabAction, ViewerModel } from "./model";
import type { ViewerError, WindowSizeSync } from "./types";

interface Selection {
  targetId: string;
  sessionId: string | null;
  deadline: AbortController;
  painted: boolean;
  streamStopped: boolean;
  input: InputSession | null;
  inputReady: boolean;
  highDensity: boolean;
  geometry: DisplayViewport;
}

interface Retirement {
  input: InputSession;
  complete: Promise<void>;
}

interface ControllerOptions {
  url: string;
  windowId?: number;
  paused?: boolean;
  socketFactory?: SocketFactory;
  requestTimeout?: number;
  interactive?: boolean;
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
  private readonly retirements = new Map<string, Retirement>();
  private client: CdpClient | null = null;
  private directory: TargetDirectory | null = null;
  private selection: Selection | null = null;
  private disposed = false;
  private connected = false;
  private chosenOnce = false;
  private refreshing = false;
  private refreshWanted = false;
  private targetRevision = 0;
  private selectionRevision = 0;
  private extensionRequest = 0;
  private extensionDescriptors: readonly ViewerExtension[] = [];
  private extensions: ExtensionRuntime | null = null;
  private paused: boolean;
  private display: DisplaySync | null = null;
  private displayMode: WindowSizeSync = "off";
  private displaySize: DisplaySize | null = null;

  constructor(
    private readonly model: ViewerModel,
    private readonly sink: FrameSink,
    private readonly options: ControllerOptions,
  ) {
    this.paused = options.paused ?? false;
  }

  start(): void {
    this.model.run(this.model.configure$, {
      interactive: this.options.interactive ?? false,
      scoped: this.options.windowId !== undefined,
    });
    this.connect().catch((error: unknown) => {
      if (!this.disposed && !this.lifetime.signal.aborted) this.fail(error);
    });
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
    this.selectionRevision++;
    this.stopSelection();
    this.model.transition({
      type: "select",
      targetId,
      paused: this.paused,
    });
    if (this.paused) return;
    const selection: Selection = {
      targetId,
      sessionId: null,
      deadline: new AbortController(),
      painted: false,
      streamStopped: false,
      input: null,
      inputReady: !this.options.interactive,
      highDensity: false,
      geometry: new DisplayViewport(),
    };
    this.selection = selection;
    this.attach(selection).catch((error: unknown) => {
      if (this.isCurrent(selection)) this.fail(error);
    });
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (!this.connected) return;
    if (paused) {
      this.stopSelection("paused");
      this.model.transition({ type: "paused" });
    } else {
      const id = this.model.getSnapshot().selectedTargetId;
      if (id) this.select(id);
      else this.refresh();
    }
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
    this.displaySize = size;
    this.display?.measure(size);
  }

  syncDisplay(): void {
    this.display?.sync();
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
        const targets = await directory.list();
        if (!current()) return;
        if (!targets.some((target) => target.id === targetId))
          throw new CdpFault(
            "tab",
            "The new tab is no longer available in this scope.",
          );
        this.targetRevision++;
        const created = targets.find((target) => target.id === targetId)!;
        const latest = this.model.getSnapshot().targets;
        this.model.update({
          targets: latest.some((target) => target.id === targetId)
            ? latest
            : Object.freeze([...latest, created]),
          error: null,
        });
        this.model.run(this.model.resetAddress$);
        this.select(targetId);
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
      this.options.onTabClosed?.(targetId);
      const targets = Object.freeze(
        this.model
          .getSnapshot()
          .targets.filter((target) => target.id !== targetId),
      );
      this.model.update({ targets, error: null });
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
      this.refresh();
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
    this.model.run(this.model.setConnected$, false);
    this.lifetime.abort();
    this.stopSelection("disposed");
    this.display?.close();
    this.sink.dispose();
    this.client?.close();
    this.ownedSessions.clear();
    this.retirements.clear();
  }

  private async connect(): Promise<void> {
    validateConfiguration(this.options.url, this.options.windowId);
    const client = new CdpClient(
      this.options.url,
      this.options.socketFactory,
      this.options.requestTimeout,
    );
    this.client = client;
    this.directory = new TargetDirectory(client, this.options.windowId);
    client.onEvent(this.onEvent);
    client.onDisconnected((error) => {
      if (this.disposed) return;
      const established = this.connected;
      this.connected = false;
      this.lifetime.abort();
      this.stopSelection("disconnected");
      this.model.transition({
        type: "disconnected",
        established,
        error: diagnostic(error),
      });
    });
    await client.opened;
    if (this.disposed) return;
    await client.request("Target.setDiscoverTargets", { discover: true });
    if (this.disposed) return;
    this.connected = true;
    this.model.run(this.model.setConnected$, true);
    let displayError: ViewerError | null = null;
    this.display = new DisplaySync(client, {
      signal: this.lifetime.signal,
      presentationTimeout: this.options.requestTimeout,
      windowId: this.options.windowId,
      changed: (state) => {
        if (!this.disposed) this.model.run(this.model.setDisplay$, state);
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
      capture: async () => {
        const selection = this.selection;
        if (selection && this.isCurrent(selection))
          await this.upgradeCapture(selection);
      },
      refresh: async (prepare) => {
        const selection = this.selection;
        if (selection && this.isCurrent(selection))
          await this.refreshCapture(selection, prepare);
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
    if (this.options.windowId !== undefined) {
      interval(() => this.refresh(), 2_000, { signal: this.lifetime.signal });
    }
    this.refresh();
  }

  private refresh(): void {
    if (this.disposed || !this.connected) return;
    this.refreshWanted = true;
    if (!this.refreshing)
      this.refreshLoop().catch((error: unknown) => {
        if (!this.disposed && !this.lifetime.signal.aborted) this.fail(error);
      });
  }

  private async refreshLoop(): Promise<void> {
    this.refreshing = true;
    while (this.refreshWanted && !this.disposed && this.connected) {
      this.refreshWanted = false;
      const revision = this.targetRevision;
      try {
        const discovered = await this.directory!.list();
        if (this.disposed || !this.connected) break;
        if (revision !== this.targetRevision) {
          this.refreshWanted = true;
          continue;
        }
        const order = new Map(
          this.model
            .getSnapshot()
            .targets.map((target, index) => [target.id, index]),
        );
        const targets = Object.freeze(
          [...discovered].sort(
            (a, b) =>
              (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size),
          ),
        );
        const selected = this.model.getSnapshot().selectedTargetId;
        this.model.update({ targets });
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
      } catch (error) {
        if (!this.disposed && this.connected) {
          if (revision !== this.targetRevision) {
            this.refreshWanted = true;
            continue;
          }
          this.stopSelection();
          this.model.transition({
            type: "discovery-failed",
            error: diagnostic(error),
          });
        }
      }
    }
    this.refreshing = false;
  }

  private async attach(selection: Selection): Promise<void> {
    const client = this.client!;
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
    const attached: unknown = await client.request(
      "Target.attachToTarget",
      { targetId: selection.targetId, flatten: true },
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
    selection.sessionId = attached.sessionId;
    this.ownedSessions.add(attached.sessionId);
    if (!this.isCurrent(selection)) {
      this.release(selection);
      return;
    }
    await this.directory!.assertMember(selection.targetId);
    if (!this.isCurrent(selection)) return;
    await client.request("Page.enable", undefined, attached.sessionId);
    if (!this.isCurrent(selection)) return;
    let inputReady: Promise<void> = Promise.resolve();
    if (this.options.interactive) {
      const input = new InputSession(
        client,
        attached.sessionId,
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
    selection.highDensity = this.displayMode !== "off";
    await Promise.all([
      inputReady,
      this.startScreencast(attached.sessionId, selection.highDensity),
    ]);
    if (!this.isCurrent(selection)) return;
    this.display?.setTarget({
      targetId: selection.targetId,
      sessionId: attached.sessionId,
      current: () => this.isCurrent(selection),
      geometry: selection.geometry,
    });
    if (selection.painted) return;
    timeout(
      () => {
        if (this.isCurrent(selection) && !selection.painted)
          this.fail(
            new CdpFault("frame", "The browser did not produce a live frame."),
          );
      },
      10_000,
      {
        signal: AbortSignal.any([
          this.lifetime.signal,
          selection.deadline.signal,
        ]),
      },
    );
  }

  private isCurrent(selection: Selection): boolean {
    return (
      !this.disposed &&
      this.connected &&
      !this.paused &&
      this.selection === selection
    );
  }

  private async upgradeCapture(selection: Selection): Promise<void> {
    if (selection.highDensity || !selection.sessionId) return;
    const client = this.client!;
    const session = selection.sessionId;
    await client.request("Page.stopScreencast", undefined, session);
    if (!this.isCurrent(selection)) return;
    try {
      await this.startScreencast(session, true);
      if (this.isCurrent(selection)) selection.highDensity = true;
    } catch (error) {
      if (this.isCurrent(selection)) {
        try {
          await this.startScreencast(session, false);
        } catch (restoreError) {
          if (this.isCurrent(selection)) this.fail(restoreError);
        }
      }
      throw error;
    }
  }

  private startScreencast(sessionId: string, highDensity: boolean) {
    return this.client!.request(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: 70,
        maxWidth: highDensity ? 4096 : 1920,
        maxHeight: highDensity ? 4096 : 1080,
      },
      sessionId,
    );
  }

  private async refreshCapture(
    selection: Selection,
    prepare: () => Promise<void>,
  ): Promise<void> {
    if (!selection.sessionId) return;
    const session = selection.sessionId;
    await this.client!.request("Page.stopScreencast", undefined, session);
    if (!this.isCurrent(selection)) return;
    try {
      await prepare();
      if (!this.isCurrent(selection)) return;
      await this.startScreencast(session, true);
    } catch (error) {
      if (this.isCurrent(selection)) {
        try {
          await this.startScreencast(session, true);
        } catch (restoreError) {
          if (this.isCurrent(selection)) this.fail(restoreError);
        }
      }
      throw error;
    }
  }

  private streaming(selection: Selection): void {
    if (this.isCurrent(selection) && selection.painted && selection.inputReady)
      this.model.transition({ type: "streaming" });
  }

  private loseSelection(error: ViewerError | null): void {
    this.stopSelection();
    this.model.transition({ type: "target-lost", error });
  }

  private stopSelection(reason: InputStop = "target-replaced"): void {
    const old = this.selection;
    this.selection = null;
    this.display?.setTarget(null);
    this.sink.reset();
    this.model.transition({ type: "stopped" });
    if (old) {
      old.deadline.abort();
      this.stopStream(old);
      const input = old.input;
      if (input && reason !== "disconnected" && !this.disposed) {
        // Cancel old admission synchronously, then publish the fence before local reset.
        const complete = input.retire(reason);
        const retirement = { input, complete };
        this.retirements.set(old.targetId, retirement);
        complete.then(
          () => {
            if (this.retirements.get(old.targetId) === retirement)
              this.retirements.delete(old.targetId);
            this.release(old);
          },
          () => {
            // Unknown cleanup cannot grant this connection a new owner of the target.
            this.release(old);
          },
        );
      } else {
        input?.dispose(reason);
        this.release(old);
      }
      if (input) {
        this.options.onClipboardReset?.();
        this.options.onInputReset?.(reason);
      }
    }
  }

  private release(selection: Selection): void {
    const id = selection.sessionId;
    if (!id || !this.ownedSessions.has(id)) return;
    this.stopStream(selection);
    this.ownedSessions.delete(id);
    this.client?.notify("Target.detachFromTarget", { sessionId: id });
  }

  private stopStream(selection: Selection): void {
    const id = selection.sessionId;
    if (!id || selection.streamStopped || !this.ownedSessions.has(id)) return;
    selection.streamStopped = true;
    this.client?.notify("Page.stopScreencast", undefined, id);
  }

  private fail(error: unknown): void {
    this.stopSelection();
    this.model.transition({ type: "failed", error: diagnostic(error) });
  }

  private readonly onEvent = (event: CdpEvent): void => {
    if (this.disposed) return;
    if (event.sessionId === this.selection?.sessionId)
      this.selection?.geometry.event(event.method);
    this.selection?.input?.event(event);
    for (const retirement of this.retirements.values())
      retirement.input.event(event);
    const params = event.params;
    if (event.method === "Page.screencastFrame") {
      const id = event.sessionId;
      if (
        !id ||
        !this.ownedSessions.has(id) ||
        !Number.isSafeInteger(params.sessionId)
      )
        return;
      this.client?.notify(
        "Page.screencastFrameAck",
        { sessionId: params.sessionId as number },
        id,
      );
      const selection = this.selection;
      if (
        !selection ||
        selection.sessionId !== id ||
        !this.isCurrent(selection) ||
        typeof params.data !== "string"
      )
        return;
      const paintedViewport = selection.geometry.frame(params.metadata);
      if (!paintedViewport) return;
      this.sink.push(
        params.data,
        (raster) => {
          if (!this.isCurrent(selection)) return;
          paintedViewport.painted(raster);
          if (selection.painted) return;
          selection.painted = true;
          selection.deadline.abort();
          this.streaming(selection);
        },
        (error) => {
          if (this.isCurrent(selection)) this.fail(error);
        },
        paintedViewport.accept,
      );
    } else if (event.method === "Target.detachedFromTarget") {
      const id = params.sessionId;
      if (typeof id !== "string") return;
      this.ownedSessions.delete(id);
      if (this.selection?.sessionId === id) {
        this.loseSelection(
          diagnostic(
            new CdpFault("target-unavailable", "The selected target detached."),
          ),
        );
      }
    } else if (
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
      this.refresh();
    }
  };
}
