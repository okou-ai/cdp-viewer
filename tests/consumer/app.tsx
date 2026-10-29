import { createStore, state } from "ccstate";
import { StoreProvider, useGet, useSet } from "ccstate-react";
import { CdpViewer } from "cdp-viewer";
import type {
  CdpViewerProps,
  CdpViewerStyle,
  ViewerSnapshot,
} from "cdp-viewer";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FixtureSettings } from "./api";

const hostStore = createStore();
const hostCount = state(0);

function HostCounter() {
  const value = useGet(hostCount);
  const set = useSet(hostCount);
  return (
    <button
      type="button"
      className="host-button"
      onClick={() => set(value + 1)}
    >
      Host count: {value}
    </button>
  );
}

function HostToolbarAction({ label }: { label: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={expanded}
      style={{ whiteSpace: "nowrap" }}
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? `${label} with additional sharing options` : label}
    </button>
  );
}

function HostAppearanceProbe({ name }: { name: string }) {
  return (
    <div
      data-testid={`host-appearance-${name}`}
      style={{ width: 120, height: 96, pointerEvents: "auto" }}
    >
      <button type="button" disabled className="host-appearance-control">
        Host disabled
      </button>
      <button
        type="button"
        disabled
        aria-busy="true"
        className="host-appearance-control"
      >
        Host busy
      </button>
      <canvas
        aria-label="Host chart"
        className="host-appearance-canvas"
        width={60}
        height={24}
      />
      <div className="host-appearance-box">Host box</div>
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState<FixtureSettings | null>(null);
  const [first, setFirst] = useState(true);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [submissions, setSubmissions] = useState(0);
  const [slotActions, setSlotActions] = useState(0);
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
    ? {
        cdpUrl: settings.cdpUrl,
        interactive: settings.interactive ?? false,
        ...(settings.transport === undefined
          ? {}
          : { transport: settings.transport }),
        paused: settings.paused ?? false,
        ...(settings.windowSizeSync === undefined
          ? {}
          : { windowSizeSync: settings.windowSizeSync }),
      }
    : null;
  const theme = (value: CdpViewerStyle | undefined): CdpViewerStyle => ({
    "--cdpv-radius": "3px",
    ...value,
  });
  const HostContainer = settings?.hostForm ? "form" : "div";
  return (
    <StoreProvider value={hostStore}>
      <HostContainer
        id="host-shell"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmissions((count) => count + 1);
        }}
      >
        <h1>Independent packed consumer</h1>
        {settings?.hostForm && (
          <>
            <style>{"section { display: block }"}</style>
            <button type="submit">Host submit</button>
            <output id="host-submissions">{submissions}</output>
          </>
        )}
        <HostCounter />
        {settings?.hostAppearance && (
          <>
            <style>{`@layer host {
              .host-appearance-control:disabled { opacity: .6; }
              .host-appearance-canvas { width: 60px; height: 24px; display: inline-block; object-fit: fill; }
              .host-appearance-box { box-sizing: content-box; width: 40px; height: 16px; padding: 3px; border: 2px solid; }
            }`}</style>
            <HostAppearanceProbe name="outside" />
          </>
        )}
        <label>
          Host input <input aria-label="Host input" />
        </label>
        <span id="host-prefix-probe" className="hidden">
          Host class stays visible
        </span>
        <div className="flex" id="host-utility">
          Unprefixed host utility
        </div>
        <output id="statuses">{JSON.stringify(statuses)}</output>
        <output id="host-slot-actions">{slotActions}</output>
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
                    style={theme(settings.styleA)}
                    {...(settings.tabStyleA === undefined
                      ? {}
                      : { tabStyle: settings.tabStyleA })}
                    {...(settings.labelsA === undefined
                      ? {}
                      : { labels: settings.labelsA })}
                    toolbarEnd={
                      settings.hostAppearance ? (
                        <HostAppearanceProbe name="toolbar" />
                      ) : settings.toolbarLabel === undefined ? undefined : (
                        <HostToolbarAction label={settings.toolbarLabel} />
                      )
                    }
                    stageOverlay={
                      settings.hostAppearance ? (
                        <HostAppearanceProbe name="overlay" />
                      ) : settings.hostOverlay ? (
                        <div
                          style={{
                            position: "absolute",
                            right: 8,
                            top: "50%",
                            width: 180,
                            pointerEvents: "auto",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setSlotActions((count) => count + 1)}
                          >
                            Host overlay action
                          </button>
                          <label>
                            Host overlay input{" "}
                            <input
                              aria-label="Host overlay input"
                              style={{ width: "100%" }}
                            />
                          </label>
                          <div
                            data-testid="host-overlay-scroll"
                            style={{ width: 180, height: 80, overflow: "auto" }}
                          >
                            <div style={{ height: 300 }}>Host scroll area</div>
                          </div>
                        </div>
                      ) : undefined
                    }
                    blankPage={
                      settings.hostAppearance ? (
                        <HostAppearanceProbe name="blank" />
                      ) : settings.hostBlankPage ? (
                        <div
                          style={{
                            display: "grid",
                            placeContent: "center",
                            height: "100%",
                          }}
                        >
                          <p>Start page content</p>
                          <label>
                            Start page input{" "}
                            <input aria-label="Start page input" />
                          </label>
                          <button
                            type="button"
                            onClick={() => setSlotActions((count) => count + 1)}
                          >
                            Start page action
                          </button>
                        </div>
                      ) : undefined
                    }
                    {...(settings.captureA === undefined
                      ? {}
                      : { capture: settings.captureA })}
                    {...(settings.colorSchemeA === undefined
                      ? {}
                      : { colorScheme: settings.colorSchemeA })}
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
                    style={theme(settings.styleB)}
                    {...(settings.captureB === undefined
                      ? {}
                      : { capture: settings.captureB })}
                    {...(settings.colorSchemeB === undefined
                      ? {}
                      : { colorScheme: settings.colorSchemeB })}
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
        <label>
          After viewers <input aria-label="After viewers" />
        </label>
      </HostContainer>
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
