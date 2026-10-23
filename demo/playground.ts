import type {
  CdpViewerProps,
  CdpViewerStyle,
  ViewerError,
  ViewerSnapshot,
  WindowSizeSync,
} from "cdp-viewer";
import type { Connection } from "./connection";

/** Every public prop needs an intentional control, observation or example. */
export const propGuide = {
  cdpUrl: "Connection bar",
  windowId: "Connection options",
  paused: "Pause / resume",
  interactive: "Control mode",
  windowSizeSync: "Appearance & layout / browser menu",
  onWindowSizeSyncChange: "State & events / controlled Usage",
  extensions: "Connection options",
  colorScheme: "Viewer theme",
  className: "Framed presentation preset",
  style: "Size, radius and accent",
  onStatusChange: "State & events",
  onError: "State & events",
} satisfies Record<keyof CdpViewerProps, string>;

export interface PlaygroundOptions {
  readonly paused: boolean;
  readonly interactive: boolean;
  readonly windowSizeSync: WindowSizeSync;
  readonly theme: "inherit" | NonNullable<CdpViewerProps["colorScheme"]>;
  readonly height: number;
  readonly width: number;
  readonly radius: number;
  readonly customAccent: boolean;
  readonly accent: string;
  readonly framed: boolean;
}

export const sizeLimits = {
  height: { min: 240, max: 800 },
  width: { min: 50, max: 100 },
} as const;

export const defaultOptions = Object.freeze<PlaygroundOptions>({
  paused: false,
  interactive: true,
  windowSizeSync: "off",
  theme: "inherit",
  height: 360,
  width: 100,
  radius: 12,
  customAccent: false,
  accent: "#2563eb",
  framed: false,
});

export function viewerStyle(options: PlaygroundOptions): CdpViewerStyle {
  return {
    height: options.height,
    width: `${options.width}%`,
    "--cdpv-radius": `${options.radius}px`,
    ...(options.customAccent ? { "--cdpv-accent": options.accent } : {}),
  };
}

export function viewerClassName(options: PlaygroundOptions) {
  return options.framed ? "demo-viewer-framed" : "";
}

/** Discard page metadata before retaining a callback observation. */
export function summarizeSnapshot(snapshot: ViewerSnapshot) {
  return {
    status: snapshot.status,
    targetCount: snapshot.targets.length,
    hasSelection: snapshot.selectedTargetId !== null,
    navigationAvailable: snapshot.navigation != null,
    canGoBack: snapshot.navigation?.canGoBack ?? false,
    canGoForward: snapshot.navigation?.canGoForward ?? false,
    errorKind: snapshot.error?.kind ?? null,
  };
}

export type SnapshotSummary = ReturnType<typeof summarizeSnapshot>;
export type CallbackEvent = { readonly sequence: number } & (
  | { readonly name: "onStatusChange"; readonly value: SnapshotSummary }
  | { readonly name: "onError"; readonly value: ViewerError }
  | { readonly name: "onWindowSizeSyncChange"; readonly value: WindowSizeSync }
);
export const callbackLimit = 12;

export function usageCode(
  options: PlaygroundOptions,
  connection: Connection | null,
) {
  const extension = connection?.extensions.some(
    (value) => value.id === "browser-use",
  );
  return [
    'import { useState } from "react";',
    'import { CdpViewer } from "cdp-viewer";',
    'import type { CdpViewerProps, WindowSizeSync } from "cdp-viewer";',
    'import "cdp-viewer/style.css";',
    ...(extension
      ? ['import { browserUse } from "cdp-viewer/extensions/browser-use";']
      : []),
    "",
    "type BrowserPreviewProps = Required<",
    '  Pick<CdpViewerProps, "cdpUrl" | "onStatusChange" | "onError">',
    ">;",
    "",
    "export function BrowserPreview({",
    "  cdpUrl, onStatusChange, onError,",
    "}: BrowserPreviewProps) {",
    `  const [windowSizeSync, setWindowSizeSync] = useState<WindowSizeSync>(${JSON.stringify(options.windowSizeSync)});`,
    "",
    "  return (",
    "    <CdpViewer",
    "      cdpUrl={cdpUrl}",
    ...(connection?.windowId === undefined
      ? []
      : [`      windowId={${connection.windowId}}`]),
    `      paused={${options.paused}}`,
    `      interactive={${options.interactive}}`,
    "      windowSizeSync={windowSizeSync}",
    "      onWindowSizeSyncChange={setWindowSizeSync}",
    `      extensions={${extension ? "[browserUse()]" : "[]"}}`,
    ...(options.theme === "inherit"
      ? []
      : [`      colorScheme=${JSON.stringify(options.theme)}`]),
    `      className={${JSON.stringify(viewerClassName(options))}}`,
    `      style={${JSON.stringify(viewerStyle(options), null, 2).replaceAll("\n", "\n      ")}}`,
    "      onStatusChange={onStatusChange}",
    "      onError={onError}",
    "    />",
    "  );",
    "}",
  ].join("\n");
}
