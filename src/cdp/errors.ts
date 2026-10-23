import type { ViewerError } from "../viewer/types";

export class CdpFault extends Error {
  constructor(
    readonly kind: ViewerError["kind"],
    message: string,
    readonly code?: number,
    readonly request?: ViewerError["request"],
  ) {
    super(message);
    this.name = "CdpFault";
  }
}

export function diagnostic(error: unknown): ViewerError {
  if (error instanceof CdpFault) {
    return Object.freeze({
      kind: error.code === -32601 ? "unsupported-capability" : error.kind,
      message:
        error.code === -32601
          ? "The browser does not support a required CDP viewer command."
          : error.message,
      ...(error.request ? { request: error.request } : {}),
    });
  }
  return Object.freeze({
    kind: "protocol",
    message: "The browser operation could not be completed.",
  });
}

/** Preserve diagnostic context without changing a wrapper's control-flow code. */
export function requestDetails(error: unknown): ViewerError["request"] {
  return error instanceof CdpFault ? error.request : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfiguration(url: string, windowId?: number): void {
  try {
    const parsed = new URL(url);
    if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error();
    }
  } catch {
    throw new CdpFault(
      "configuration",
      "cdpUrl must be an absolute ws:// or wss:// browser debugger URL.",
    );
  }
  if (windowId !== undefined && !Number.isSafeInteger(windowId)) {
    throw new CdpFault("configuration", "windowId must be an integer.");
  }
}
