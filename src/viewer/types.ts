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
  /** Original failed request, when known. Never includes parameters or session IDs. */
  readonly request?: {
    readonly method: string;
    readonly code?: number;
  };
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

export interface ViewerCaptureOptions {
  /** JPEG compression quality, integer 0..100. Default: 70. */
  readonly quality?: number;
  /** Maximum image width, integer 1..4096. Omit for the current capture profile. */
  readonly maxWidth?: number;
  /** Maximum image height, integer 1..4096. Omit for the current capture profile. */
  readonly maxHeight?: number;
}

export interface CdpViewerProps {
  /** Resolved browser-level ws:// or wss:// debugger URL. */
  readonly cdpUrl: string;
  /** Omit to discover all page targets. Filtering is UI scope, not an ACL. */
  readonly windowId?: number;
  readonly paused?: boolean;
  /** Enable remote input, navigation and tab creation/closure. Default: false. */
  readonly interactive?: boolean;
  /** Show the interactive toolbar's settings menu. Default: true; sync mode is unchanged. */
  readonly showSettingsMenu?: boolean;
  /** Opt-in separate frame socket in interactive mode. Default: shared. Changes reconnect. */
  readonly transport?: "shared" | "split";
  /** Controlled size/DPR adaptation. Omit for menu-owned mode, initially off. */
  readonly windowSizeSync?: WindowSizeSync;
  /** Requests a controlled update, or reports a menu-owned mode change. */
  readonly onWindowSizeSyncChange?: (mode: WindowSizeSync) => void;
  /** Live image-detail settings; independent of the remote page's viewport. */
  readonly capture?: ViewerCaptureOptions;
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
