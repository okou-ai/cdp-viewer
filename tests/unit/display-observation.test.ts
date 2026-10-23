import { afterEach, expect, it, vi } from "vitest";
import { observeDisplay } from "../../src/react/display";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("observes density-only changes, rearms resolution queries and releases DOM resources", () => {
  let resize: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve() {}
    },
  );
  const queries: {
    change: EventListener | null;
    remove: ReturnType<typeof vi.fn>;
  }[] = [];
  const match = vi.fn(() => {
    const query = { change: null as EventListener | null, remove: vi.fn() };
    queries.push(query);
    return {
      addEventListener: (_type: string, callback: EventListener) => {
        query.change = callback;
      },
      removeEventListener: query.remove,
    };
  });
  vi.stubGlobal("matchMedia", match);
  vi.stubGlobal("devicePixelRatio", 1);
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 640.5, 480),
  );
  const changed = vi.fn();
  const stop = observeDisplay(canvas, changed);
  expect(observe).toHaveBeenCalledWith(canvas);
  expect(changed).toHaveBeenLastCalledWith({
    width: 640.5,
    height: 480,
    dpr: 1,
  });
  vi.stubGlobal("devicePixelRatio", 2);
  queries[0]!.change!(new Event("change"));
  expect(queries[0]!.remove).toHaveBeenCalledWith("change", queries[0]!.change);
  expect(match).toHaveBeenLastCalledWith("(resolution: 2dppx)");
  expect(changed).toHaveBeenLastCalledWith({
    width: 640.5,
    height: 480,
    dpr: 2,
  });
  stop();
  const count = changed.mock.calls.length;
  resize!([], {} as ResizeObserver);
  queries[1]!.change!(new Event("change"));
  window.dispatchEvent(new Event("resize"));
  expect(changed).toHaveBeenCalledTimes(count);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(match).toHaveBeenCalledTimes(2);
  expect(queries[1]!.remove).toHaveBeenCalledWith("change", queries[1]!.change);
});
