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
import { InputSession } from "../input/session";
import type { InputStop } from "../input/lifecycle";
import type { Point } from "../input/geometry";
import type { FrameSink } from "../render/canvas";
import type { TabAction, ViewerModel } from "./model";
import type { ViewerError } from "./types";
import { FaviconDirectory } from "./favicons";

interface Selection {
  targetId: string;
  sessionId: string | null;
  deadline: AbortController;
  painted: boolean;
  input: InputSession | null;
  inputReady: boolean;
}

interface ControllerOptions {
  url: string;
  windowId?: number;
  paused?: boolean;
  socketFactory?: SocketFactory;
  requestTimeout?: number;
  interactive?: boolean;
  onInputReset?: () => void;
  onCaret?: (point: Point) => void;
  onTabCreated?: () => void;
  onTabClosed?: (targetId: string) => void;
}

/** Lifetime is one mounted connection, never an endpoint-keyed global. */
export class ViewerController {
  private readonly lifetime = new AbortController();
  private readonly ownedSessions = new Set<string>();
  private client: CdpClient | null = null;
  private directory: TargetDirectory | null = null;
  private favicons: FaviconDirectory | null = null;
  private selection: Selection | null = null;
  private disposed = false;
  private connected = false;
  private chosenOnce = false;
  private refreshing = false;
  private refreshWanted = false;
  private targetRevision = 0;
  private selectionRevision = 0;
  private paused: boolean;

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
      input: null,
      inputReady: !this.options.interactive,
    };
    this.selection = selection;
    this.attach(selection).catch((error: unknown) => {
      if (this.isCurrent(selection)) this.fail(error);
    });
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    this.favicons?.setPaused(paused);
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
      this.favicons?.reconcile(targets.map((target) => target.id));
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
    this.sink.dispose();
    this.client?.close();
    this.ownedSessions.clear();
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
    this.favicons = new FaviconDirectory(
      client,
      this.directory,
      this.lifetime.signal,
      (targetId, src) =>
        this.model.run(this.model.setFavicon$, { targetId, src }),
    );
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
        this.favicons?.reconcile(targets.map((target) => target.id));
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
          this.favicons?.reconcile([]);
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
    await client.request("Page.enable", undefined, attached.sessionId);
    if (!this.isCurrent(selection)) return;
    let inputReady: Promise<void> = Promise.resolve();
    if (this.options.interactive) {
      const input = new InputSession(
        client,
        attached.sessionId,
        async () => {
          if (!this.isCurrent(selection)) return false;
          await this.directory!.assertMember(selection.targetId);
          return this.isCurrent(selection);
        },
        (navigation) => {
          if (this.isCurrent(selection)) this.model.update({ navigation });
        },
        () => this.options.onInputReset?.(),
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
      );
      selection.input = input;
      inputReady = input.start().then(() => {
        if (!this.isCurrent(selection)) return;
        selection.inputReady = true;
        this.streaming(selection);
      });
    }
    await Promise.all([
      inputReady,
      client.request(
        "Page.startScreencast",
        { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1080 },
        attached.sessionId,
      ),
    ]);
    if (!this.isCurrent(selection) || selection.painted) return;
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

  private streaming(selection: Selection): void {
    if (
      this.isCurrent(selection) &&
      selection.painted &&
      selection.inputReady
    ) {
      this.model.transition({ type: "streaming" });
      this.favicons?.setPaused(false);
    }
  }

  private loseSelection(error: ViewerError | null): void {
    this.stopSelection();
    this.model.transition({ type: "target-lost", error });
  }

  private stopSelection(reason: InputStop = "target-replaced"): void {
    const old = this.selection;
    this.selection = null;
    this.sink.reset();
    this.model.transition({ type: "stopped" });
    if (old) {
      old.input?.dispose(reason);
      old.deadline.abort();
      this.release(old);
    }
  }

  private release(selection: Selection): void {
    const id = selection.sessionId;
    if (!id || !this.ownedSessions.delete(id)) return;
    this.client?.notify("Page.stopScreencast", undefined, id);
    this.client?.notify("Target.detachFromTarget", { sessionId: id });
  }

  private fail(error: unknown): void {
    this.stopSelection();
    this.model.transition({ type: "failed", error: diagnostic(error) });
  }

  private readonly onEvent = (event: CdpEvent): void => {
    if (this.disposed) return;
    this.favicons?.event(event);
    this.selection?.input?.event(event);
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
      const paintedViewport = selection.input?.frame(params.metadata);
      this.sink.push(
        params.data,
        () => {
          if (!this.isCurrent(selection)) return;
          paintedViewport?.();
          if (selection.painted) return;
          selection.painted = true;
          selection.deadline.abort();
          this.streaming(selection);
        },
        (error) => {
          if (this.isCurrent(selection)) this.fail(error);
        },
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
      this.refresh();
    }
  };
}
