import { expect, it } from "vitest";
import { transitionImage } from "../../src/viewer/image-recovery";
import type {
  ImageEvent,
  ImageRecovery,
} from "../../src/viewer/image-recovery";

const owner = {};
const error = { kind: "frame", message: "Synthetic capture failure" } as const;
const failed: ImageEvent = {
  type: "image-failed",
  owner,
  targetId: "page-a",
  error,
};
const settled: ImageEvent = { type: "image-settled", owner, ready: true };
const retry: ImageEvent = { type: "image-retrying", owner };
const starting: ImageEvent = { type: "image-starting", owner };
const paint: ImageEvent = { type: "image-painted", owner };
const released: ImageEvent = { type: "image-released", owner };

function after(events: readonly ImageEvent[]): ImageRecovery | null {
  let image: ImageRecovery | null = null;
  for (const event of [failed, ...events])
    image = transitionImage(image, event).state;
  return image;
}

it.each([
  [paint, released],
  [released, paint],
])(
  "joins current paint and lane release in either order: %j",
  (first, last) => {
    let image = after([settled, retry, starting]);
    const early = transitionImage(image, first);
    expect(early.accepted).toBe(true);
    expect(early.imageReady).toBe(first === paint);
    expect(early.resumeDisplay).toBe(false);
    image = early.state;
    const complete = transitionImage(image, last);
    expect(complete.state).toBeNull();
    expect(complete.imageReady).toBe(last === paint);
    expect(complete.resumeDisplay).toBe(true);
    for (const late of [first, last, settled, retry]) {
      const decision = transitionImage(complete.state, late);
      expect(decision.accepted).toBe(false);
      expect(decision.resumeDisplay).toBe(false);
    }
  },
);

it.each([true, false])(
  "cancellation reports original native stop certainty: stopped=%s",
  (stopped) => {
    const image = after([settled, retry, starting]);
    const cancelled = transitionImage(image, {
      type: "image-cancelled",
      owner,
      stopped,
    });
    expect(cancelled.state?.phase).toBe(stopped ? "ready" : "blocked");
    expect(transitionImage(cancelled.state, retry).accepted).toBe(stopped);
    for (const late of [paint, released, settled])
      expect(transitionImage(cancelled.state, late).state).toBe(
        cancelled.state,
      );
  },
);

it("does not substitute a stopped capture for still-pending input/display cleanup", () => {
  const image = after([]);
  const cancelled = transitionImage(image, {
    type: "image-cancelled",
    owner,
    stopped: true,
  });
  expect(cancelled.state).toBe(image);
  expect(transitionImage(cancelled.state, retry).accepted).toBe(false);
  expect(transitionImage(cancelled.state, settled).state?.phase).toBe("ready");
});

it("rejects obsolete owners and late cleanup without rewinding a running attempt", () => {
  const image = after([settled, retry]);
  for (const event of [settled, paint, released, starting]) {
    const obsolete = { ...event, owner: {} };
    expect(transitionImage(image, obsolete).state).toBe(image);
  }
  expect(transitionImage(image, settled).state).toBe(image);
  expect(transitionImage(image, retry).state).toBe(image);
});

it("preserves cleanup, start, paint and lane invariants across bounded event sequences", () => {
  const events: readonly ImageEvent[] = [
    settled,
    { type: "image-settled", owner, ready: false },
    retry,
    starting,
    paint,
    released,
    { type: "image-cancelled", owner, stopped: true },
    { type: "image-cancelled", owner, stopped: false },
    { type: "image-blocked", owner, error },
  ];
  interface Facts {
    stopped: boolean;
    intent: boolean;
    started: boolean;
    painted: boolean;
    released: boolean;
    resumed: boolean;
  }
  let inspected = 0;
  function visit(
    image: ImageRecovery | null,
    facts: Facts,
    depth: number,
    trace: readonly string[],
  ) {
    if (!depth) return;
    for (const event of events) {
      inspected++;
      const next = transitionImage(image, event);
      const observed = { ...facts };
      const path = [...trace, event.type];
      const require = (valid: boolean) => {
        if (!valid)
          throw new Error("Lifecycle invariant: " + path.join(" -> "));
      };
      if (!next.accepted) {
        require(
          next.state === image && !next.imageReady && !next.resumeDisplay,
        );
      } else {
        if (event.type === "image-settled") observed.stopped = event.ready;
        if (event.type === "image-retrying") {
          require(observed.stopped);
          observed.intent = true;
          observed.started = observed.painted = observed.released = false;
          observed.resumed = false;
        }
        if (event.type === "image-starting") {
          require(observed.intent && observed.stopped);
          observed.stopped = false;
          observed.started = true;
        }
        if (event.type === "image-painted") {
          require(observed.intent && observed.started);
          observed.painted = true;
        }
        if (event.type === "image-released") {
          require(observed.intent && observed.started);
          observed.released = true;
        }
        if (event.type === "image-cancelled") {
          observed.stopped = event.stopped;
          observed.intent = false;
          observed.painted = observed.released = false;
        }
        if (next.imageReady) require(observed.intent && observed.painted);
        if (next.resumeDisplay) {
          require(
            observed.intent &&
              observed.painted &&
              observed.released &&
              !observed.resumed,
          );
          observed.resumed = true;
        }
      }
      visit(next.state, observed, depth - 1, path);
    }
  }
  const prefixes = [
    [],
    [settled],
    [settled, retry, starting],
    [settled, retry, starting, paint],
    [settled, retry, starting, released],
  ];
  for (const prefix of prefixes)
    visit(
      after(prefix),
      {
        stopped: prefix.includes(settled) && !prefix.includes(starting),
        intent: prefix.includes(retry),
        started: prefix.includes(starting),
        painted: prefix.includes(paint),
        released: prefix.includes(released),
        resumed: false,
      },
      4,
      prefix.map((event) => event.type),
    );
  expect(inspected).toBe(36_900);
});
