import { expect, it } from "vitest";
import {
  currentObservation,
  currentRound,
  initialInventory,
  inventoryExpiry,
  inventoryTargets,
  transitionInventory,
} from "../../src/viewer/target-inventory";
import type {
  InventoryEvent,
  TargetObservation,
} from "../../src/viewer/target-inventory";

const page = { id: "page", title: "Initial" };

function inventory() {
  let state = initialInventory();
  const send = (event: InventoryEvent) =>
    (state = transitionInventory(state, event));
  const observe = (id = page.id, startedAt = 0): TargetObservation => {
    send({ type: "order" });
    return {
      id,
      epoch: state.epoch,
      generation: state.entries.get(id)!.generation,
      order: state.sequence,
      startedAt,
    };
  };
  const round = send({ type: "begin-round", now: 0 }).round!;
  send({ type: "listed", round, targets: [page] });
  send({ type: "membership", observation: observe(), member: true });
  send({ type: "complete-round", round });
  return { read: () => state, send, observe };
}

function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, index) =>
        permutations(items.filter((_, other) => other !== index)).map(
          (tail) => [item, ...tail],
        ),
      );
}

const traces = permutations([
  "title-one",
  "title-two",
  "older",
  "newer",
]).filter((trace) => trace.indexOf("title-one") < trace.indexOf("title-two"));

it.each(traces.map((trace) => ({ trace })))(
  "keeps title and scope observation order independent: $trace",
  ({ trace }) => {
    for (const member of [false, true]) {
      const h = inventory();
      const older = h.observe(page.id, 1);
      const newer = h.observe(page.id, 2);
      for (const event of trace) {
        if (event === "older" || event === "newer")
          h.send({
            type: "membership",
            observation: event === "older" ? older : newer,
            member: event === "older" ? !member : member,
          });
        else
          h.send({
            type: "metadata",
            target: { ...page, title: event },
            now: 3,
          });
      }
      expect(h.read().entries.get(page.id)?.target?.title).toBe("title-two");
      expect(inventoryTargets(h.read())).toEqual(
        member ? [{ ...page, title: "title-two" }] : [],
      );
      expect(currentObservation(h.read(), older)).toBe(false);
    }
  },
);

it("merges a full result's scope without restoring its older title", () => {
  const h = inventory();
  const round = h.send({ type: "begin-round", now: 10 }).round!;
  h.send({ type: "metadata", target: { ...page, title: "Newer" }, now: 11 });
  h.send({ type: "listed", round, targets: [page] });
  h.send({
    type: "membership",
    observation: h.observe(page.id, 12),
    member: true,
  });
  h.send({ type: "complete-round", round });
  expect(inventoryTargets(h.read())).toEqual([{ ...page, title: "Newer" }]);
});

it("rejects a destroyed unknown target from a held bootstrap", () => {
  let state = initialInventory();
  state = transitionInventory(state, { type: "begin-round", now: 0 });
  const round = state.round!;
  state = transitionInventory(state, { type: "retired", id: page.id });
  state = transitionInventory(state, {
    type: "listed",
    round,
    targets: [page],
  });
  state = transitionInventory(state, { type: "complete-round", round });
  expect(inventoryTargets(state)).toEqual([]);
  expect(state.entries.size).toBe(0);
});

it.each(["birth", "metadata", "membership"])(
  "preserves newer %s evidence against a stale full omission",
  (kind) => {
    const h = inventory();
    const round = h.send({ type: "begin-round", now: 1 }).round!;
    const target =
      kind === "birth"
        ? { id: "new-page", title: "New" }
        : kind === "metadata"
          ? { ...page, title: "New" }
          : page;
    if (kind !== "membership") h.send({ type: "metadata", target, now: 2 });
    const proof = h.observe(target.id, 2);
    h.send({ type: "membership", observation: proof, member: true });
    h.send({ type: "listed", round, targets: kind === "birth" ? [page] : [] });
    h.send({ type: "complete-round", round });
    expect(inventoryTargets(h.read())).toContainEqual(target);
  },
);

it.each(["retired", "closed", "reset"] as const)(
  "does not transfer a proof through %s and a new lifetime",
  (type) => {
    const h = inventory();
    const old = h.observe();
    h.send(type === "reset" ? { type } : { type, id: page.id });
    h.send({
      type: "metadata",
      target: { ...page, title: "Replacement" },
      now: 1,
    });
    h.send({ type: "membership", observation: old, member: true });
    expect(currentObservation(h.read(), old)).toBe(false);
    expect(inventoryTargets(h.read())).toEqual([]);
  },
);

it("keeps provisional creation private and refuses its retired completion", () => {
  const h = inventory();
  h.send({ type: "begin-creation", id: "created", now: 1 });
  const observation = h.observe("created", 1);
  expect(inventoryTargets(h.read())).toEqual([page]);
  h.send({ type: "retired", id: "created" });
  h.send({
    type: "created",
    observation,
    target: { id: "created", title: "Stale" },
  });
  expect(inventoryTargets(h.read())).toEqual([page]);
});

it("accepts creation metadata independently without reversing a newer negative membership", () => {
  const h = inventory();
  h.send({ type: "begin-creation", id: page.id, now: 1 });
  const creation = h.observe(page.id, 1);
  h.send({
    type: "membership",
    observation: h.observe(page.id, 2),
    member: false,
  });
  h.send({
    type: "created",
    observation: creation,
    target: { ...page, title: "Created" },
  });
  expect(h.read().entries.get(page.id)?.target?.title).toBe("Created");
  expect(inventoryTargets(h.read())).toEqual([]);
});

it("anchors scope expiry to dispatch and never renews it from title events", () => {
  const h = inventory();
  const observation = h.observe(page.id, 9000);
  h.send({
    type: "metadata",
    target: { ...page, title: "At receipt" },
    now: 18000,
  });
  h.send({ type: "membership", observation, member: true });
  expect(h.read().entries.get(page.id)?.expiresAt).toBe(29000);
  h.send({ type: "metadata", target: { ...page, title: "Later" }, now: 28000 });
  expect(h.read().entries.get(page.id)?.expiresAt).toBe(29000);
  expect(inventoryExpiry(h.read())).toBe(20000);
});

it("retires round journals with explicit operations and leaves prior state unchanged", () => {
  const h = inventory();
  const before = h.read();
  const round = h.send({ type: "begin-round", now: 1 }).round!;
  h.send({ type: "closed", id: page.id });
  for (let index = 0; index < 513; index++)
    h.send({ type: "retired", id: "worker-" + index });
  expect(currentRound(h.read(), round)).toBe(false);
  expect(before.entries.get(page.id)?.target).toEqual(page);
  expect(inventoryTargets(h.read())).toEqual([]);
});

it("bounds active lifecycle journals without requiring metadata quiet", () => {
  const h = inventory();
  h.send({ type: "begin-round", now: 0 });
  for (let index = 0; index < 512; index++)
    h.send({ type: "retired", id: "worker-" + index });
  expect(() => h.send({ type: "retired", id: "overflow" })).toThrow(
    "Too many browser target changes",
  );
});
