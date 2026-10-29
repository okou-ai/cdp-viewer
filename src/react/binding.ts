import type { RefObject } from "react";
import type { Computed } from "ccstate";
import { assertBrowserCapabilities } from "../browser";
import { diagnostic } from "../cdp/errors";
import { NativeInput } from "../input/native";
import { CanvasRenderer } from "../render/canvas";
import { ViewerController } from "../viewer/controller";
import type { ViewerActions, ViewerModel } from "../viewer/model";
import type {
  CdpViewerProps,
  ViewerCaptureOptions,
  ViewerSnapshot,
  ViewerTransport,
  WindowSizeSync,
} from "../viewer/types";
import { ToolbarFocus } from "./focus";
import { observeTabStrip } from "./tab-strip";
import { observeDisplay } from "./display";

export interface Elements {
  canvas: RefObject<HTMLCanvasElement | null>;
  proxy: RefObject<HTMLTextAreaElement | null>;
  address: RefObject<HTMLInputElement | null>;
  tabs: RefObject<HTMLDivElement | null>;
  notice: RefObject<HTMLDivElement | null>;
  clipboard: RefObject<HTMLTextAreaElement | null>;
  browserMenu: RefObject<HTMLDivElement | null>;
}

type Value<T> = T extends Computed<infer V> ? V : never;
export type RuntimeState = CdpViewerProps & {
  model: ViewerModel;
  snapshot: ViewerSnapshot;
  tabLayout: Value<ViewerModel["tabLayout$"]>;
  notification: Value<ViewerModel["notification$"]>;
  revision: number;
  displayMode: WindowSizeSync;
  transportMode: ViewerTransport;
  captureOptions: ViewerCaptureOptions;
};

function effectivePaused(explicit: boolean, inViewport: boolean): boolean {
  return explicit || document.hidden || !inViewport;
}

/** DOM resources belong to this committed instance, never to a render or global. */
export class ViewerBinding {
  readonly elements: Elements = {
    canvas: { current: null },
    proxy: { current: null },
    address: { current: null },
    tabs: { current: null },
    notice: { current: null },
    clipboard: { current: null },
    browserMenu: { current: null },
  };
  private readonly focus = new ToolbarFocus(
    this.elements.tabs,
    this.elements.address,
  );
  private native: NativeInput | null = null;
  private controller: ViewerController | null = null;
  private committed: RuntimeState | null = null;
  private inViewport = true;
  private stopConnection: (() => void) | undefined;
  private stopFocus: (() => void) | undefined;
  private tabStrip: ReturnType<typeof observeTabStrip> | undefined;
  private stopTimer: (() => void) | undefined;
  private stopAnimation: (() => void) | undefined;

  mount(state: RuntimeState): void {
    assertBrowserCapabilities();
    this.stopFocus = this.focus.listen();
    this.update(state);
  }

  update(state: RuntimeState): void {
    const old = this.committed;
    this.committed = state;
    const { model, snapshot, tabLayout, notification } = state;
    if (
      !old ||
      old.transport !== state.transport ||
      old.onTransportChange !== state.onTransportChange
    )
      model.run(model.configureTransport$, {
        controlled: state.transport ?? null,
        canChange: state.transport === undefined || !!state.onTransportChange,
      });
    if (
      !old ||
      old.windowSizeSync !== state.windowSizeSync ||
      old.onWindowSizeSyncChange !== state.onWindowSizeSyncChange
    )
      model.run(model.configureDisplay$, {
        controlled: state.windowSizeSync ?? null,
        canChange:
          state.windowSizeSync === undefined || !!state.onWindowSizeSyncChange,
      });
    if (
      !old ||
      old.capture !== state.capture ||
      old.onCaptureChange !== state.onCaptureChange
    )
      model.run(model.configureCapture$, {
        controlled: state.capture === undefined ? null : state.capture,
        canChange: state.capture === undefined || !!state.onCaptureChange,
      });
    const interactive = state.interactive ?? false;
    if (
      !old ||
      old.cdpUrl !== state.cdpUrl ||
      old.windowId !== state.windowId ||
      old.revision !== state.revision ||
      old.model !== model ||
      (old.interactive ?? false) !== interactive ||
      old.transportMode !== state.transportMode
    ) {
      this.stopConnection?.();
      this.stopConnection = undefined;
      this.connect(state);
    }
    if (!old || old.displayMode !== state.displayMode)
      this.controller?.setWindowSizeSync(state.displayMode);
    this.controller?.setCapture(state.captureOptions);
    this.controller?.setExtensions(state.extensions ?? []);
    if (
      !old ||
      old.model !== model ||
      (old.interactive ?? false) !== interactive
    ) {
      this.tabStrip?.close();
      const tabs = this.elements.tabs.current;
      this.tabStrip = tabs
        ? observeTabStrip(tabs, (space) => model.run(model.resizeTabs$, space))
        : undefined;
      this.native?.dispose();
      this.native = null;
      const { canvas, proxy } = this.elements;
      if (interactive && canvas.current && proxy.current)
        this.native = new NativeInput(
          canvas.current,
          proxy.current,
          () => this.controller?.input ?? null,
          () => this.focus.release(),
          (value) => model.run(model.setClipboard$, value),
        );
    }
    if (
      old &&
      (old.tabStyle !== state.tabStyle || old.toolbarEnd !== state.toolbarEnd)
    )
      this.tabStrip?.refresh();
    if (!old || old.tabLayout !== tabLayout) this.focus.restoreLayout();
    if (
      !old ||
      old.snapshot.selectedTargetId !== snapshot.selectedTargetId ||
      old.snapshot.targets !== snapshot.targets
    )
      this.focus.restoreAfterClose();
    if (
      !old ||
      old.notification?.id !== notification?.id ||
      old.notification?.exiting !== notification?.exiting
    ) {
      this.stopTimer?.();
      this.stopTimer = undefined;
      if (notification && !notification.exiting) {
        const timer = window.setTimeout(
          () => model.run(model.exitNotification$, notification.id),
          5000,
        );
        this.stopTimer = () => window.clearTimeout(timer);
      }
    }
    if (!old || old.notification !== notification) {
      this.stopAnimation?.();
      this.stopAnimation = undefined;
      const notice = this.elements.notice.current;
      if (
        notification &&
        notice &&
        (notification.exiting || notification.previous)
      ) {
        let active = true;
        const animations = (notice.getAnimations?.() ?? []).filter(
          (animation) => {
            const timing = animation.effect?.getTiming();
            return (
              timing?.duration !== Infinity && timing?.iterations !== Infinity
            );
          },
        );
        const complete = () => {
          if (active)
            model.run(
              notification.exiting
                ? model.removeNotification$
                : model.finishReplacement$,
              notification.id,
            );
        };
        Promise.allSettled(
          animations.map((animation) => animation.finished),
        ).then(complete, complete);
        this.stopAnimation = () => {
          active = false;
        };
      }
    }
    if (!old || old.paused !== state.paused)
      this.controller?.setPaused(
        effectivePaused(state.paused ?? false, this.inViewport),
      );
    if (!old || old.snapshot !== snapshot) state.onStatusChange?.(snapshot);
    const error = snapshot.error;
    const previous = old?.snapshot.error;
    if (
      error &&
      (!old ||
        error.kind !== previous?.kind ||
        error.message !== previous.message ||
        error.request?.method !== previous.request?.method ||
        error.request?.code !== previous.request?.code)
    )
      state.onError?.(error);
  }

  private connect(state: RuntimeState): void {
    const { canvas, clipboard } = this.elements;
    if (!canvas.current) return;
    const { model } = state;
    const interactive = state.interactive ?? false;
    if (!interactive) model.run(model.resetAddress$);
    model.transition({ type: "reset" });
    let controller: ViewerController;
    try {
      controller = new ViewerController(
        model,
        new CanvasRenderer(canvas.current),
        {
          url: state.cdpUrl,
          ...(state.windowId === undefined ? {} : { windowId: state.windowId }),
          paused: effectivePaused(state.paused ?? false, this.inViewport),
          interactive,
          transport: state.transportMode,
          capture: state.captureOptions,
          onInputReset: (reason) => this.native?.reset(reason),
          onClipboardReset: () => this.native?.clearClipboard(),
          onCaret: (point) => this.native?.place(point),
          onTabCreated: () => this.focus.created(),
          onTabClosed: (targetId) => this.focus.closed(targetId),
        },
      );
    } catch (error) {
      model.transition({ type: "failed", error: diagnostic(error) });
      return;
    }
    this.controller = controller;
    const actions: ViewerActions = {
      select: (id) => controller.select(id),
      createTab: () => {
        this.focus.beginCreate();
        controller.createTab();
      },
      closeTab: (id) => {
        this.focus.beginClose(id);
        controller.closeTab(id);
      },
      navigate: (action) => controller.input?.navigate(action),
      copyClipboard: () => this.native?.copyClipboard(),
      dismissClipboard: () => this.native?.clearClipboard(),
      selectClipboard: () => clipboard.current?.select(),
      syncDisplay: () => controller.syncDisplay(),
      retryImage: () => controller.retryImage(),
      onWindowSizeSyncChange: (mode) =>
        this.committed?.onWindowSizeSyncChange?.(mode),
      onCaptureChange: (capture) => this.committed?.onCaptureChange?.(capture),
      onTransportChange: (transport) =>
        this.committed?.onTransportChange?.(transport),
    };
    model.run(model.bind$, actions);
    let active = true;
    const visibility = () =>
      controller.setPaused(
        effectivePaused(this.committed?.paused ?? false, this.inViewport),
      );
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      const entry = entries.at(-1);
      if (!entry) return;
      this.inViewport = entry.isIntersecting;
      visibility();
    });
    observer.observe(canvas.current);
    const stopDisplay = observeDisplay(canvas.current, (size) =>
      controller.measureDisplay(size),
    );
    document.addEventListener("visibilitychange", visibility);
    controller.setWindowSizeSync(state.displayMode);
    controller.start();
    this.stopConnection = () => {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      observer.disconnect();
      stopDisplay();
      model.run(model.unbind$, actions);
      controller.close();
      this.focus.reset();
      if (this.controller === controller) this.controller = null;
    };
  }

  close(): void {
    this.stopConnection?.();
    this.stopFocus?.();
    this.tabStrip?.close();
    this.stopTimer?.();
    this.stopAnimation?.();
    this.native?.dispose();
    this.stopConnection = undefined;
    this.stopFocus = undefined;
    this.tabStrip = undefined;
    this.stopTimer = undefined;
    this.stopAnimation = undefined;
    this.native = null;
    this.committed = null;
  }
}
