import type { InputSession } from "./session";

/** DOM adaptation needs these capabilities, not the session's protocol internals. */
export type NativeInputPort = Pick<
  InputSession,
  | "owner"
  | "focus"
  | "blur"
  | "pointer"
  | "key"
  | "text"
  | "preedit"
  | "commitComposition"
  | "selection"
  | "clipboardError"
>;
