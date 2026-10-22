import { browserUse } from "cdp-viewer/extensions/browser-use";
import {
  Activity,
  ChevronDown,
  Code2,
  Palette,
  SlidersHorizontal,
} from "lucide-react";
import { demoScope } from "./context";
import type { Panel } from "./model";
import { propGuide, sizeLimits, usageCode } from "./playground";

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
      <CallbackInspector panel={panel} />
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
          CSS. Neither changes the remote viewport.
        </p>
      </div>
    </details>
  );
}

function CallbackInspector({ panel }: { panel: Panel }) {
  const model = demoScope.useModel();
  const clear = demoScope.useCommand(model.clearActivity$);
  return (
    <details className="demo-group">
      <summary>
        <span>
          <Activity size={15} aria-hidden="true" /> State & events{" "}
          <span className="demo-count">{panel.activity.length}</span>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="demo-group-content">
        <p className="demo-hint">
          <code>onStatusChange</code> and <code>onError</code>, live. Page
          titles, target IDs and addresses are omitted.
        </p>
        <pre className="demo-snapshot" aria-label="Current status summary">
          {panel.snapshot
            ? JSON.stringify(panel.snapshot, null, 2)
            : "Waiting for a connection…"}
        </pre>
        <div className="demo-activity-heading">
          <strong>Recent activity</strong>
          <button
            type="button"
            className="demo-text-button"
            aria-label="Clear callback activity"
            disabled={!panel.activity.length}
            onClick={() => clear(panel.id)}
          >
            Clear
          </button>
        </div>
        {panel.activity.length ? (
          <ol className="demo-activity" aria-label="Callback activity">
            {[...panel.activity].reverse().map((event) => (
              <li key={event.sequence}>
                <div>
                  <code>{event.name}</code>
                  <span>#{event.sequence}</span>
                </div>
                <p>
                  {event.name === "onStatusChange"
                    ? `${event.value.status} · ${event.value.targetCount} tabs`
                    : `${event.value.kind}: ${event.value.message}`}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="demo-hint">Callbacks appear here after you connect.</p>
        )}
      </div>
    </details>
  );
}
