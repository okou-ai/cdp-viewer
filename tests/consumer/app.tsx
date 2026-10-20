import { createStore, state } from "ccstate";
import { StoreProvider, useGet, useSet } from "ccstate-react";
import { CdpViewer } from "cdp-viewer";
import type { CdpViewerProps, ViewerSnapshot } from "cdp-viewer";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FixtureSettings } from "./api";

const hostStore = createStore();
const hostCount = state(0);

function HostCounter() {
  const value = useGet(hostCount);
  const set = useSet(hostCount);
  return (
    <button className="host-button" onClick={() => set(value + 1)}>
      Host count: {value}
    </button>
  );
}

function App() {
  const [settings, setSettings] = useState<FixtureSettings | null>(null);
  const [first, setFirst] = useState(true);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const configure = async (value: FixtureSettings) => {
      await import("cdp-viewer/style.css");
      if (active) setSettings(value);
    };
    window.configureViewers = configure;
    window.removeFirstViewer = () => setFirst(false);
    window.restoreFirstViewer = () => setFirst(true);
    return () => {
      active = false;
      if (window.configureViewers === configure) {
        delete window.configureViewers;
        delete window.removeFirstViewer;
        delete window.restoreFirstViewer;
      }
    };
  }, []);
  const status = (key: string) => (snapshot: ViewerSnapshot) => {
    setStatuses((old) =>
      old[key] === snapshot.status ? old : { ...old, [key]: snapshot.status },
    );
  };
  const props: CdpViewerProps | null = settings
    ? { cdpUrl: settings.cdpUrl, style: { "--cdpv-radius": "3px" } }
    : null;
  return (
    <StoreProvider value={hostStore}>
      <h1>Independent packed consumer</h1>
      <HostCounter />
      <span id="host-prefix-probe" className="hidden">
        Host class stays visible
      </span>
      <div className="flex" id="host-utility">
        Unprefixed host utility
      </div>
      <output id="statuses">{JSON.stringify(statuses)}</output>
      <div
        id="panels"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
      >
        {props && settings && (
          <>
            {first && (
              <div id="viewer-a">
                <CdpViewer
                  {...props}
                  {...(settings.windowA === undefined
                    ? {}
                    : { windowId: settings.windowA })}
                  onStatusChange={status("a")}
                />
              </div>
            )}
            {settings.second !== false && (
              <div id="viewer-b">
                <CdpViewer
                  {...props}
                  {...(settings.windowB === undefined
                    ? {}
                    : { windowId: settings.windowB })}
                  onStatusChange={status("b")}
                />
              </div>
            )}
          </>
        )}
      </div>
    </StoreProvider>
  );
}

const style = document.createElement("style");
style.textContent =
  "body { margin: 18px; font-family: serif } .flex { display: grid }";
document.head.append(style);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
