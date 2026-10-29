import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Monitor,
  Plus,
  X,
  LoaderCircle,
  LucideProvider,
  RotateCw,
} from "lucide-react";
import type { CdpViewerProps, ViewerNavigation } from "../viewer/types";
import { AllTabs } from "./AllTabs";
import { tabTitle } from "./labels";
import { Favicon } from "./Favicon";
import { BrowserMenu } from "./BrowserMenu";
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
  showSettingsMenu = true,
  colorScheme,
  tabStyle = "attached",
  toolbarEnd,
  stageOverlay,
  blankPage,
  labels,
  className,
  style,
}: CdpViewerProps) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const tabLayout = viewerScope.useValue(model.tabLayout$);
  const select = viewerScope.useCommand(model.select$);
  const reconnect = viewerScope.useCommand(model.reconnect$);
  const retryImage = viewerScope.useCommand(model.retryImage$);
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
      data-tab-style={tabStyle}
      value={snapshot.selectedTargetId}
      onValueChange={(value) => {
        if (typeof value === "string") select(value);
      }}
    >
      <div className="cdpv-toolbar">
        <LucideProvider>
          <Tabs.List
            id={selectId}
            ref={tabs}
            className="cdpv-tabs"
            aria-label="Browser tabs"
            activateOnFocus={false}
          >
            {tabLayout.items.map(({ target, width }) => {
              const title = tabTitle(target.title, labels);
              return (
                <div
                  className="cdpv-tab-item"
                  key={target.id}
                  style={{ width }}
                  data-selected={
                    target.id === snapshot.selectedTargetId ? "" : undefined
                  }
                >
                  <Tabs.Tab
                    type="button"
                    className="cdpv-tab"
                    value={target.id}
                    title={title}
                    aria-label={title}
                    disabled={controls.tabsDisabled}
                    data-target-id={target.id}
                  >
                    <Favicon targetId={target.id} />
                    <span className="cdpv-tab-title">{title}</span>
                  </Tabs.Tab>
                  {interactive && (
                    <Button
                      type="button"
                      className="cdpv-close"
                      aria-label={`Close ${title}`}
                      title={`Close ${title}`}
                      data-close-target={target.id}
                      aria-busy={
                        pending?.type === "close" &&
                        pending.targetId === target.id
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
              );
            })}
          </Tabs.List>
          {tabLayout.overflow && <AllTabs labels={labels} />}
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
        </LucideProvider>
        {toolbarEnd !== undefined && (
          <div className="cdpv-toolbar-end">{toolbarEnd}</div>
        )}
      </div>
      {interactive && (
        <LucideProvider>
          <NavigationToolbar
            navigation={snapshot.navigation ?? null}
            disabled={!controls.streaming}
            showSettingsMenu={showSettingsMenu}
            placeholder={labels?.addressPlaceholder ?? "Enter a URL"}
          />
        </LucideProvider>
      )}
      <Tabs.Panel
        tabIndex={-1}
        keepMounted
        value={snapshot.selectedTargetId}
        className={`cdpv-stage${interactive ? " cdpv-interactive" : ""}`}
        data-loading-preview={controls.loadingPreview ? "" : undefined}
        aria-busy={snapshot.status === "connecting"}
      >
        <LucideProvider>
          <canvas
            ref={canvas}
            role="img"
            aria-label="Live browser view"
            aria-hidden={!controls.streaming}
          >
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
            <div
              className="cdpv-placeholder"
              data-loading={snapshot.status === "connecting" ? "" : undefined}
              data-preview={controls.loadingPreview ? "" : undefined}
            >
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
                  {controls.showImageRetry && (
                    <Button
                      type="button"
                      className="cdpv-button cdpv-primary"
                      disabled={!controls.canRetryImage}
                      onClick={() => retryImage()}
                    >
                      <RotateCw size={16} aria-hidden="true" />
                      {controls.retryingImage
                        ? "Retrying live image…"
                        : "Retry live image"}
                    </Button>
                  )}
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
        </LucideProvider>
        {interactive &&
          blankPage !== undefined &&
          controls.streaming &&
          snapshot.navigation?.url === "about:blank" && (
            <div className="cdpv-blank-page">{blankPage}</div>
          )}
        {stageOverlay !== undefined && (
          <div className="cdpv-stage-overlay">{stageOverlay}</div>
        )}
      </Tabs.Panel>
      {interactive && (
        <LucideProvider>
          <ClipboardRecovery />
        </LucideProvider>
      )}
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

function ClipboardRecovery() {
  const model = viewerScope.useModel();
  const value = viewerScope.useValue(model.clipboard$);
  const copy = viewerScope.useCommand(model.copyClipboard$);
  const dismiss = viewerScope.useCommand(model.dismissClipboard$);
  const select = viewerScope.useCommand(model.selectClipboard$);
  const { clipboard } = useViewerElements();
  if (!value) return null;
  return (
    <section className="cdpv-clipboard" aria-label="Clipboard recovery">
      <p role="status">{value.message}</p>
      {value.text !== null && (
        <>
          <textarea
            ref={clipboard}
            aria-label="Text to copy"
            readOnly
            value={value.text}
            rows={3}
            spellCheck={false}
            onFocus={() => select()}
          />
          <Button
            type="button"
            className="cdpv-button cdpv-action"
            onClick={() => copy()}
          >
            Copy text
          </Button>
        </>
      )}
      <Button
        type="button"
        className="cdpv-button cdpv-action"
        onClick={() => dismiss()}
      >
        Dismiss
      </Button>
    </section>
  );
}

function NavigationToolbar({
  navigation,
  disabled,
  showSettingsMenu,
  placeholder,
}: {
  navigation: ViewerNavigation | null;
  disabled: boolean;
  showSettingsMenu: boolean;
  placeholder: string;
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
    <div className="cdpv-navigation">
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
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={address}
        onChange={(event) => edit(event.target.value)}
        onFocus={() => focus()}
        onBlur={() => blur()}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.stopPropagation();
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          event.preventDefault();
          submit();
        }}
      />
      {showSettingsMenu && <BrowserMenu />}
    </div>
  );
}
