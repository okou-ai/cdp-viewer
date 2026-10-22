import type {
  CdpViewerProps,
  CdpViewerStyle,
  ViewerError,
  ViewerSnapshot,
} from "cdp-viewer";
import type { Connection } from "./connection";

/** Every public prop needs an intentional control, observation or example. */
export const propGuide = {
  cdpUrl: "Connection bar",
  windowId: "Connection options",
  paused: "Pause / resume",
  interactive: "Control mode",
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
  readonly theme: "inherit" | NonNullable<CdpViewerProps["colorScheme"]>;
  readonly height: number;
  readonly width: number;
  readonly radius: number;
  readonly customAccent: boolean;
  readonly accent: string;
  readonly framed: boolean;
}

export const defaultOptions = Object.freeze<PlaygroundOptions>({
  paused: false,
  interactive: true,
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
    'import { CdpViewer } from "cdp-viewer";',
    'import "cdp-viewer/style.css";',
    ...(extension
      ? ['import { browserUse } from "cdp-viewer/extensions/browser-use";']
      : []),
    "",
    "// Supply cdpUrl and callback handlers from your application.",
    "<CdpViewer",
    "  cdpUrl={cdpUrl}",
    ...(connection?.windowId === undefined
      ? []
      : [`  windowId={${connection.windowId}}`]),
    `  paused={${options.paused}}`,
    `  interactive={${options.interactive}}`,
    `  extensions={${extension ? "[browserUse()]" : "[]"}}`,
    ...(options.theme === "inherit"
      ? []
      : [`  colorScheme=${JSON.stringify(options.theme)}`]),
    `  className={${JSON.stringify(viewerClassName(options))}}`,
    `  style={${JSON.stringify(viewerStyle(options), null, 2).replaceAll("\n", "\n  ")}}`,
    "  onStatusChange={handleStatusChange}",
    "  onError={handleError}",
    "/>",
  ].join("\n");
}
