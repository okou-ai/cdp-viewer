import { Button } from "@base-ui/react/button";
import { CircleAlert, Monitor, RotateCw } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { diagnostic } from "../cdp/errors";
import { CanvasRenderer } from "../render/canvas";
import { ViewerController } from "../viewer/controller";
import { createViewerModel } from "../viewer/model";
import type { ViewerModel } from "../viewer/model";
import type { CdpViewerProps } from "../viewer/types";

// Deliberately separate from ccstate-react's host application context.
const ViewerContext = createContext<ViewerModel | null>(null);

export function CdpViewer(props: CdpViewerProps) {
  const [model] = useState(createViewerModel);
  return (
    <ViewerContext value={model}>
      <ViewerSurface {...props} />
    </ViewerContext>
  );
}

function ViewerSurface({
  cdpUrl,
  windowId,
  paused = false,
  className,
  style,
  onStatusChange,
  onError,
}: CdpViewerProps) {
  const model = useContext(ViewerContext);
  if (!model) throw new Error("CdpViewer must own its model.");
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const runtime = useRef<ViewerController | null>(null);
  const committed = useRef({ paused, onStatusChange, onError });
  const [retry, setRetry] = useState(0);
  const selectId = useId();

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
    });
    let controller: ViewerController;
    try {
      controller = new ViewerController(
        model,
        new CanvasRenderer(canvas.current),
        {
          url: cdpUrl,
          ...(windowId === undefined ? {} : { windowId }),
          paused: committed.current.paused || document.hidden,
        },
      );
    } catch (error) {
      model.update({ status: "error", error: diagnostic(error) });
      return;
    }
    runtime.current = controller;
    const visibility = () =>
      controller.setPaused(committed.current.paused || document.hidden);
    document.addEventListener("visibilitychange", visibility);
    controller.start();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      controller.close();
      if (runtime.current === controller) runtime.current = null;
    };
  }, [cdpUrl, windowId, retry, model]);

  useEffect(() => {
    runtime.current?.setPaused(paused || document.hidden);
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

  const selected = snapshot.targets.find(
    (target) => target.id === snapshot.selectedTargetId,
  );
  return (
    <section
      aria-label="Remote browser viewer"
      className={`cdpv-root cdpv:flex cdpv:flex-col ${className ?? ""}`}
      style={style}
      data-status={snapshot.status}
    >
      <div className="cdpv-toolbar cdpv:flex cdpv:items-center cdpv:gap-2">
        <Monitor size={18} aria-hidden="true" />
        <label htmlFor={selectId}>Page</label>
        <select
          id={selectId}
          value={snapshot.selectedTargetId ?? ""}
          disabled={
            !snapshot.targets.length || snapshot.status === "disconnected"
          }
          onChange={(event) => runtime.current?.select(event.target.value)}
        >
          {!snapshot.selectedTargetId && (
            <option value="">Select a page</option>
          )}
          {snapshot.targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.title}
            </option>
          ))}
        </select>
        <Button
          type="button"
          className="cdpv-button"
          aria-label="Reconnect viewer"
          onClick={() => setRetry((value) => value + 1)}
        >
          <RotateCw size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="cdpv-stage">
        <canvas ref={canvas} role="img" aria-label="Live browser view">
          Your browser needs Canvas 2D to show the remote page.
        </canvas>
        {snapshot.status !== "streaming" && (
          <div className="cdpv-placeholder">
            <Monitor size={28} aria-hidden="true" />
            <span>
              {snapshot.status === "paused"
                ? "Viewing paused"
                : snapshot.status === "connecting"
                  ? "Connecting to browser…"
                  : "Browser view unavailable"}
            </span>
          </div>
        )}
      </div>
      <div
        className="cdpv-footer cdpv:flex cdpv:items-center cdpv:gap-2"
        role="status"
        aria-live="polite"
      >
        <span className="cdpv-dot" />
        <span>{snapshot.status}</span>
        <span className="cdpv-title">{selected?.title}</span>
        <span>View only</span>
      </div>
      {snapshot.error && (
        <div className="cdpv-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{snapshot.error.message}</span>
        </div>
      )}
    </section>
  );
}
