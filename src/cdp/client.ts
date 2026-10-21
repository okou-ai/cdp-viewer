import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { timeout } from "signal-timers";
import { CdpFault, isRecord } from "./errors";

type Method = keyof ProtocolMapping.Commands;
type Params<M extends Method> = ProtocolMapping.Commands[M]["paramsType"][0];
type Result<M extends Method> = ProtocolMapping.Commands[M]["returnType"];

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: CdpFault) => void;
  deadline: AbortController;
  settled: boolean;
  late?: (result: unknown) => void | Promise<void>;
}

export type SocketFactory = (url: string) => WebSocket;

/** One socket owns its request IDs, timeouts, listeners and attached sessions. */
export class CdpClient {
  readonly opened: Promise<void>;
  private readonly socket: WebSocket;
  private readonly lifetime = new AbortController();
  private readonly openingDeadline = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<(error: CdpFault) => void>();
  private resolveOpen!: () => void;
  private rejectOpen!: (error: CdpFault) => void;
  private nextId = 1;
  private ended = false;

  constructor(
    url: string,
    factory: SocketFactory = (endpoint) => new WebSocket(endpoint),
    private readonly requestTimeout = 10_000,
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    try {
      this.socket = factory(url);
    } catch {
      throw new CdpFault("connection", "The WebSocket could not be created.");
    }
    this.socket.addEventListener("open", this.onOpen);
    this.socket.addEventListener("message", this.onMessage);
    this.socket.addEventListener("error", this.onError);
    this.socket.addEventListener("close", this.onClose);
    timeout(
      () => this.close(new CdpFault("connection", "The connection timed out.")),
      requestTimeout,
      {
        signal: AbortSignal.any([
          this.lifetime.signal,
          this.openingDeadline.signal,
        ]),
      },
    );
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnected(listener: (error: CdpFault) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
    late?: (result: unknown) => void | Promise<void>,
  ): Promise<Result<M>> {
    if (this.ended || this.socket.readyState !== 1) {
      return Promise.reject(
        new CdpFault("connection", "The connection is closed."),
      );
    }
    // Expired attachment requests with a late-result owner count toward this cap.
    if (this.pending.size >= 256) {
      const error = new CdpFault(
        "protocol",
        "Too many pending browser requests.",
      );
      this.close(error);
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const entry: Pending = {
        resolve: (result) => resolve(result as Result<M>),
        reject,
        deadline: new AbortController(),
        settled: false,
        ...(late ? { late } : {}),
      };
      this.pending.set(id, entry);
      timeout(
        () => {
          entry.settled = true;
          entry.deadline.abort();
          if (!entry.late) this.pending.delete(id);
          reject(new CdpFault("protocol", "The browser request timed out."));
        },
        this.requestTimeout,
        {
          signal: AbortSignal.any([
            this.lifetime.signal,
            entry.deadline.signal,
          ]),
        },
      );
      if (!this.send({ id, method, params, sessionId })) {
        this.pending.delete(id);
        entry.deadline.abort();
        reject(new CdpFault("connection", "The connection is closed."));
      }
    });
  }

  /** Acks/cleanup need IDs, but do not need an accumulating response promise. */
  notify<M extends Method>(
    method: M,
    params: Params<M>,
    sessionId?: string,
  ): void {
    this.send({ id: this.nextId++, method, params, sessionId });
  }

  close(error = new CdpFault("connection", "The connection is closed.")): void {
    if (this.ended) return;
    this.ended = true;
    this.lifetime.abort();
    this.openingDeadline.abort();
    this.rejectOpen(error);
    for (const request of this.pending.values()) {
      request.deadline.abort();
      if (!request.settled) request.reject(error);
    }
    this.pending.clear();
    this.socket.removeEventListener("open", this.onOpen);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("error", this.onError);
    this.socket.removeEventListener("close", this.onClose);
    try {
      this.socket.close();
    } catch {
      // A failed/closed socket already releases the connection's CDP sessions.
    }
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.listeners.clear();
  }

  private readonly onOpen = () => {
    this.openingDeadline.abort();
    this.resolveOpen();
  };

  private readonly onError = () => {
    this.close(
      new CdpFault(
        "connection",
        "WebSocket connection failed. Check endpoint access, Origin and TLS policy.",
      ),
    );
  };

  private readonly onClose = () => {
    this.close(new CdpFault("connection", "The browser disconnected."));
  };

  private send(message: object): boolean {
    if (this.ended || this.socket.readyState !== 1) return false;
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      this.close(
        new CdpFault("connection", "The browser connection is not draining."),
      );
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.onError();
      return false;
    }
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (
      typeof event.data !== "string" ||
      event.data.length > 16 * 1024 * 1024
    ) {
      this.close(new CdpFault("protocol", "Invalid or oversized CDP message."));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      this.close(new CdpFault("protocol", "Invalid CDP JSON message."));
      return;
    }
    if (!isRecord(value)) {
      this.close(new CdpFault("protocol", "Invalid CDP envelope."));
      return;
    }
    if (typeof value.id === "number") {
      const entry = this.pending.get(value.id);
      if (!entry) return;
      this.pending.delete(value.id);
      entry.deadline.abort();
      if (isRecord(value.error)) {
        if (!entry.settled) {
          entry.reject(
            new CdpFault(
              "protocol",
              "CDP request failed.",
              typeof value.error.code === "number"
                ? value.error.code
                : undefined,
            ),
          );
        }
      } else if (entry.settled) {
        if (entry.late) {
          Promise.resolve()
            .then(() => entry.late?.(value.result))
            .catch(() => {
              this.close(
                new CdpFault(
                  "protocol",
                  "A late browser session could not be released.",
                ),
              );
            });
        }
      } else {
        entry.resolve(value.result);
      }
    } else if (typeof value.method === "string" && isRecord(value.params)) {
      const message: CdpEvent = {
        method: value.method,
        params: value.params,
        ...(typeof value.sessionId === "string"
          ? { sessionId: value.sessionId }
          : {}),
      };
      for (const listener of this.listeners) listener(message);
    }
  };
}
