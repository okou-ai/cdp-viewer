import { Button } from "@base-ui/react/button";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Monitor,
  RotateCw,
} from "lucide-react";
import type { CdpViewerProps, ViewerNavigation } from "../viewer/types";
import { viewerScope } from "./context";
import { ViewerRuntime, useViewerElements } from "./runtime";

export function CdpViewer(props: CdpViewerProps) {
  return (
    <viewerScope.Provider>
      <ViewerRuntime {...props}>
        <ViewerSurface {...props} />
      </ViewerRuntime>
    </viewerScope.Provider>
  );
}

function ViewerSurface({
  interactive = false,
  className,
  style,
}: CdpViewerProps) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const select = viewerScope.useCommand(model.select$);
  const reconnect = viewerScope.useCommand(model.reconnect$);
  const { canvas, proxy } = useViewerElements();
  const selectId = viewerScope.useIdentity();

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
          onChange={(event) => select(event.target.value)}
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
          onClick={() => reconnect()}
        >
          <RotateCw size={16} aria-hidden="true" />
        </Button>
      </div>
      {interactive && (
        <NavigationToolbar
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
  navigation,
  disabled,
}: {
  navigation: ViewerNavigation | null;
  disabled: boolean;
}) {
  const model = viewerScope.useModel();
  const addressId = viewerScope.useIdentity() + "-address";
  const address = viewerScope.useValue(model.address$);
  const edit = viewerScope.useCommand(model.editAddress$);
  const focus = viewerScope.useCommand(model.focusAddress$);
  const blur = viewerScope.useCommand(model.blurAddress$);
  const submit = viewerScope.useCommand(model.submitAddress$);
  const navigate = viewerScope.useCommand(model.navigate$);
  return (
    <form
      className="cdpv-navigation"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Button
        className="cdpv-button"
        type="button"
        aria-label="Back remote page"
        disabled={disabled || !navigation?.canGoBack}
        onClick={() => navigate("back")}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Button>
      <Button
        className="cdpv-button"
        type="button"
        aria-label="Forward remote page"
        disabled={disabled || !navigation?.canGoForward}
        onClick={() => navigate("forward")}
      >
        <ArrowRight size={16} aria-hidden="true" />
      </Button>
      <Button
        className="cdpv-button"
        type="button"
        aria-label="Reload remote page"
        disabled={disabled}
        onClick={() => navigate("reload")}
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
        onChange={(event) => edit(event.target.value)}
        onFocus={() => focus()}
        onBlur={() => blur()}
      />
      <Button className="cdpv-button" type="submit" disabled={disabled}>
        Go
      </Button>
    </form>
  );
}
