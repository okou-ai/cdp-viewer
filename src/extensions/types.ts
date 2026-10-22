import type { ViewerStatus } from "../viewer/types";

export interface ExtensionEvent {
  readonly method: string;
  /** Untrusted provider data; validate before using it. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface ExtensionState {
  readonly status: ViewerStatus;
  readonly selectedTargetId: string | null;
  /** Configured viewer features, not a claim about vendor support. */
  readonly capabilities: {
    readonly windowScoped: boolean;
    readonly interactive: boolean;
  };
}

export type ExtensionCleanup = () => void | Promise<void>;

export interface ExtensionContext {
  /** Aborted on removal, replacement, disconnect or unmount. */
  readonly signal: AbortSignal;
  readonly subscribe: (
    method: string,
    listener: (event: ExtensionEvent) => void | Promise<void>,
  ) => () => void;
  /** Excludes endpoint, page content/addresses/titles and raw errors. */
  readonly getState: () => ExtensionState;
  /** False for ignored, obsolete, unavailable or already-selected targets. */
  readonly requestTargetSelection: (targetId: string) => Promise<boolean>;
}

export interface ViewerExtension {
  /** Unique within one viewer. */
  readonly id: string;
  /** Change this when captured configuration needs a new setup lifetime. */
  readonly key?: string;
  /** Called per viewer/connection/configuration, even for a shared descriptor. */
  readonly setup: (
    context: ExtensionContext,
  ) => void | ExtensionCleanup | Promise<void | ExtensionCleanup>;
}
