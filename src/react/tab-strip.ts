import type { TabSpace } from "../viewer/tab-layout";

/** The committed toolbar owns its geometry subscription, independently of CDP. */
export function observeTabStrip(
  list: HTMLDivElement,
  resized: (space: TabSpace) => void,
): { refresh: () => void; close: () => void } {
  const row = list.parentElement!;
  let active = true;
  let end: Element | null = null;
  const measure = () => {
    if (!active) return;
    const previousEnd = end;
    end = row.querySelector(".cdpv-toolbar-end");
    if (previousEnd !== end) {
      if (previousEnd) observer.unobserve(previousEnd);
      if (end) observer.observe(end);
    }
    const width = row.getBoundingClientRect().width;
    // A hidden host has no usable geometry; observe it until it becomes visible.
    if (!width) return;
    const style = getComputedStyle(row);
    const tabs = getComputedStyle(list);
    const corner = parseFloat(tabs.paddingRight);
    const gap = parseFloat(style.columnGap);
    const action = parseFloat(style.getPropertyValue("--cdpv-tab-action"));
    const create = row.querySelector(".cdpv-new-tab");
    // Host controls share the row and keep their natural width.
    resized({
      width:
        width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        (create ? create.getBoundingClientRect().width + gap : corner) -
        (end ? end.getBoundingClientRect().width + gap : 0),
      gap: parseFloat(tabs.columnGap),
      overflow: action + gap - (create ? 0 : corner),
    });
  };
  const observer = new ResizeObserver(measure);
  observer.observe(row);
  measure();
  return {
    refresh: measure,
    close: () => {
      active = false;
      observer.disconnect();
    },
  };
}
