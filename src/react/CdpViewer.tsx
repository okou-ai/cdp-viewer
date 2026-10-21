import { Button } from "@base-ui/react/button";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Monitor,
  RotateCw,
} from "lucide-react";
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
import type { RefObject } from "react";
import { diagnostic } from "../cdp/errors";
import { NativeInput } from "../input/native";
import { CanvasRenderer } from "../render/canvas";
import { ViewerController } from "../viewer/controller";
import { createViewerModel } from "../viewer/model";
import type { ViewerModel } from "../viewer/model";
import type { CdpViewerProps, ViewerNavigation } from "../viewer/types";

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
  interactive = false,
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
  const proxy = useRef<HTMLTextAreaElement>(null);
  const native = useRef<NativeInput | null>(null);
  const runtime = useRef<ViewerController | null>(null);
  const inViewport = useRef(true);
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
      controller.close();
      if (runtime.current === controller) runtime.current = null;
    };
  }, [cdpUrl, windowId, retry, model, interactive]);

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
      {interactive && (
        <NavigationToolbar
          runtime={runtime}
          navigation={snapshot.navigation ?? null}
          disabled={snapshot.status !== "streaming"}
        />
      )}
      <div className={`cdpv-stage${interactive ? " cdpv-interactive" : ""}`}>
        <canvas ref={canvas} role="img" aria-label="Live browser view">
          Your browser needs Canvas 2D to show the remote page.
        </canvas>
        {interactive && (
          <textarea
            ref={proxy}
            id={`${selectId}-input`}
            className="cdpv-input-proxy"
            aria-label="Remote browser input"
            disabled={snapshot.status !== "streaming"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            rows={1}
            wrap="off"
          />
        )}
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
        <span>{interactive ? "Interactive" : "View only"}</span>
        {interactive && <span>F8: release keyboard</span>}
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

function NavigationToolbar({
  runtime,
  navigation,
  disabled,
}: {
  runtime: RefObject<ViewerController | null>;
  navigation: ViewerNavigation | null;
  disabled: boolean;
}) {
  const addressId = useId();
  const [address, setAddress] = useState("");
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setAddress(navigation?.url ?? "");
  }, [navigation?.url]);
  return (
    <form
      className="cdpv-navigation"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        editing.current = false;
        runtime.current?.input?.navigate({ url: address.trim() });
      }}
    >
      <Button
        className="cdpv-button"
        type="button"
        aria-label="Back remote page"
        disabled={disabled || !navigation?.canGoBack}
        onClick={() => runtime.current?.input?.navigate("back")}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Button>
      <Button
        className="cdpv-button"
        type="button"
        aria-label="Forward remote page"
        disabled={disabled || !navigation?.canGoForward}
        onClick={() => runtime.current?.input?.navigate("forward")}
      >
        <ArrowRight size={16} aria-hidden="true" />
      </Button>
      <Button
        className="cdpv-button"
        type="button"
        aria-label="Reload remote page"
        disabled={disabled}
        onClick={() => runtime.current?.input?.navigate("reload")}
      >
        <RotateCw size={16} aria-hidden="true" />
      </Button>
      <input
        id={addressId}
        type="text"
        className="cdpv-address"
        aria-label="Remote page address"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
        }}
      />
      <Button className="cdpv-button" type="submit" disabled={disabled}>
        Go
      </Button>
    </form>
  );
}
