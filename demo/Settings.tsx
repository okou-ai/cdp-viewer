import { browserUse } from "cdp-viewer/extensions/browser-use";
import { ChevronDown, Code2, Palette, SlidersHorizontal } from "lucide-react";
import { demoScope } from "./context";
import type { Panel } from "./model";
import {
  captureResolutions,
  propGuide,
  sizeLimits,
  usageCode,
} from "./playground";

const extensionOptions = [
  { label: "Browser Use", extension: browserUse() },
] as const;
const dimensions = [
  { key: "height", label: "Height", ...sizeLimits.height, step: 1, unit: "px" },
  { key: "width", label: "Width", ...sizeLimits.width, step: 1, unit: "%" },
  {
    key: "radius",
    label: "Corner radius",
    min: 0,
    max: 24,
    step: 2,
    unit: "px",
  },
] as const;

export function Settings({
  panel,
  identity,
}: {
  panel: Panel;
  identity: string;
}) {
  const model = demoScope.useModel();
  const edit = demoScope.useCommand(model.edit$);
  const setExtension = demoScope.useCommand(model.setExtension$);
  return (
    <aside
      className="demo-settings"
      aria-label={`Viewer ${panel.id} properties`}
    >
      <div className="demo-rail-heading">
        <strong>Make it yours</strong>
        <span>{Object.keys(propGuide).length} props</span>
      </div>
      <details className="demo-group" open>
        <summary>
          <span>
            <SlidersHorizontal size={15} aria-hidden="true" /> Connection
            options
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div className="demo-group-content">
          <div className="demo-field">
            <label htmlFor={`${identity}-window`}>
              Window ID <span>optional</span>
            </label>
            <input
              id={`${identity}-window`}
              form={`${identity}-connection`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="All windows"
              value={panel.windowDraft}
              onChange={(event) =>
                edit(panel.id, "windowDraft", event.target.value)
              }
              aria-invalid={panel.error === "window"}
              aria-describedby={
                panel.error === "window" ? `${identity}-error` : undefined
              }
            />
          </div>
          <fieldset className="demo-extensions">
            <legend>
              Extensions <span>optional</span>
            </legend>
            {extensionOptions.map(({ label, extension }) => (
              <label key={extension.id}>
                <input
                  type="checkbox"
                  form={`${identity}-connection`}
                  checked={panel.extensions.some(
                    (value) => value.id === extension.id,
                  )}
                  onChange={(event) =>
                    setExtension(panel.id, extension, event.target.checked)
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="demo-hint">
            Drafts apply on connect. Reconnect keeps the last applied settings.
          </p>
        </div>
      </details>
      <AppearanceSettings panel={panel} identity={identity} />
      <CaptureSettings panel={panel} identity={identity} />
      <details className="demo-group">
        <summary>
          <span>
            <Code2 size={15} aria-hidden="true" /> Usage
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div className="demo-group-content">
          <p className="demo-hint">
            Applied connection and current controls. Your endpoint is replaced
            with a variable.
          </p>
          <pre className="demo-code" aria-label="Component code">
            <code>{usageCode(panel.options, panel.connection)}</code>
          </pre>
          <details className="demo-prop-reference">
            <summary>All public props</summary>
            <dl>
              {Object.entries(propGuide).map(([name, location]) => (
                <div key={name}>
                  <dt>
                    <code>{name}</code>
                  </dt>
                  <dd>{location}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </details>
    </aside>
  );
}

function CaptureSettings({
  panel,
  identity,
}: {
  panel: Panel;
  identity: string;
}) {
  const model = demoScope.useModel();
  const configure = demoScope.useCommand(model.configure$);
  const { capture } = panel.options;
  return (
    <details className="demo-group">
      <summary>
        <span>
          <SlidersHorizontal size={15} aria-hidden="true" /> Capture quality
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="demo-group-content">
        <div className="demo-field demo-range">
          <label htmlFor={`${identity}-quality`}>
            JPEG quality{" "}
            <output htmlFor={`${identity}-quality`}>
              {capture.quality ?? 70}
            </output>
          </label>
          <input
            id={`${identity}-quality`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={capture.quality ?? 70}
            onChange={(event) =>
              configure(panel.id, {
                capture: { ...capture, quality: Number(event.target.value) },
              })
            }
          />
        </div>
        <div className="demo-field">
          <label htmlFor={`${identity}-resolution`}>
            Capture resolution <span>maximum</span>
          </label>
          <select
            id={`${identity}-resolution`}
            value={
              capture.maxWidth === undefined
                ? "default"
                : `${capture.maxWidth}x${capture.maxHeight}`
            }
            onChange={(event) => {
              if (event.target.value === "default") {
                configure(panel.id, {
                  capture:
                    capture.quality === undefined
                      ? {}
                      : { quality: capture.quality },
                });
                return;
              }
              const resolution = captureResolutions.find(
                (value) =>
                  `${value.width}x${value.height}` === event.target.value,
              );
              if (resolution)
                configure(panel.id, {
                  capture: {
                    ...capture,
                    maxWidth: resolution.width,
                    maxHeight: resolution.height,
                  },
                });
            }}
          >
            <option value="default">Automatic (container and DPR)</option>
            {captureResolutions.map(({ width, height }) => (
              <option key={width} value={`${width}x${height}`}>
                {width} × {height}
              </option>
            ))}
          </select>
        </div>
        <p className="demo-hint">
          Lower settings use less bandwidth and may soften text. Changes apply
          live and keep the remote page size. Quality defaults to 70. Automatic
          resolution follows the preview size and display pixel density.
        </p>
      </div>
    </details>
  );
}

function AppearanceSettings({
  panel,
  identity,
}: {
  panel: Panel;
  identity: string;
}) {
  const model = demoScope.useModel();
  const configure = demoScope.useCommand(model.configure$);
  const { options } = panel;
  return (
    <details className="demo-group">
      <summary>
        <span>
          <Palette size={15} aria-hidden="true" /> Appearance & layout
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="demo-group-content">
        <div className="demo-field">
          <label htmlFor={`${identity}-theme`}>
            Viewer theme <code>colorScheme</code>
          </label>
          <select
            id={`${identity}-theme`}
            value={options.theme}
            onChange={(event) => {
              const theme = event.target.value;
              if (
                theme === "inherit" ||
                theme === "light" ||
                theme === "dark" ||
                theme === "system"
              )
                configure(panel.id, { theme });
            }}
          >
            <option value="inherit">Inherit page</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
        {dimensions.map((field) => (
          <div className="demo-field demo-range" key={field.key}>
            <label htmlFor={`${identity}-${field.key}`}>
              {field.label}
              <output htmlFor={`${identity}-${field.key}`}>
                {options[field.key]}
                {field.unit}
              </output>
            </label>
            <input
              id={`${identity}-${field.key}`}
              type="range"
              aria-label={field.label}
              min={field.min}
              max={field.max}
              step={field.step}
              value={options[field.key]}
              onChange={(event) =>
                configure(panel.id, { [field.key]: Number(event.target.value) })
              }
            />
          </div>
        ))}
        <label className="demo-toggle" htmlFor={`${identity}-settings-menu`}>
          <span>Show settings menu</span>
          <input
            id={`${identity}-settings-menu`}
            type="checkbox"
            checked={options.showSettingsMenu}
            onChange={(event) =>
              configure(panel.id, { showSettingsMenu: event.target.checked })
            }
          />
        </label>
        <div className="demo-field">
          <label htmlFor={`${identity}-window-sync`}>
            Window size sync <code>windowSizeSync</code>
          </label>
          <select
            id={`${identity}-window-sync`}
            value={options.windowSizeSync}
            aria-describedby={`${identity}-window-sync-hint`}
            onChange={(event) => {
              const windowSizeSync = event.target.value;
              if (
                windowSizeSync === "off" ||
                windowSizeSync === "initial" ||
                windowSizeSync === "live"
              )
                configure(panel.id, { windowSizeSync });
            }}
          >
            <option value="off">Do not sync automatically</option>
            <option value="initial">Sync once on opening</option>
            <option value="live">Sync continuously</option>
          </select>
          <p className="demo-hint" id={`${identity}-window-sync-hint`}>
            Fit the remote display to the viewer’s size and pixel density. Off
            keeps the last applied size. Use Fit page to viewer in the browser
            menu to apply it once.
          </p>
        </div>
        <div className="demo-accent-control">
          <label>
            <input
              type="checkbox"
              checked={options.customAccent}
              onChange={(event) =>
                configure(panel.id, { customAccent: event.target.checked })
              }
            />
            Custom accent
          </label>
          <input
            type="color"
            aria-label="Accent color"
            disabled={!options.customAccent}
            value={options.accent}
            onChange={(event) =>
              configure(panel.id, { accent: event.target.value })
            }
          />
        </div>
        <label className="demo-toggle" htmlFor={`${identity}-framed`}>
          <span>
            Framed presentation
            <code>className</code>
          </span>
          <input
            id={`${identity}-framed`}
            type="checkbox"
            checked={options.framed}
            onChange={(event) =>
              configure(panel.id, { framed: event.target.checked })
            }
          />
        </label>
        <p className="demo-hint">
          Size and colors use <code>style</code>; the frame uses demo-defined
          CSS. Remote sizing follows Window size sync.
        </p>
      </div>
    </details>
  );
}
