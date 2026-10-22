import { expect, it } from "vitest";
import { decodeProbeReply } from "../experiments/probe-replies";
import { compositionMessageLimit } from "../experiments/native-actions";

const current = { generation: "current", active: true };

it.each([
  { type: "ack", generation: "current", sequence: 1, ok: true },
  { type: "ack", generation: "current", sequence: 1, ok: false },
  { type: "ready", generation: "current", document: 0, focus: 1 },
  {
    type: "suspended",
    previous: "current",
    generation: "next",
    reason: "document-lost",
    document: 1,
    focus: 2,
  },
  {
    type: "selection",
    generation: "current",
    request: 1,
    result: { status: "ok", text: "owned fixture" },
  },
  { type: "selection", generation: "current", request: 1, result: null },
  { type: "clipboard-reset", generation: "current", through: 0 },
  { type: "navigation", generation: "current", value: null },
  {
    type: "navigation",
    generation: "current",
    value: { url: "about:blank", canGoBack: true, canGoForward: false },
  },
  { type: "revoked" },
])("decodes a complete closed reply: $type", (reply) => {
  expect(decodeProbeReply(JSON.stringify(reply), current)).toEqual({
    kind: "reply",
    reply,
  });
});

it.each([
  { type: "ack", sequence: 1 },
  { type: "ack", sequence: 1, ok: "true" },
  { type: "ack", sequence: 0, ok: true },
  { type: "ready", document: -1, focus: 0 },
  { type: "ready", document: 0, focus: "1" },
  { type: "ready", document: Number.MAX_SAFE_INTEGER + 1, focus: 0 },
  {
    type: "suspended",
    previous: "current",
    reason: "unknown",
    document: 0,
    focus: 1,
  },
  { type: "selection", request: 0, result: null },
  {
    type: "selection",
    request: 1,
    result: { status: "unsupported", text: "unexpected private data" },
  },
  {
    type: "selection",
    request: 1,
    result: { status: "ok", text: "x".repeat(64 * 1024 + 1) },
  },
  { type: "clipboard-reset", through: -1 },
  { type: "navigation", value: { url: "about:blank", canGoBack: true } },
  { type: "unknown" },
])("rejects malformed current reply $type before dispatch", (reply) => {
  expect(
    decodeProbeReply(
      JSON.stringify({ generation: "current", ...reply }),
      current,
    ),
  ).toEqual({ kind: "invalid" });
});

it("discards stale acknowledgements before their missing fields can revoke a replacement", () => {
  const stale = JSON.stringify({ type: "ack", generation: "old" });
  expect(decodeProbeReply(stale, current)).toEqual({
    kind: "ignored",
    acknowledgement: true,
  });
  expect(
    decodeProbeReply(JSON.stringify({ type: "ack", generation: "current" }), {
      ...current,
      active: false,
    }),
  ).toEqual({ kind: "ignored", acknowledgement: true });
  expect(
    decodeProbeReply(
      JSON.stringify({ type: "ack", generation: "current" }),
      current,
    ),
  ).toEqual({ kind: "invalid" });
});

it("bounds the wire and preserves the unversioned comparator's valid acknowledgements", () => {
  for (const raw of [
    "not JSON",
    "null",
    "[]",
    "x".repeat(compositionMessageLimit + 1),
  ])
    expect(decodeProbeReply(raw, current)).toEqual({ kind: "invalid" });
  const reply = { type: "ack", sequence: 1, ok: true };
  expect(
    decodeProbeReply(JSON.stringify(reply), { generation: null, active: true }),
  ).toEqual({ kind: "reply", reply });
});
