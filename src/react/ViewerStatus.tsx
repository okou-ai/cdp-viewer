import { Button } from "@base-ui/react/button";
import {
  CircleAlert,
  Monitor,
  Plus,
  LucideProvider,
  RotateCw,
} from "lucide-react";
import { viewerScope } from "./context";
import { useViewerElements } from "./runtime";

/** Diagnostics and recovery are local viewer UI, separate from the input surface. */
export function StageStatus() {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const controls = viewerScope.useValue(model.controls$);
  const notification = viewerScope.useValue(model.notification$);
  const pending = viewerScope.useValue(model.tabAction$);
  const reconnect = viewerScope.useCommand(model.reconnect$);
  const retryImage = viewerScope.useCommand(model.retryImage$);
  const createTab = viewerScope.useCommand(model.createTab$);
  const { notice } = useViewerElements();
  return (
    <LucideProvider>
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
              Open a page in this window, or reconnect after updating the window
              scope.
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
  );
}

export function ClipboardRecovery() {
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

export function ViewerAnnouncements({ interactive }: { interactive: boolean }) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const pending = viewerScope.useValue(model.tabAction$);
  return (
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
  );
}
