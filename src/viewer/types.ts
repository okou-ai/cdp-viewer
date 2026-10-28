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

export type ViewerCaptureFormat = "webp" | "jpeg";

/** All capture bounds share a 3840×2160 total-pixel limit. */
export interface ViewerCaptureOptions {
  /** Image compression format. Default: "webp". Endpoint support is required. */
  readonly format?: ViewerCaptureFormat;
  /** Image compression quality, integer 0..100. Default: 70. */
  readonly quality?: number;
  /** Fixed maximum image width, integer 1..4096. Omit to follow container/DPR. */
  readonly maxWidth?: number;
  /** Fixed maximum image height, integer 1..4096. Omit to follow container/DPR. */
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
  /** Controlled transport. Omit for menu-owned shared mode. Changes reconnect. */
  readonly transport?: ViewerTransport;
  /** Requests a controlled transport change, or reports a menu-owned change. */
  readonly onTransportChange?: (transport: ViewerTransport) => void;
  /** Controlled size/DPR adaptation. Omit for menu-owned mode, initially off. */
  readonly windowSizeSync?: WindowSizeSync;
  /** Requests a controlled update, or reports a menu-owned mode change. */
  readonly onWindowSizeSyncChange?: (mode: WindowSizeSync) => void;
  /** Controlled capture quality. Omit for menu-owned settings; independent of page size. */
  readonly capture?: ViewerCaptureOptions;
  /** Requests a controlled capture-quality change, or reports a menu-owned change. */
  readonly onCaptureChange?: (capture: ViewerCaptureOptions) => void;
  /** Optional adapters, reconciled by ID and key independently of transport. */
  readonly extensions?: readonly ViewerExtension[];
  /** Omit to inherit the host's CSS color-scheme. System follows OS preference. */
  readonly colorScheme?: "light" | "dark" | "system";
  readonly className?: string;
  readonly style?: CdpViewerStyle;
  readonly onStatusChange?: (snapshot: ViewerSnapshot) => void;
  readonly onError?: (error: ViewerError) => void;
}

export type ViewerTransport = "shared" | "split";

export type WindowSizeSync = "off" | "initial" | "live";

export interface CdpViewerStyle extends CSSProperties {
  [variable: `--cdpv-${string}`]: string | number | undefined;
}
