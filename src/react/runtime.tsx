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

interface Elements {
  canvas: RefObject<HTMLCanvasElement | null>;
  proxy: RefObject<HTMLTextAreaElement | null>;
}
const ElementsContext = createContext<Elements | null>(null);

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
  onStatusChange,
  onError,
  children,
}: CdpViewerProps & { children: ReactNode }) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const revision = viewerScope.useValue(model.revision$);
  const canvas = useRef<HTMLCanvasElement>(null);
  const proxy = useRef<HTMLTextAreaElement>(null);
  const elements = useMemo(() => ({ canvas, proxy }), [canvas, proxy]);
  const native = useRef<NativeInput | null>(null);
  const runtime = useRef<ViewerController | null>(null);
  const inViewport = useRef(true);
  const committed = useRef({ paused, onStatusChange, onError });
  useLayoutEffect(() => {
    committed.current = { paused, onStatusChange, onError };
  }, [paused, onStatusChange, onError]);
  useLayoutEffect(() => {
    if (!canvas.current) return;
    model.update({
      status: "connecting",
      targets: Object.freeze([]),
      selectedTargetId: null,
      error: null,
      navigation: null,
    });
    let controller: ViewerController;
    try {
      controller = new ViewerController(
        model,
        new CanvasRenderer(canvas.current),
        {
          url: cdpUrl,
          ...(windowId === undefined ? {} : { windowId }),
          paused:
            committed.current.paused || document.hidden || !inViewport.current,
          interactive,
          onInputReset: () => native.current?.reset(),
          onCaret: (point) => native.current?.place(point),
        },
      );
    } catch (error) {
      model.update({ status: "error", error: diagnostic(error) });
      return;
    }
    runtime.current = controller;
    const actions: ViewerActions = {
      select: (id) => controller.select(id),
      navigate: (action) => controller.input?.navigate(action),
    };
    model.run(model.bind$, actions);
    let active = true;
    const visibility = () =>
      controller.setPaused(
        committed.current.paused || document.hidden || !inViewport.current,
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
    document.addEventListener("visibilitychange", visibility);
    controller.start();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      observer?.disconnect();
      model.run(model.unbind$, actions);
      controller.close();
      if (runtime.current === controller) runtime.current = null;
    };
  }, [cdpUrl, windowId, revision, model, interactive]);
  useLayoutEffect(() => {
    if (!interactive || !canvas.current || !proxy.current) return;
    const input = new NativeInput(
      canvas.current,
      proxy.current,
      () => runtime.current?.input ?? null,
    );
    native.current = input;
    return () => {
      input.dispose();
      if (native.current === input) native.current = null;
    };
  }, [interactive]);
  useEffect(() => {
    runtime.current?.setPaused(
      paused || document.hidden || !inViewport.current,
    );
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
