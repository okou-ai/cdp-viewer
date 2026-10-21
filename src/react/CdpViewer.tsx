import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Monitor,
  Globe,
  Plus,
  X,
  LoaderCircle,
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
  colorScheme,
  className,
  style,
}: CdpViewerProps) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const favicons = viewerScope.useValue(model.favicons$);
  const rejectFavicon = viewerScope.useCommand(model.rejectFavicon$);
  const select = viewerScope.useCommand(model.select$);
  const reconnect = viewerScope.useCommand(model.reconnect$);
  const createTab = viewerScope.useCommand(model.createTab$);
  const closeTab = viewerScope.useCommand(model.closeTab$);
  const pending = viewerScope.useValue(model.tabAction$);
  const controls = viewerScope.useValue(model.controls$);
  const notification = viewerScope.useValue(model.notification$);
  const { canvas, proxy, tabs, notice } = useViewerElements();
  const selectId = viewerScope.useIdentity();

  return (
    <Tabs.Root
      render={<section />}
      aria-label="Remote browser viewer"
      className={`cdpv-root cdpv:flex cdpv:flex-col ${className ?? ""}`}
      style={style}
      data-status={snapshot.status}
      data-color-scheme={colorScheme}
      value={snapshot.selectedTargetId}
      onValueChange={(value) => {
        if (typeof value === "string") select(value);
      }}
    >
      <div className="cdpv-toolbar">
        <Tabs.List
          id={selectId}
          ref={tabs}
          className="cdpv-tabs"
          aria-label="Browser tabs"
          activateOnFocus={false}
        >
          {snapshot.targets.map((target) => (
            <div
              className="cdpv-tab-item"
              key={target.id}
              data-selected={
                target.id === snapshot.selectedTargetId ? "" : undefined
              }
            >
              <Tabs.Tab
                className="cdpv-tab"
                value={target.id}
                title={target.title}
                disabled={controls.tabsDisabled}
                data-target-id={target.id}
              >
                {favicons.get(target.id) ? (
                  <img
                    className="cdpv-favicon"
                    src={favicons.get(target.id)}
                    alt=""
                    aria-hidden="true"
                    width={16}
                    height={16}
                    onError={() =>
                      rejectFavicon({
                        targetId: target.id,
                        src: favicons.get(target.id)!,
                      })
                    }
                  />
                ) : (
                  <Globe size={16} aria-hidden="true" />
                )}
                <span>{target.title}</span>
              </Tabs.Tab>
              {interactive && (
                <Button
                  type="button"
                  className="cdpv-close"
                  aria-label={`Close ${target.title}`}
                  title={`Close ${target.title}`}
                  data-close-target={target.id}
                  aria-busy={
                    pending?.type === "close" && pending.targetId === target.id
                  }
                  disabled={!controls.canMutateTabs}
                  onClick={() => closeTab(target.id)}
                >
                  {pending?.type === "close" &&
                  pending.targetId === target.id ? (
                    <LoaderCircle
                      className="cdpv-spinning"
                      size={14}
                      aria-hidden="true"
                    />
                  ) : (
                    <X size={14} aria-hidden="true" />
                  )}
                </Button>
              )}
            </div>
          ))}
        </Tabs.List>
        {interactive && (
          <Button
            type="button"
            className="cdpv-button cdpv-new-tab"
            aria-label="New tab"
            aria-busy={pending?.type === "create"}
            title="New tab"
            disabled={!controls.canCreate}
            onClick={() => createTab()}
          >
            {pending?.type === "create" ? (
              <LoaderCircle
                className="cdpv-spinning"
                size={18}
                aria-hidden="true"
              />
            ) : (
              <Plus size={18} aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
      {interactive && (
        <NavigationToolbar
          navigation={snapshot.navigation ?? null}
          disabled={!controls.streaming}
        />
      )}
      <Tabs.Panel
        tabIndex={-1}
        keepMounted
        value={snapshot.selectedTargetId}
        className={`cdpv-stage${interactive ? " cdpv-interactive" : ""}`}
      >
        <canvas ref={canvas} role="img" aria-label="Live browser view">
          Your browser needs Canvas 2D to show the remote page.
        </canvas>
        {notification && (
          <div className="cdpv-notification-viewport">
            {notification.previous && (
              <div
                key={notification.previous.id}
                className="cdpv-error cdpv-error-previous"
                aria-hidden="true"
              >
                <CircleAlert size={16} aria-hidden="true" />
                <span>{notification.previous.error.message}</span>
              </div>
            )}
            <div
              key={notification.id}
              ref={notice}
              className="cdpv-error cdpv-error-current"
              role="alert"
              data-notification-id={notification.id}
              data-phase={notification.exiting ? "exiting" : "visible"}
              data-entrance={notification.entrance}
              data-replacing={notification.previous ? "" : undefined}
            >
              <CircleAlert size={16} aria-hidden="true" />
              <span>{notification.error.message}</span>
            </div>
          </div>
        )}
        {interactive && (
          <textarea
            ref={proxy}
            id={`${selectId}-input`}
            className="cdpv-input-proxy"
            aria-label="Remote browser input"
            disabled={!controls.streaming}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            rows={1}
            wrap="off"
          />
        )}
        {!controls.streaming && (
          <div className="cdpv-placeholder">
            {controls.recovery ? (
              <CircleAlert size={28} aria-hidden="true" />
            ) : (
              <Monitor size={28} aria-hidden="true" />
            )}
            <strong>{controls.placeholderTitle}</strong>
            {snapshot.error && (
              <span className="cdpv-placeholder-message" role="alert">
                {snapshot.error.message}
              </span>
            )}
            {controls.emptyScoped && (
              <span className="cdpv-placeholder-message">
                Open a page in this window, or reconnect after updating the
                window scope.
              </span>
            )}
            {controls.showRecovery && (
              <div className="cdpv-recovery-actions">
                {controls.showEmptyCreate && (
                  <Button
                    type="button"
                    className="cdpv-button cdpv-primary"
                    disabled={!controls.canCreate}
                    onClick={() => createTab()}
                  >
                    <Plus size={16} aria-hidden="true" />
                    {pending?.type === "create"
                      ? "Creating tab…"
                      : "Create new tab"}
                  </Button>
                )}
                <Button
                  type="button"
                  className="cdpv-button cdpv-action"
                  onClick={() => reconnect()}
                >
                  <RotateCw size={16} aria-hidden="true" />
                  Reconnect viewer
                </Button>
              </div>
            )}
          </div>
        )}
      </Tabs.Panel>
      <div className="cdpv-sr-only" role="status" aria-live="polite">
        {pending?.type === "create"
          ? "Creating tab"
          : pending
            ? "Closing tab"
            : snapshot.status}
        {interactive
          ? ". Press F8 to release remote keyboard focus."
          : ". View only."}
      </div>
    </Tabs.Root>
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
  const { address: addressElement } = useViewerElements();
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
        ref={addressElement}
        id={addressId}
        type="text"
        className="cdpv-address"
        aria-label="Remote page address"
        placeholder="Enter a URL"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={address}
        onChange={(event) => edit(event.target.value)}
        onFocus={() => focus()}
        onBlur={() => blur()}
      />
    </form>
  );
}
