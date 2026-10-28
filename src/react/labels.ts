import type { ViewerLabels } from "../viewer/types";

/** Chromium titles a blank page with its URL; show the host's name for it instead. */
export function tabTitle(title: string, labels: ViewerLabels | undefined) {
  return title === "" || title === "about:blank"
    ? (labels?.blankTabTitle ?? "New tab")
    : title;
}
