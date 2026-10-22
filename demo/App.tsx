import { CdpViewer } from "cdp-viewer";
import { Monitor, Plus, RotateCw, X } from "lucide-react";
import { demoScope } from "./context";
import type { Panel } from "./model";

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
  const add = demoScope.useCommand(model.add$);
  const appearance = demoScope.useValue(model.appearance$);
  const setAppearance = demoScope.useCommand(model.setAppearance$);
  const appearanceId = demoScope.useIdentity();

  return (
    <div
      className="demo-page"
      style={{
        colorScheme: appearance === "system" ? "light dark" : appearance,
      }}
    >
      <main className="demo">
        <header className="demo-header">
          <div>
            <div className="demo-brand">
              <Monitor size={24} aria-hidden="true" />
              <h1>cdp-viewer</h1>
              <span className="demo-badge">Interactive</span>
            </div>
            <p>
              View and control your browser. Add panels for different windows.
            </p>
          </div>
          <label className="demo-appearance" htmlFor={appearanceId}>
            Appearance
            <select
              id={appearanceId}
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
              Connection guide
            </a>
            <a href="https://github.com/okou-ai/cdp-viewer">GitHub ↗</a>
          </nav>
        </header>

        <aside className="demo-guide" aria-label="Getting connected">
          <strong>Bring your own browser endpoint.</strong> Paste a
          browser-level CDP WebSocket URL. This HTTPS page normally needs{" "}
          <code>wss://</code> and an endpoint that allows this page’s Origin.
          Connection details stay in this page’s memory; nothing is saved or
          added to the URL.
          <details>
            <summary>About windows and interaction</summary>
            <p>
              Leave Window ID blank to see existing tabs across all windows, or
              use an actual integer window ID to limit the view. Zero is a valid
              ID. Window filtering limits what is shown; it is not access
              control.
            </p>
            <p>
              Select an existing tab, then click the live page to use your mouse
              and keyboard. Use the address bar to navigate, go back or forward,
              or reload. Press F8 to release remote keyboard focus. Two panels
              can control different windows independently; simultaneous streams
              of the same tab are not guaranteed.
            </p>
            <p>
              Copy and paste plain text in supported text controls. If automatic
              copy is blocked, use the local copy recovery controls. Vendor
              adapters are not supported yet. System IME behavior on macOS and
              Windows is still being validated.
            </p>
            <p>
              Browser provisioning and authentication belong to your endpoint
              provider. This demo connects directly, without a relay or custom
              authentication headers. A connection that works in Node may still
              be blocked by the browser’s Origin, TLS or network policy. A local
              endpoint may also require the browser’s local-network access
              permission.
            </p>
          </details>
        </aside>

        <div className="demo-section-heading">
          <h2>Browser views</h2>
          <button type="button" className="demo-button" onClick={() => add()}>
            <Plus size={16} aria-hidden="true" /> Add viewer
          </button>
        </div>
        <div className="demo-panels">
          {panels.map((panel) => (
            <ConnectionPanel key={panel.id} panel={panel} />
          ))}
        </div>
        {!panels.length && (
          <p className="demo-empty">Add a viewer to connect to a browser.</p>
        )}
        <footer className="demo-footer">
          Built with the public cdp-viewer React component. No accounts,
          downloads or browser provisioning included.
        </footer>
      </main>
    </div>
  );
}

function ConnectionPanel({ panel }: { panel: Panel }) {
  const { id: number, endpoint, windowDraft, connection, error } = panel;
  const model = demoScope.useModel();
  const id = demoScope.useIdentity() + "-" + number;
  const remove = demoScope.useCommand(model.remove$);
  const edit = demoScope.useCommand(model.edit$);
  const connect = demoScope.useCommand(model.connect$);
  const reconnect = demoScope.useCommand(model.reconnect$);
  const disconnect = demoScope.useCommand(model.disconnect$);

  return (
    <section className="demo-panel" aria-labelledby={`${id}-heading`}>
      <div className="demo-panel-heading">
        <h3 id={`${id}-heading`}>Viewer {number}</h3>
        <button
          type="button"
          className="demo-icon-button"
          aria-label={`Remove viewer ${number}`}
          onClick={() => remove(number)}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <form
        className="demo-form"
        onSubmit={(event) => {
          event.preventDefault();
          connect(number);
        }}
        noValidate
        autoComplete="off"
      >
        <div className="demo-field demo-endpoint">
          <label htmlFor={`${id}-endpoint`}>CDP URL</label>
          <input
            id={`${id}-endpoint`}
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="wss://…"
            value={endpoint}
            onChange={(event) => edit(number, "endpoint", event.target.value)}
            aria-invalid={error === "endpoint"}
            aria-describedby={error === "endpoint" ? `${id}-error` : undefined}
          />
        </div>
        <div className="demo-field">
          <label htmlFor={`${id}-window`}>
            Window ID <span>(optional)</span>
          </label>
          <input
            id={`${id}-window`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="All windows"
            value={windowDraft}
            onChange={(event) =>
              edit(number, "windowDraft", event.target.value)
            }
            aria-invalid={error === "window"}
            aria-describedby={error === "window" ? `${id}-error` : undefined}
          />
        </div>
        {error && (
          <p id={`${id}-error`} className="demo-validation" role="alert">
            {error === "endpoint"
              ? "Enter an absolute ws:// or wss:// browser endpoint without userinfo or a fragment."
              : "Window ID must be a safe integer, or leave it blank for all windows."}
          </p>
        )}
        <div className="demo-actions">
          <button type="submit" className="demo-button demo-primary">
            {connection ? "Apply & connect" : "Connect"}
          </button>
          <button
            type="button"
            className="demo-button"
            disabled={!connection}
            onClick={() => reconnect(number)}
          >
            <RotateCw size={14} aria-hidden="true" /> Reconnect
          </button>
          <button
            type="button"
            className="demo-button"
            disabled={!connection}
            onClick={() => disconnect(number)}
          >
            Disconnect
          </button>
        </div>
        <p className="demo-form-hint">
          Apply changes explicitly. Reconnect uses the last applied settings.
        </p>
      </form>
      {connection ? (
        <CdpViewer
          key={connection.generation}
          cdpUrl={connection.cdpUrl}
          interactive
          {...(connection.windowId === undefined
            ? {}
            : { windowId: connection.windowId })}
          style={{ height: "28rem" }}
        />
      ) : (
        <div className="demo-disconnected" role="status">
          <Monitor size={32} aria-hidden="true" />
          <strong>No browser connected</strong>
          <span>Enter an endpoint above, then connect to start viewing.</span>
        </div>
      )}
    </section>
  );
}
