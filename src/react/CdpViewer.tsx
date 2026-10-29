import { Tabs } from "@base-ui/react/tabs";
import type { CdpViewerProps } from "../viewer/types";
import { viewerScope } from "./context";
import { ViewerRuntime } from "./runtime";
import { ViewerToolbar, NavigationToolbar } from "./ViewerChrome";
import { RemoteSurface } from "./RemoteSurface";
import {
  StageStatus,
  ClipboardRecovery,
  ViewerAnnouncements,
} from "./ViewerStatus";

export function CdpViewer(props: CdpViewerProps) {
  return (
    <viewerScope.Provider>
      <ViewerRuntime {...props}>
        <ViewerFrame {...props} />
      </ViewerRuntime>
    </viewerScope.Provider>
  );
}

/** Layout places host content beside private viewer UI, never inside its defaults or input surface. */
function ViewerFrame({
  interactive = false,
  showSettingsMenu = true,
  colorScheme,
  tabStyle = "attached",
  toolbarEnd,
  stageOverlay,
  blankPage,
  labels,
  className,
  style,
}: CdpViewerProps) {
  const model = viewerScope.useModel();
  const snapshot = viewerScope.useValue(model.snapshot$);
  const controls = viewerScope.useValue(model.controls$);
  const select = viewerScope.useCommand(model.select$);
  return (
    <Tabs.Root
      render={<section />}
      aria-label="Remote browser viewer"
      className={`cdpv-root cdpv:flex cdpv:flex-col ${className ?? ""}`}
      style={style}
      data-status={snapshot.status}
      data-color-scheme={colorScheme}
      data-tab-style={tabStyle}
      value={snapshot.selectedTargetId}
      onValueChange={(value) => {
        if (typeof value === "string") select(value);
      }}
    >
      <div className="cdpv-toolbar">
        <ViewerToolbar interactive={interactive} labels={labels} />
        {toolbarEnd !== undefined && (
          <div className="cdpv-toolbar-end">{toolbarEnd}</div>
        )}
      </div>
      {interactive && (
        <NavigationToolbar
          showSettingsMenu={showSettingsMenu}
          placeholder={labels?.addressPlaceholder ?? "Enter a URL"}
        />
      )}
      <Tabs.Panel
        tabIndex={-1}
        keepMounted
        value={snapshot.selectedTargetId}
        className="cdpv-stage"
        data-loading-preview={controls.loadingPreview ? "" : undefined}
        aria-busy={snapshot.status === "connecting"}
      >
        <RemoteSurface interactive={interactive} />
        <StageStatus />
        {interactive &&
          blankPage !== undefined &&
          controls.streaming &&
          snapshot.navigation?.url === "about:blank" && (
            <div className="cdpv-blank-page">{blankPage}</div>
          )}
        {stageOverlay !== undefined && (
          <div className="cdpv-stage-overlay">{stageOverlay}</div>
        )}
      </Tabs.Panel>
      {interactive && <ClipboardRecovery />}
      <ViewerAnnouncements interactive={interactive} />
    </Tabs.Root>
  );
}
