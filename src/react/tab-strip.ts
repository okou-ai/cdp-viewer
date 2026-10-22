import type { TabSpace } from "../viewer/tab-layout";

/** The committed toolbar owns its geometry subscription, independently of CDP. */
export function observeTabStrip(
  list: HTMLDivElement,
  resized: (space: TabSpace) => void,
): () => void {
  const row = list.parentElement!;
  let active = true;
  const measure = () => {
    if (!active) return;
    const width = row.getBoundingClientRect().width;
    // A hidden host has no usable geometry; observe it until it becomes visible.
    if (!width) return;
    const style = getComputedStyle(row);
    const tabs = getComputedStyle(list);
    const corner = parseFloat(tabs.paddingRight);
    const gap = parseFloat(style.columnGap);
    const action = parseFloat(style.getPropertyValue("--cdpv-tab-action"));
    const create = row.querySelector(".cdpv-new-tab");
    resized({
      width:
        width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        (create ? create.getBoundingClientRect().width + gap : corner),
      gap: parseFloat(tabs.columnGap),
      overflow: action + gap - (create ? 0 : corner),
    });
  };
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  observer?.observe(row);
  if (!observer) window.addEventListener("resize", measure);
  measure();
  return () => {
    active = false;
    observer?.disconnect();
    if (!observer) window.removeEventListener("resize", measure);
  };
}
