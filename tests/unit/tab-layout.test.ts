import { expect, it } from "vitest";
import { createViewerModel } from "../../src/viewer/model";
import { layoutTabs } from "../../src/viewer/tab-layout";

const targets = Array.from({ length: 30 }, (_, index) => ({
  id: `page-${index}`,
  title: `Project ${index}`,
}));
const space = (width: number) => ({ width, gap: 3, overflow: 38 });

it("caps comfortable widths and compresses before hiding any targets", () => {
  expect(layoutTabs([], null, true, space(0))).toEqual({
    overflow: false,
    items: [],
  });
  const few = targets.slice(0, 3);
  expect(
    layoutTabs(few, "page-1", true, null).items.map((item) => item.width),
  ).toEqual([232, 232, 232]);
  for (const width of [702, 703, 1200]) {
    const layout = layoutTabs(few, "page-1", true, space(width));
    expect(layout.overflow).toBe(false);
    expect(layout.items.map((item) => item.width)).toEqual([232, 232, 232]);
  }
  const compressed = layoutTabs(few, "page-1", true, space(306));
  expect(compressed.overflow).toBe(false);
  expect(compressed.items.map((item) => item.width)).toEqual([100, 100, 100]);
});

it("protects the active close action and switches at the actual minimum boundary", () => {
  const few = targets.slice(0, 3);
  expect(
    layoutTabs(few, "page-1", true, space(134)).items.map((item) => item.width),
  ).toEqual([40, 48, 40]);
  for (const width of [118, 119]) {
    const result = layoutTabs(few, "page-1", true, space(width));
    expect(result.overflow).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items[1]!.width).toBe(48);
  }
  const overflow = layoutTabs(few, "page-2", true, space(117));
  expect(overflow.overflow).toBe(true);
  expect(overflow.items).toEqual([{ target: few[2], width: 79 }]);
  expect(
    layoutTabs(few, "page-2", true, space(118)).items.map(
      (item) => item.target,
    ),
  ).toEqual(few);
});

it("keeps an ordered prefix and selected target without changing remote data", () => {
  const before = targets.slice();
  const result = layoutTabs(targets, "page-29", true, space(210));
  expect(result.overflow).toBe(true);
  expect(result.items.map((item) => item.target.id)).toEqual([
    "page-0",
    "page-1",
    "page-2",
    "page-29",
  ]);
  expect(targets).toEqual(before);
  expect(
    layoutTabs(targets, null, true, space(210)).items.map(
      (item) => item.target.id,
    ),
  ).toEqual(["page-0", "page-1", "page-2", "page-3", "page-4"]);
  expect(layoutTabs(targets, "lost", true, space(210)).items).toEqual(
    layoutTabs(targets, null, true, space(210)).items,
  );
});

it("fits fractional and tiny budgets without negative widths or losing selector access", () => {
  for (const interactive of [true, false]) {
    for (const width of [-1, 0, 1, 47, 86, 117.5, 118, 220.25, 800]) {
      const result = layoutTabs(targets, "page-29", interactive, space(width));
      const used =
        result.items.reduce((total, item) => total + item.width, 0) +
        Math.max(0, result.items.length - 1) * 3;
      expect(used).toBeLessThanOrEqual(Math.max(0, width - 38) + 0.001);
      for (const item of result.items) {
        expect(item.width).toBeGreaterThanOrEqual(
          interactive && item.target.id === "page-29" ? 48 : 32,
        );
        expect(item.width).toBeLessThanOrEqual(232);
      }
      expect(result.overflow).toBe(true);
    }
  }
  expect(layoutTabs(targets, "page-29", true, space(47)).items).toEqual([]);
});

it("does not reserve an unavailable close control in view-only mode", () => {
  const few = targets.slice(0, 3);
  const result = layoutTabs(few, "page-2", false, space(102));
  expect(result.overflow).toBe(false);
  expect(result.items.map((item) => item.width)).toEqual([32, 32, 32]);
  expect(layoutTabs(few, "page-2", false, space(101)).overflow).toBe(true);
});

it("keeps layout state private to an instance and never changes its snapshot or selection", () => {
  const first = createViewerModel();
  const second = createViewerModel();
  for (const model of [first, second]) {
    model.run(model.configure$, { interactive: true, scoped: true });
    model.update({ targets });
    model.transition({ type: "select", targetId: "page-29", paused: false });
  }
  const snapshot = first.getSnapshot();
  first.run(first.resizeTabs$, space(210));
  expect(first.getSnapshot()).toBe(snapshot);
  expect(first.read(first.tabLayout$).items).toHaveLength(4);
  expect(second.read(second.tabLayout$).items).toHaveLength(30);
  const layout = first.read(first.tabLayout$);
  first.run(first.resizeTabs$, space(210));
  expect(first.read(first.tabLayout$)).toBe(layout);
  first.update({
    targets: targets.map((target) => ({
      ...target,
      title: target.title + " updated",
    })),
  });
  expect(
    first.read(first.tabLayout$).items.map((item) => item.target.id),
  ).toEqual(layout.items.map((item) => item.target.id));
  first.run(first.resizeTabs$, space(8000));
  expect(first.read(first.tabLayout$).overflow).toBe(false);
  expect(first.read(first.tabLayout$).items).toHaveLength(30);
  expect(first.getSnapshot().selectedTargetId).toBe("page-29");
});
