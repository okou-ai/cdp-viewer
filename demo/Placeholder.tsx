import {
  ArrowLeft,
  ArrowRight,
  EllipsisVertical,
  Globe,
  Monitor,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import type { PlaygroundOptions } from "./playground";
import { viewerClassName, viewerStyle } from "./playground";

/** Match the viewer's chrome without mounting its connection-owning runtime. */
export function Placeholder({ options }: { options: PlaygroundOptions }) {
  return (
    <div
      className={`cdpv-root demo-disconnected ${viewerClassName(options)}`}
      style={viewerStyle(options)}
      data-color-scheme={
        options.theme === "inherit" ? undefined : options.theme
      }
    >
      <div className="cdpv-toolbar demo-placeholder-chrome" aria-hidden="true">
        <div className="cdpv-tabs">
          <div className="cdpv-tab-item" data-selected="">
            <span className="cdpv-tab">
              <Globe size={16} />
              <span className="cdpv-tab-title">New tab</span>
            </span>
            {options.interactive && (
              <span className="cdpv-close">
                <X size={14} />
              </span>
            )}
          </div>
        </div>
        {options.interactive && (
          <span className="cdpv-button cdpv-new-tab">
            <Plus size={18} />
          </span>
        )}
      </div>
      {options.interactive && (
        <div
          className="cdpv-navigation demo-placeholder-navigation"
          aria-hidden="true"
        >
          <span className="cdpv-button demo-placeholder-disabled">
            <ArrowLeft size={16} />
          </span>
          <span className="cdpv-button demo-placeholder-disabled">
            <ArrowRight size={16} />
          </span>
          <span className="cdpv-button">
            <RotateCw size={16} />
          </span>
          <span className="cdpv-address">Enter a URL</span>
          {options.showSettingsMenu && (
            <span className="cdpv-button cdpv-browser-menu-trigger">
              <EllipsisVertical size={16} />
            </span>
          )}
        </div>
      )}
      <div className="cdpv-stage">
        <div className="cdpv-placeholder demo-placeholder-content">
          <Monitor size={28} strokeWidth={1.5} aria-hidden="true" />
          <strong>Ready when you are.</strong>
          <p>Connect your browser above to start exploring.</p>
        </div>
      </div>
    </div>
  );
}
