import type { CdpEvent } from "../cdp/client";
import type {
  ExtensionCleanup,
  ExtensionContext,
  ExtensionEvent,
  ExtensionState,
  ViewerExtension,
} from "./types";

interface ExtensionHost {
  readonly signal: AbortSignal;
  readonly subscribe: (listener: (event: CdpEvent) => void) => () => void;
  readonly getState: () => ExtensionState;
  readonly requestTargetSelection: (
    targetId: string,
    current: () => boolean,
  ) => Promise<boolean>;
  readonly reportError: (message: string) => void;
}

function cleanupFailed(host: ExtensionHost): void {
  if (!host.signal.aborted)
    host.reportError("An extension could not be cleaned up.");
}

/** One accepted descriptor owns setup, subscriptions and eventual cleanup. */
class Registration {
  private readonly lifetime = new AbortController();
  private readonly subscriptions = new Set<() => void>();
  private readonly initialized: Promise<void>;
  private cleanup: ExtensionCleanup | void = undefined;
  private retirement: Promise<void> | null = null;

  constructor(
    readonly descriptor: ViewerExtension,
    private readonly host: ExtensionHost,
    predecessor: Promise<void>,
  ) {
    const signal = AbortSignal.any([host.signal, this.lifetime.signal]);
    const stopped: ExtensionState = Object.freeze({
      status: "disconnected",
      selectedTargetId: null,
      capabilities: host.getState().capabilities,
    });
    const context = Object.freeze<ExtensionContext>({
      signal,
      subscribe: (method, listener) => this.subscribe(method, listener),
      getState: () => (this.current() ? host.getState() : stopped),
      requestTargetSelection: (targetId) =>
        this.current()
          ? host.requestTargetSelection(targetId, () => this.current())
          : Promise.resolve(false),
    });
    this.initialized = predecessor.then(async () => {
      if (!this.current()) return;
      try {
        const cleanup = await descriptor.setup(context);
        if (cleanup !== undefined && typeof cleanup !== "function")
          throw new Error("Invalid extension cleanup.");
        this.cleanup = cleanup;
      } catch {
        this.fault("An extension could not be initialized.");
      }
    });
  }

  close(): Promise<void> {
    if (this.retirement) return this.retirement;
    // Invalidate authority before user abort handlers or cleanup can run.
    this.lifetime.abort();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.clear();
    this.retirement = this.initialized.then(async () => {
      const cleanup = this.cleanup;
      this.cleanup = undefined;
      try {
        await cleanup?.();
      } catch {
        cleanupFailed(this.host);
      }
    });
    return this.retirement;
  }

  private current(): boolean {
    return !this.lifetime.signal.aborted && !this.host.signal.aborted;
  }

  private fault(message: string): void {
    if (!this.current()) return;
    this.close().catch(() => cleanupFailed(this.host));
    this.host.reportError(message);
  }

  private subscribe(
    method: string,
    listener: (event: ExtensionEvent) => void | Promise<void>,
  ): () => void {
    if (!this.current()) return () => {};
    if (!method.trim()) throw new Error("Invalid extension event name.");
    const unsubscribe = this.host.subscribe((event) => {
      if (!this.current() || event.method !== method) return;
      const message: ExtensionEvent = Object.freeze({
        ...event,
        params: Object.freeze({ ...event.params }),
      });
      try {
        Promise.resolve(listener(message)).catch(() => {
          this.fault("An extension event handler failed.");
        });
      } catch {
        this.fault("An extension event handler failed.");
      }
    });
    const release = () => {
      if (!this.subscriptions.delete(release)) return;
      unsubscribe();
    };
    this.subscriptions.add(release);
    return release;
  }
}

/** Per-connection reconciliation; neither descriptor objects nor IDs are global. */
export class ExtensionRuntime {
  private readonly registrations = new Map<string, Registration>();
  private readonly retiring = new Map<string, Promise<void>>();
  private configurationError: string | null = null;
  private closed = false;

  constructor(private readonly host: ExtensionHost) {
    host.signal.addEventListener("abort", this.close, { once: true });
    if (host.signal.aborted) this.close();
  }

  reconcile(descriptors: readonly ViewerExtension[]): void {
    if (this.closed) return;
    const next = new Map<string, ViewerExtension>();
    for (const descriptor of descriptors) {
      if (
        !descriptor ||
        typeof descriptor.id !== "string" ||
        !descriptor.id.trim() ||
        (descriptor.key !== undefined && typeof descriptor.key !== "string") ||
        typeof descriptor.setup !== "function"
      ) {
        this.invalid("Extension descriptors require a nonempty ID and setup.");
        return;
      }
      if (next.has(descriptor.id)) {
        this.invalid("Extension IDs must be unique within a viewer.");
        return;
      }
      next.set(descriptor.id, Object.freeze({ ...descriptor }));
    }
    this.configurationError = null;
    for (const [id, registration] of this.registrations) {
      const replacement = next.get(id);
      if (!replacement || replacement.key !== registration.descriptor.key) {
        this.registrations.delete(id);
        const retired = registration.close();
        this.retiring.set(id, retired);
        retired
          .then(() => {
            if (this.retiring.get(id) === retired) this.retiring.delete(id);
          })
          .catch(() => cleanupFailed(this.host));
      }
    }
    for (const [id, descriptor] of next) {
      if (this.registrations.has(id)) continue;
      this.registrations.set(
        id,
        new Registration(
          descriptor,
          this.host,
          this.retiring.get(id) ?? Promise.resolve(),
        ),
      );
    }
  }

  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.host.signal.removeEventListener("abort", this.close);
    for (const registration of this.registrations.values())
      registration.close().catch(() => cleanupFailed(this.host));
    this.registrations.clear();
    this.retiring.clear();
  };

  private invalid(message: string): void {
    if (this.configurationError === message) return;
    this.configurationError = message;
    this.host.reportError(message);
  }
}
