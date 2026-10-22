import { isRecord } from "../../src/cdp/errors";
import type { InputTransition } from "../../src/input/lifecycle";
import type { SelectionResult } from "../../src/input/selection";
import type { ViewerNavigation } from "../../src/viewer/types";
import { compositionMessageLimit, selectionResult } from "./native-actions";

export type ProbeReply =
  | { type: "ack"; sequence: number; ok: boolean; generation?: string }
  | { type: "revoked" }
  | {
      type: "selection";
      generation: string;
      request: number;
      result: SelectionResult | null;
    }
  | { type: "clipboard-reset"; generation: string; through: number }
  | { type: "navigation"; generation: string; value: ViewerNavigation | null }
  | {
      type: "suspended";
      previous: string;
      generation: string;
      reason: InputTransition;
      document: number;
      focus: number;
    }
  | { type: "ready"; generation: string; document: number; focus: number };

type DecodedReply =
  | { kind: "invalid" }
  | { kind: "ignored"; acknowledgement: boolean }
  | { kind: "reply"; reply: ProbeReply };

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function transition(value: unknown): value is InputTransition {
  return [
    "target-replaced",
    "paused",
    "disconnected",
    "disposed",
    "blur",
    "navigation-started",
    "same-document",
    "document-lost",
    "failed",
  ].some((reason) => reason === value);
}

/** One bounded decoder owns the private reply envelope and its generation rules. */
export function decodeProbeReply(
  raw: unknown,
  context: { generation: string | null; active: boolean },
): DecodedReply {
  let value: unknown;
  try {
    if (typeof raw !== "string" || raw.length > compositionMessageLimit)
      return { kind: "invalid" };
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(value) || typeof value.type !== "string")
    return { kind: "invalid" };
  if (value.type === "revoked")
    return { kind: "reply", reply: { type: "revoked" } };
  const composition = context.generation !== null;
  // Discard old replies before inspecting fields that belong to another owner.
  if (composition) {
    if (
      value.type === "ack" &&
      (!context.active || value.generation !== context.generation)
    )
      return { kind: "ignored", acknowledgement: true };
    if (
      (value.type === "suspended" ? value.previous : value.generation) !==
      context.generation
    )
      return { kind: "ignored", acknowledgement: false };
  }
  if (
    value.type === "ack" &&
    counter(value.sequence) &&
    value.sequence > 0 &&
    typeof value.ok === "boolean" &&
    (!composition || identity(value.generation))
  )
    return {
      kind: "reply",
      reply: {
        type: "ack",
        sequence: value.sequence,
        ok: value.ok,
        ...(typeof value.generation === "string"
          ? { generation: value.generation }
          : {}),
      },
    };
  if (!composition || !identity(value.generation)) return { kind: "invalid" };
  const generation = value.generation;
  if (
    value.type === "suspended" &&
    identity(value.previous) &&
    transition(value.reason) &&
    counter(value.document) &&
    counter(value.focus)
  )
    return {
      kind: "reply",
      reply: {
        type: "suspended",
        previous: value.previous,
        generation,
        reason: value.reason,
        document: value.document,
        focus: value.focus,
      },
    };
  if (value.type === "ready" && counter(value.document) && counter(value.focus))
    return {
      kind: "reply",
      reply: {
        type: "ready",
        generation,
        document: value.document,
        focus: value.focus,
      },
    };
  if (
    value.type === "selection" &&
    counter(value.request) &&
    value.request > 0
  ) {
    const result = value.result === null ? null : selectionResult(value.result);
    if (value.result !== null && !result) return { kind: "invalid" };
    return {
      kind: "reply",
      reply: { type: "selection", generation, request: value.request, result },
    };
  }
  if (value.type === "clipboard-reset" && counter(value.through))
    return {
      kind: "reply",
      reply: { type: "clipboard-reset", generation, through: value.through },
    };
  if (value.type === "navigation") {
    const navigation = value.value;
    if (navigation === null)
      return {
        kind: "reply",
        reply: { type: "navigation", generation, value: null },
      };
    if (
      isRecord(navigation) &&
      typeof navigation.url === "string" &&
      navigation.url.length <= 64 * 1024 &&
      typeof navigation.canGoBack === "boolean" &&
      typeof navigation.canGoForward === "boolean"
    )
      return {
        kind: "reply",
        reply: {
          type: "navigation",
          generation,
          value: {
            url: navigation.url,
            canGoBack: navigation.canGoBack,
            canGoForward: navigation.canGoForward,
          },
        },
      };
  }
  return { kind: "invalid" };
}
