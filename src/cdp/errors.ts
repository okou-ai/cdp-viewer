import type { ViewerError } from "../viewer/types";

export class CdpFault extends Error {
  constructor(
    readonly kind: ViewerError["kind"],
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "CdpFault";
  }
}

export function diagnostic(error: unknown): ViewerError {
  if (error instanceof CdpFault) {
    if (error.code === -32601) {
      return Object.freeze({
        kind: "unsupported-capability",
        message: "The browser does not support a required CDP viewer command.",
      });
    }
    return Object.freeze({ kind: error.kind, message: error.message });
  }
  return Object.freeze({
    kind: "protocol",
    message: "The browser operation could not be completed.",
  });
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
