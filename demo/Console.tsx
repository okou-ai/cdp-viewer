import type { ViewerError } from "cdp-viewer";
import {
  ChevronDown,
  ChevronRight,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { demoScope } from "./context";
import type { Panel } from "./model";

export function Console({ panel }: { panel: Panel }) {
  const model = demoScope.useModel();
  const clear = demoScope.useCommand(model.clearActivity$);
  const { id, snapshot, activity } = panel;
  return (
    <details className="demo-console" aria-label={`Viewer ${id} console`}>
      <summary>
        <span className="demo-console-title">
          <TerminalSquare size={16} aria-hidden="true" />
          Console
          <span className="demo-count" aria-label={`${activity.length} events`}>
            {activity.length}
          </span>
          {snapshot?.error && (
            <span className="demo-console-error-count">1 error</span>
          )}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="demo-console-content">
        <div className="demo-console-toolbar">
          <span>Viewer {id} callbacks · newest first</span>
          <button
            type="button"
            className="demo-button demo-small"
            aria-label="Clear console"
            disabled={!activity.length}
            onClick={() => clear(id)}
          >
            <Trash2 size={12} aria-hidden="true" /> Clear
          </button>
        </div>
        <div className="demo-console-body">
          {snapshot?.error && (
            <div className="demo-console-errors">
              <CurrentError viewerId={id} error={snapshot.error} />
            </div>
          )}
          {snapshot && (
            <div className="demo-console-states">
              <details className="demo-console-state">
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
            </div>
          )}
          {activity.length ? (
            <ol
              className="demo-console-log"
              aria-label={`Viewer ${id} console logs`}
            >
              {[...activity].reverse().map((event) => (
                <li key={event.sequence}>
                  <details
                    className="demo-console-entry"
                    data-level={event.name === "onError" ? "error" : "info"}
                  >
                    <summary>
                      <ChevronRight size={12} aria-hidden="true" />
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
                      aria-label={`Viewer ${id} ${event.name} event details`}
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
