import type { ViewerError } from "cdp-viewer";
import {
  ChevronDown,
  ChevronRight,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { demoScope } from "./context";

export function Console() {
  const model = demoScope.useModel();
  const { events, viewers, errorCount } = demoScope.useValue(model.console$);
  const clear = demoScope.useCommand(model.clearActivity$);
  return (
    <details className="demo-console">
      <summary>
        <span className="demo-console-title">
          <TerminalSquare size={16} aria-hidden="true" />
          Console
          <span className="demo-count" aria-label={`${events.length} events`}>
            {events.length}
          </span>
          {errorCount > 0 && (
            <span className="demo-console-error-count">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="demo-console-content">
        <div className="demo-console-toolbar">
          <span>Viewer callbacks · newest first</span>
          <button
            type="button"
            className="demo-button demo-small"
            aria-label="Clear console"
            disabled={!events.length}
            onClick={() => clear()}
          >
            <Trash2 size={12} aria-hidden="true" /> Clear
          </button>
        </div>
        <div className="demo-console-body">
          {errorCount > 0 && (
            <div className="demo-console-errors">
              {viewers.map(({ id, snapshot }) =>
                snapshot?.error ? (
                  <CurrentError key={id} viewerId={id} error={snapshot.error} />
                ) : null,
              )}
            </div>
          )}
          <div className="demo-console-states">
            {viewers.map(({ id, snapshot }) =>
              snapshot ? (
                <details key={id} className="demo-console-state">
                  <summary>
                    <ChevronRight size={12} aria-hidden="true" />
                    <span>Viewer {id} current state</span>
                    <code>{snapshot.status}</code>
                  </summary>
                  <pre
                    className="demo-snapshot"
                    aria-label={`Viewer ${id} current status summary`}
                  >
                    {JSON.stringify(snapshot, null, 2)}
                  </pre>
                </details>
              ) : null,
            )}
          </div>
          {events.length ? (
            <ol className="demo-console-log" aria-label="Console logs">
              {events.map((event) => (
                <li key={event.order}>
                  <details
                    className="demo-console-entry"
                    data-level={event.name === "onError" ? "error" : "info"}
                  >
                    <summary>
                      <ChevronRight size={12} aria-hidden="true" />
                      <span className="demo-console-source">
                        Viewer {event.viewerId}
                      </span>
                      <code>{event.name}</code>
                      <span className="demo-console-message">
                        {event.name === "onStatusChange"
                          ? `${event.value.status} · ${event.value.targetCount} tabs`
                          : event.name === "onWindowSizeSyncChange"
                            ? `Mode requested: ${event.value}`
                            : `${event.value.kind}: ${event.value.message}`}
                      </span>
                      <span className="demo-console-sequence">
                        #{event.sequence}
                      </span>
                    </summary>
                    <pre
                      className="demo-snapshot"
                      aria-label={`Viewer ${event.viewerId} ${event.name} event details`}
                    >
                      {JSON.stringify(event.value, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="demo-console-empty">
              No logs to show. Viewer callbacks appear here.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

function CurrentError({
  viewerId,
  error,
}: {
  viewerId: number;
  error: ViewerError;
}) {
  return (
    <section
      className="demo-current-error"
      aria-label={`Viewer ${viewerId} current error`}
    >
      <strong>Viewer {viewerId} · Current error</strong>
      <p>
        <code>{error.kind}</code> · {error.message}
      </p>
      {error.request && (
        <dl>
          <div>
            <dt>Command</dt>
            <dd>
              <code>{error.request.method}</code>
            </dd>
          </div>
          {error.request.code !== undefined && (
            <div>
              <dt>Error code</dt>
              <dd>{error.request.code}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
