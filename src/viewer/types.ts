import type { CSSProperties } from "react";
import type { ViewerExtension } from "../extensions/types";

export type ViewerStatus =
  | "connecting"
  | "streaming"
  | "paused"
  | "unavailable"
  | "disconnected"
  | "error";

export interface ViewerError {
  readonly kind:
    | "configuration"
    | "connection"
    | "protocol"
    | "scope"
    | "unsupported-capability"
    | "target-unavailable"
    | "input"
    | "display"
    | "extension"
    | "tab"
    | "frame";
  /** A fixed diagnostic, excluding endpoint credentials and provider payloads. */
  readonly message: string;
}

export interface ViewerTarget {
  readonly id: string;
  readonly title: string;
}

export interface ViewerSnapshot {
  readonly status: ViewerStatus;
  readonly targets: readonly ViewerTarget[];
  readonly selectedTargetId: string | null;
  readonly error: ViewerError | null;
  readonly navigation?: ViewerNavigation | null;
}

export interface ViewerNavigation {
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface CdpViewerProps {
  /** Resolved browser-level ws:// or wss:// debugger URL. */
  readonly cdpUrl: string;
  /** Omit to discover all page targets. Filtering is UI scope, not an ACL. */
  readonly windowId?: number;
  readonly paused?: boolean;
  /** Enable remote input, navigation and tab creation/closure. Default: false. */
  readonly interactive?: boolean;
  /** Controlled automatic size/DPR adaptation. Omit for menu-owned mode. */
  readonly windowSizeSync?: WindowSizeSync;
  /** Initial menu-owned mode; defaults to off. */
  readonly defaultWindowSizeSync?: WindowSizeSync;
  readonly onWindowSizeSyncChange?: (mode: WindowSizeSync) => void;
  /** Optional adapters, reconciled by ID and key independently of transport. */
  readonly extensions?: readonly ViewerExtension[];
  /** Omit to inherit the host's CSS color-scheme. System follows OS preference. */
  readonly colorScheme?: "light" | "dark" | "system";
  readonly className?: string;
  readonly style?: CdpViewerStyle;
  readonly onStatusChange?: (snapshot: ViewerSnapshot) => void;
  readonly onError?: (error: ViewerError) => void;
}

export type WindowSizeSync = "off" | "initial" | "live";

export interface CdpViewerStyle extends CSSProperties {
  [variable: `--cdpv-${string}`]: string | number | undefined;
}
