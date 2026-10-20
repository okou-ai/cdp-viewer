import { CdpViewer } from "cdp-viewer";
import type { CdpViewerProps } from "cdp-viewer";
import { Monitor, Plus, RotateCw, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";

type Connection = Pick<CdpViewerProps, "cdpUrl" | "windowId"> & {
  generation: number;
};

export function App() {
  const [panels, setPanels] = useState([1]);
  const nextId = useRef(2);

  return (
    <main className="demo">
      <header className="demo-header">
        <div>
          <div className="demo-brand">
            <Monitor size={24} aria-hidden="true" />
            <h1>cdp-viewer</h1>
            <span className="demo-badge">View only</span>
          </div>
          <p>
            Open a live view of your browser. Add panels to view different
            windows.
          </p>
        </div>
        <nav aria-label="Project">
          <a href="https://github.com/okou-ai/cdp-viewer/blob/main/docs/demo.md">
            Connection guide
          </a>
          <a href="https://github.com/okou-ai/cdp-viewer">GitHub ↗</a>
        </nav>
      </header>

      <aside className="demo-guide" aria-label="Getting connected">
        <strong>Bring your own browser endpoint.</strong> Paste a browser-level
        CDP WebSocket URL. This HTTPS page normally needs <code>wss://</code>{" "}
        and an endpoint that allows this page’s Origin. Connection details stay
        in this page’s memory; nothing is saved or added to the URL.
        <details>
          <summary>About windows and view-only mode</summary>
          <p>
            Leave Window ID blank to see existing tabs across all windows, or
            use an actual integer window ID to limit the view. Zero is a valid
            ID. Window filtering limits what is shown; it is not access control.
          </p>
          <p>
            You can select existing tabs and watch them live. Remote navigation,
            typing, clipboard and vendor adapters are not available yet. Two
            panels can view different windows independently; simultaneous
            streams of the same tab are not guaranteed.
          </p>
          <p>
            Browser provisioning and authentication belong to your endpoint
            provider. This demo connects directly, without a relay or custom
            authentication headers. A connection that works in Node may still be
            blocked by the browser’s Origin, TLS or network policy. A local
            endpoint may also require the browser’s local-network access
            permission.
          </p>
        </details>
      </aside>

      <div className="demo-section-heading">
        <h2>Browser views</h2>
        <button
          type="button"
          className="demo-button"
          onClick={() => {
            const id = nextId.current++;
            setPanels((current) => [...current, id]);
          }}
        >
          <Plus size={16} aria-hidden="true" /> Add viewer
        </button>
      </div>
      <div className="demo-panels">
        {panels.map((id) => (
          <ConnectionPanel
            key={id}
            number={id}
            onRemove={() =>
              setPanels((current) => current.filter((n) => n !== id))
            }
          />
        ))}
      </div>
      {!panels.length && (
        <p className="demo-empty">Add a viewer to connect to a browser.</p>
      )}
      <footer className="demo-footer">
        Built with the public cdp-viewer React component. No accounts, downloads
        or browser provisioning included.
      </footer>
    </main>
  );
}

function ConnectionPanel({
  number,
  onRemove,
}: {
  number: number;
  onRemove: () => void;
}) {
  const id = useId();
  const [endpoint, setEndpoint] = useState("");
  const [windowDraft, setWindowDraft] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<"endpoint" | "window" | null>(null);
  const generation = useRef(0);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cdpUrl = endpoint.trim();
    try {
      const url = new URL(cdpUrl);
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      ) {
        setError("endpoint");
        return;
      }
    } catch {
      setError("endpoint");
      return;
    }
    const value = windowDraft.trim();
    const windowId = value === "" ? undefined : Number(value);
    if (
      value !== "" &&
      (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(windowId))
    ) {
      setError("window");
      return;
    }
    setError(null);
    setConnection({
      cdpUrl,
      ...(windowId === undefined ? {} : { windowId }),
      generation: ++generation.current,
    });
  }

  return (
    <section className="demo-panel" aria-labelledby={`${id}-heading`}>
      <div className="demo-panel-heading">
        <h3 id={`${id}-heading`}>Viewer {number}</h3>
        <button
          type="button"
          className="demo-icon-button"
          aria-label={`Remove viewer ${number}`}
          onClick={onRemove}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <form
        className="demo-form"
        onSubmit={connect}
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
            onChange={(event) => setEndpoint(event.target.value)}
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
            onChange={(event) => setWindowDraft(event.target.value)}
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
            onClick={() => {
              const next = ++generation.current;
              setConnection(
                (current) => current && { ...current, generation: next },
              );
            }}
          >
            <RotateCw size={14} aria-hidden="true" /> Reconnect
          </button>
          <button
            type="button"
            className="demo-button"
            disabled={!connection}
            onClick={() => setConnection(null)}
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
