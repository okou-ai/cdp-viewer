import type { CdpViewerProps } from "cdp-viewer";

export type Connection = Pick<CdpViewerProps, "cdpUrl" | "windowId"> & {
  generation: number;
};
export type ConnectionError = "endpoint" | "window";

/** Pure parsing boundary: invalid drafts never replace an applied connection. */
export function parseConnection(
  endpoint: string,
  windowDraft: string,
):
  | { value: Pick<CdpViewerProps, "cdpUrl" | "windowId"> }
  | { error: ConnectionError } {
  const cdpUrl = endpoint.trim();
  try {
    const url = new URL(cdpUrl);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes("#")
    )
      return { error: "endpoint" };
  } catch {
    return { error: "endpoint" };
  }
  const value = windowDraft.trim();
  const windowId = value === "" ? undefined : Number(value);
  if (
    value !== "" &&
    (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(windowId))
  )
    return { error: "window" };
  return { value: { cdpUrl, ...(windowId === undefined ? {} : { windowId }) } };
}
