import { CdpViewer } from "cdp-viewer";
import {
  ArrowUpRight,
  Link2,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RotateCw,
  Unplug,
  X,
} from "lucide-react";
import { demoScope } from "./context";
import { Console } from "./Console";
import type { Panel } from "./model";
import { viewerClassName, viewerStyle } from "./playground";
import { Settings } from "./Settings";
import { ResizeHandle } from "./ResizeHandle";

export function App() {
  return (
    <demoScope.Provider>
      <DemoView />
    </demoScope.Provider>
  );
}

function DemoView() {
  const model = demoScope.useModel();
  const panels = demoScope.useValue(model.panels$);
  const appearance = demoScope.useValue(model.appearance$);
  const add = demoScope.useCommand(model.add$);
  const setAppearance = demoScope.useCommand(model.setAppearance$);
  const id = demoScope.useIdentity();

  return (
    <div
      className="demo-page"
      style={{
        colorScheme: appearance === "system" ? "light dark" : appearance,
      }}
    >
      <main className="demo">
        <header className="demo-header">
          <div className="demo-brand">
            <span className="demo-brand-icon">
              <Monitor size={19} aria-hidden="true" />
            </span>
            <h1>cdp-viewer</h1>
            <span className="demo-badge">Playground</span>
          </div>
          <div className="demo-header-actions">
            <label className="demo-appearance" htmlFor={`${id}-appearance`}>
              Appearance
              <select
                id={`${id}-appearance`}
                value={appearance}
                onChange={(event) => setAppearance(event.target.value)}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <nav aria-label="Project">
              <a href="https://github.com/okou-ai/cdp-viewer/blob/main/demo/README.md">
                Guide <ArrowUpRight size={14} aria-hidden="true" />
              </a>
              <a href="https://github.com/okou-ai/cdp-viewer">
                GitHub <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </nav>
          </div>
        </header>
        <div className="demo-intro">
          <div>
            <h2>Browser playground</h2>
            <p>Connect a browser and explore the viewer, one prop at a time.</p>
          </div>
          <button
            type="button"
            className="demo-button demo-primary"
            onClick={() => add()}
          >
            <Plus size={16} aria-hidden="true" /> Add viewer
          </button>
        </div>
        <aside className="demo-guide" aria-label="Getting connected">
          <details>
            <summary>
              Bring your own browser endpoint <span>Connection notes</span>
            </summary>
            <div>
              <p>
                Use a browser-level CDP WebSocket URL. This HTTPS page normally
                needs <code>wss://</code> and an endpoint that permits this
                page’s Origin. Local endpoints may also need local-network
                permission.
              </p>
              <p>
                Leave Window ID blank for all windows, or use an actual integer,
                including zero. Window filtering is presentation scope.
                Different windows can be viewed independently; simultaneous
                streams of the same tab are not guaranteed.
              </p>
              <p>
                Click the live page to control it; F8 releases remote keyboard
                focus. Browser Use needs compatible activation events. Genuine
                macOS/Windows system IME validation is pending.
              </p>
              <p>
                Connection details stay in page memory and clear on refresh. No
                accounts, storage, analytics, relay or browser provisioning are
                included.
              </p>
            </div>
          </details>
        </aside>
        <div className="demo-panels">
          {panels.map((panel) => (
            <ConnectionPanel key={panel.id} panel={panel} />
          ))}
        </div>
        {!panels.length && (
          <div className="demo-empty">
            <Monitor size={28} aria-hidden="true" />
            <p>Add a viewer to connect to a browser.</p>
          </div>
        )}
        <footer className="demo-footer">
          <span>
            <span className="demo-dot" /> Built with the public React component
          </span>
          <span>Independent views. Connection details stay in memory.</span>
        </footer>
      </main>
    </div>
  );
}

function ConnectionPanel({ panel }: { panel: Panel }) {
  const model = demoScope.useModel();
  const remove = demoScope.useCommand(model.remove$);
  const configure = demoScope.useCommand(model.configure$);
  const observeStatus = demoScope.useCommand(model.observeStatus$);
  const observeError = demoScope.useCommand(model.observeError$);
  const observeWindowSizeSync = demoScope.useCommand(
    model.observeWindowSizeSync$,
  );
  const { id, connection, options } = panel;
  const identity = `${demoScope.useIdentity()}-${id}`;
  const status =
    panel.snapshot?.status ?? (connection ? "connecting" : "disconnected");

  return (
    <section className="demo-panel" aria-labelledby={`${identity}-heading`}>
      <div className="demo-panel-heading">
        <div className="demo-panel-title">
          <span className="demo-panel-number">
            {String(id).padStart(2, "0")}
          </span>
          <h3 id={`${identity}-heading`}>Viewer {id}</h3>
          <span className="demo-status" data-state={status}>
            <span className="demo-dot" />
            {status === "disconnected" ? "Not connected" : status}
          </span>
        </div>
        <button
          type="button"
          className="demo-icon-button"
          aria-label={`Remove viewer ${id}`}
          onClick={() => remove(id)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <ConnectionBar panel={panel} identity={identity} />
      <div className="demo-panel-body">
        <div className="demo-preview">
          <div className="demo-preview-toolbar">
            <span className="demo-preview-label">
              <Monitor size={14} aria-hidden="true" /> Preview
            </span>
            <div>
              <label className="demo-mode">
                Mode
                <select
                  aria-label="Control mode"
                  value={options.interactive ? "interactive" : "view-only"}
                  onChange={(event) =>
                    configure(id, {
                      interactive: event.target.value === "interactive",
                    })
                  }
                >
                  <option value="interactive">Interactive</option>
                  <option value="view-only">View only</option>
                </select>
              </label>
              <button
                type="button"
                className="demo-button demo-small"
                disabled={!connection}
                aria-pressed={options.paused}
                onClick={() => configure(id, { paused: !options.paused })}
              >
                {options.paused ? (
                  <Play size={13} aria-hidden="true" />
                ) : (
                  <Pause size={13} aria-hidden="true" />
                )}
                {options.paused ? "Resume stream" : "Pause stream"}
              </button>
            </div>
          </div>
          <div className="demo-stage">
            {connection ? (
              <CdpViewer
                key={connection.generation}
                cdpUrl={connection.cdpUrl}
                extensions={connection.extensions}
                interactive={options.interactive}
                paused={options.paused}
                windowSizeSync={options.windowSizeSync}
                onWindowSizeSyncChange={(mode) =>
                  observeWindowSizeSync(id, connection.generation, mode)
                }
                capture={options.capture}
                className={viewerClassName(options)}
                style={viewerStyle(options)}
                {...(connection.windowId === undefined
                  ? {}
                  : { windowId: connection.windowId })}
                {...(options.theme === "inherit"
                  ? {}
                  : { colorScheme: options.theme })}
                onStatusChange={(snapshot) =>
                  observeStatus(id, connection.generation, snapshot)
                }
                onError={(error) =>
                  observeError(id, connection.generation, error)
                }
              />
            ) : (
              <div
                className={`demo-disconnected ${viewerClassName(options)}`}
                style={{
                  ...viewerStyle(options),
                  ...(options.theme === "inherit"
                    ? {}
                    : {
                        colorScheme:
                          options.theme === "system"
                            ? "light dark"
                            : options.theme,
                      }),
                }}
              >
                <div className="demo-placeholder-chrome" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <div />
                  <Plus size={13} />
                </div>
                <div className="demo-placeholder-content">
                  <span className="demo-placeholder-icon">
                    <MousePointer2
                      size={28}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </span>
                  <strong>Ready when you are.</strong>
                  <p>
                    Connect your browser above.
                    <br />
                    Make the viewer yours with the controls alongside.
                  </p>
                  <div className="demo-placeholder-features">
                    <span>Live tabs</span>
                    <span>Mouse & keyboard</span>
                    <span>Your own theme</span>
                  </div>
                </div>
              </div>
            )}
            <ResizeHandle panel={panel} identity={identity} />
          </div>
          <div className="demo-preview-caption">
            <span id={`${identity}-size`}>
              {options.width}% width{" "}
              <span className="demo-caption-separator">/</span> {options.height}
              px height
            </span>
            <span>
              <kbd>F8</kbd> Release keyboard focus
            </span>
          </div>
        </div>
        <Settings panel={panel} identity={identity} />
      </div>
      <Console panel={panel} />
    </section>
  );
}

function ConnectionBar({
  panel,
  identity,
}: {
  panel: Panel;
  identity: string;
}) {
  const model = demoScope.useModel();
  const edit = demoScope.useCommand(model.edit$);
  const connect = demoScope.useCommand(model.connect$);
  const reconnect = demoScope.useCommand(model.reconnect$);
  const disconnect = demoScope.useCommand(model.disconnect$);
  return (
    <form
      id={`${identity}-connection`}
      className="demo-connection-bar"
      noValidate
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        connect(panel.id);
      }}
    >
      <div className="demo-endpoint-field">
        <label htmlFor={`${identity}-endpoint`}>
          <Link2 size={14} aria-hidden="true" />
          CDP URL
        </label>
        <input
          id={`${identity}-endpoint`}
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="wss://your-browser-endpoint"
          value={panel.endpoint}
          onChange={(event) => edit(panel.id, "endpoint", event.target.value)}
          aria-invalid={panel.error === "endpoint"}
          aria-describedby={panel.error ? `${identity}-error` : undefined}
        />
      </div>
      <div className="demo-actions">
        <button type="submit" className="demo-button demo-primary">
          {panel.connection ? "Apply & connect" : "Connect"}
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="demo-button demo-square"
          aria-label="Reconnect"
          title="Reconnect with applied settings"
          disabled={!panel.connection}
          onClick={() => reconnect(panel.id)}
        >
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="demo-button demo-square"
          aria-label="Disconnect"
          title="Disconnect"
          disabled={!panel.connection}
          onClick={() => disconnect(panel.id)}
        >
          <Unplug size={14} aria-hidden="true" />
        </button>
      </div>
      {panel.error && (
        <p id={`${identity}-error`} className="demo-validation" role="alert">
          {panel.error === "endpoint"
            ? "Enter an absolute ws:// or wss:// browser endpoint without userinfo or a fragment."
            : "Window ID must be a safe integer, or leave it blank for all windows."}
        </p>
      )}
    </form>
  );
}
