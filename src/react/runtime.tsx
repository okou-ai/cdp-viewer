import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode, RefObject } from "react";
import { diagnostic } from "../cdp/errors";
import { NativeInput } from "../input/native";
import { CanvasRenderer } from "../render/canvas";
import { ViewerController } from "../viewer/controller";
import type { ViewerActions } from "../viewer/model";
import type { CdpViewerProps } from "../viewer/types";
import { viewerScope } from "./context";
import { ToolbarFocus } from "./focus";
import { observeTabStrip } from "./tab-strip";
import { observeDisplay } from "./display";

interface Elements {
  canvas: RefObject<HTMLCanvasElement | null>;
  proxy: RefObject<HTMLTextAreaElement | null>;
  address: RefObject<HTMLInputElement | null>;
  tabs: RefObject<HTMLDivElement | null>;
  notice: RefObject<HTMLDivElement | null>;
  clipboard: RefObject<HTMLTextAreaElement | null>;
  browserMenu: RefObject<HTMLDivElement | null>;
}
const ElementsContext = createContext<Elements | null>(null);

function effectivePaused(explicit: boolean, inViewport: boolean): boolean {
  return explicit || document.hidden || !inViewport;
}

export function useViewerElements(): Elements {
  const elements = useContext(ElementsContext);
  if (!elements)
    throw new Error("Viewer elements require their runtime owner.");
  return elements;
}

/** DOM/resource synchronization only; semantic user actions belong to commands. */
export function ViewerRuntime({
  cdpUrl,
  windowId,
  paused = false,
  interactive = false,
  windowSizeSync,
  defaultWindowSizeSync = "off",
  onWindowSizeSyncChange,
  extensions,
  onStatusChange,
  onError,
  children,
}: CdpViewerProps & { children: ReactNode }) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const tabLayout = viewerScope.useValue(model.tabLayout$);
  const revision = viewerScope.useValue(model.revision$);
  const notification = viewerScope.useValue(model.notification$);
  const notificationId = notification?.id;
  const notificationExiting = notification?.exiting ?? false;
  const displayMode = viewerScope.useValue(model.windowSizeSync$);
  const canvas = useRef<HTMLCanvasElement>(null);
  const proxy = useRef<HTMLTextAreaElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  const clipboard = useRef<HTMLTextAreaElement>(null);
  const browserMenu = useRef<HTMLDivElement>(null);
  const elements = useMemo(
    () => ({ canvas, proxy, address, tabs, notice, clipboard, browserMenu }),
    [canvas, proxy, address, tabs, notice, clipboard, browserMenu],
  );
  const focus = useMemo(() => new ToolbarFocus(tabs, address), [tabs, address]);
  const native = useRef<NativeInput | null>(null);
  const runtime = useRef<ViewerController | null>(null);
  const inViewport = useRef(true);
  const committed = useRef({
    paused,
    onStatusChange,
    onError,
    onWindowSizeSyncChange,
    displayMode,
  });
  useLayoutEffect(() => {
    committed.current = {
      paused,
      onStatusChange,
      onError,
      onWindowSizeSyncChange,
      displayMode,
    };
  }, [paused, onStatusChange, onError, onWindowSizeSyncChange, displayMode]);
  useLayoutEffect(() => {
    model.run(model.configureDisplay$, {
      controlled: windowSizeSync ?? null,
      initial: defaultWindowSizeSync,
      canChange: windowSizeSync === undefined || !!onWindowSizeSyncChange,
    });
  }, [model, windowSizeSync, defaultWindowSizeSync, onWindowSizeSyncChange]);
  useLayoutEffect(() => {
    if (!canvas.current) return;
    // The conditional address editor's lifetime ends in view-only mode.
    if (!interactive) model.run(model.resetAddress$);
    model.transition({ type: "reset" });
    let controller: ViewerController;
    try {
      controller = new ViewerController(
        model,
        new CanvasRenderer(canvas.current),
        {
          url: cdpUrl,
          ...(windowId === undefined ? {} : { windowId }),
          paused: effectivePaused(committed.current.paused, inViewport.current),
          interactive,
          onInputReset: (reason) => native.current?.reset(reason),
          onClipboardReset: () => native.current?.clearClipboard(),
          onCaret: (point) => native.current?.place(point),
          onTabCreated: () => focus.created(),
          onTabClosed: (targetId) => focus.closed(targetId),
        },
      );
    } catch (error) {
      model.transition({ type: "failed", error: diagnostic(error) });
      return;
    }
    runtime.current = controller;
    const actions: ViewerActions = {
      select: (id) => controller.select(id),
      createTab: () => {
        focus.beginCreate();
        controller.createTab();
      },
      closeTab: (id) => {
        focus.beginClose(id);
        controller.closeTab(id);
      },
      navigate: (action) => controller.input?.navigate(action),
      copyClipboard: () => native.current?.copyClipboard(),
      dismissClipboard: () => native.current?.clearClipboard(),
      selectClipboard: () => clipboard.current?.select(),
      syncDisplay: () => controller.syncDisplay(),
      onWindowSizeSyncChange: (mode) =>
        committed.current.onWindowSizeSyncChange?.(mode),
    };
    model.run(model.bind$, actions);
    let active = true;
    const visibility = () =>
      controller.setPaused(
        effectivePaused(committed.current.paused, inViewport.current),
      );
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            if (!active) return;
            const entry = entries.at(-1);
            if (!entry) return;
            inViewport.current = entry.isIntersecting;
            visibility();
          })
        : null;
    observer?.observe(canvas.current);
    const stopDisplayObservation = observeDisplay(canvas.current, (size) =>
      controller.measureDisplay(size),
    );
    document.addEventListener("visibilitychange", visibility);
    controller.setWindowSizeSync(committed.current.displayMode);
    controller.start();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      observer?.disconnect();
      stopDisplayObservation();
      model.run(model.unbind$, actions);
      controller.close();
      focus.reset();
      if (runtime.current === controller) runtime.current = null;
    };
  }, [cdpUrl, windowId, revision, model, interactive, focus]);
  useLayoutEffect(() => {
    runtime.current?.setWindowSizeSync(displayMode);
  }, [displayMode]);
  // Configuration reconciliation does not own or recreate the transport.
  useLayoutEffect(() => {
    runtime.current?.setExtensions(extensions ?? []);
  });
  useLayoutEffect(() => focus.listen(), [focus]);
  useLayoutEffect(() => {
    if (!tabs.current) return;
    return observeTabStrip(tabs.current, (space) => {
      model.run(model.resizeTabs$, space);
    });
  }, [focus, model, interactive]);
  useLayoutEffect(() => {
    focus.restoreLayout();
  }, [focus, tabLayout]);
  useLayoutEffect(() => {
    focus.restoreAfterClose();
  }, [focus, snapshot.selectedTargetId, snapshot.targets]);
  useLayoutEffect(() => {
    if (notificationId === undefined || notificationExiting) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (active) model.run(model.exitNotification$, notificationId);
    }, 5000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [model, notificationId, notificationExiting]);
  useLayoutEffect(() => {
    if (
      !notification ||
      !notice.current ||
      (!notification.exiting && !notification.previous)
    )
      return;
    let active = true;
    const animations = (notice.current.getAnimations?.() ?? []).filter(
      (animation) => {
        const timing = animation.effect?.getTiming();
        return timing?.duration !== Infinity && timing?.iterations !== Infinity;
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
    Promise.allSettled(animations.map((animation) => animation.finished)).then(
      complete,
      complete,
    );
    return () => {
      active = false;
    };
  }, [model, notification]);
  useLayoutEffect(() => {
    if (!interactive || !canvas.current || !proxy.current) return;
    const input = new NativeInput(
      canvas.current,
      proxy.current,
      () => runtime.current?.input ?? null,
      () => focus.release(),
      (value) => model.run(model.setClipboard$, value),
    );
    native.current = input;
    return () => {
      input.dispose();
      if (native.current === input) native.current = null;
    };
  }, [interactive, focus, model]);
  useEffect(() => {
    runtime.current?.setPaused(effectivePaused(paused, inViewport.current));
  }, [paused]);
  useEffect(() => {
    committed.current.onStatusChange?.(snapshot);
  }, [snapshot]);
  const errorKind = snapshot.error?.kind;
  const errorMessage = snapshot.error?.message;
  useEffect(() => {
    if (errorKind && errorMessage)
      committed.current.onError?.({ kind: errorKind, message: errorMessage });
  }, [errorKind, errorMessage]);
  return <ElementsContext value={elements}>{children}</ElementsContext>;
}
