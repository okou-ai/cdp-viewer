import { updateModel } from "./inventory";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createScope } from "../../src/state/react";
import { createViewerModel } from "../../src/viewer/model";
import type { ViewerModel } from "../../src/viewer/model";

it("keeps bindings stable by signal and instance and releases external subscriptions", () => {
  const first = createViewerModel();
  const sibling = createViewerModel();
  const snapshot = first.bindValue(first.snapshot$);
  expect(first.bindValue(first.snapshot$)).toBe(snapshot);
  expect(sibling.bindValue(first.snapshot$)).not.toBe(snapshot);
  expect(first.bindCommand(first.editAddress$)).toBe(
    first.bindCommand(first.editAddress$),
  );
  expect(sibling.bindCommand(first.editAddress$)).not.toBe(
    first.bindCommand(first.editAddress$),
  );
  const notified = vi.fn();
  const stop = snapshot.subscribe(notified);
  updateModel(first, { targets: [{ id: "one", title: "One" }] });
  expect(notified).toHaveBeenCalledTimes(1);
  expect(snapshot.read().targets).toEqual([{ id: "one", title: "One" }]);
  updateModel(sibling, { targets: [] });
  expect(notified).toHaveBeenCalledTimes(1);
  stop();
  updateModel(first, { targets: [] });
  expect(notified).toHaveBeenCalledTimes(1);
});

it("retains ccstate commands and independent providers across ordinary rerenders", () => {
  const models: ViewerModel[] = [];
  const scope = createScope(() => {
    const model = createViewerModel();
    models.push(model);
    return model;
  });
  const commands: ((value: string) => void)[] = [];
  function Editor({ label }: { label: string }) {
    const model = scope.useModel();
    const value = scope.useValue(model.address$);
    const edit = scope.useCommand(model.editAddress$);
    commands.push(edit);
    return (
      <input
        aria-label={label}
        value={value}
        onChange={(event) => edit(event.target.value)}
      />
    );
  }
  const view = render(
    <scope.Provider>
      <Editor label="First" />
    </scope.Provider>,
  );
  const command = commands[0];
  view.rerender(
    <scope.Provider>
      <Editor label="Renamed" />
    </scope.Provider>,
  );
  expect(models).toHaveLength(1);
  expect(commands.at(-1)).toBe(command);
  fireEvent.change(screen.getByLabelText("Renamed"), {
    target: { value: "https://owned.invalid/" },
  });
  expect(screen.getByLabelText("Renamed")).toHaveValue(
    "https://owned.invalid/",
  );
  render(
    <scope.Provider>
      <Editor label="Sibling" />
    </scope.Provider>,
  );
  expect(models).toHaveLength(2);
  expect(screen.getByLabelText("Sibling")).toHaveValue("");
  view.unmount();
  const count = commands.length;
  act(() => models[0]!.run(models[0]!.editAddress$, "retired"));
  expect(commands).toHaveLength(count);
  expect(screen.getByLabelText("Sibling")).toHaveValue("");
});

it("preserves scope identity and server snapshots through hydration", async () => {
  const scope = createScope(createViewerModel);
  function Address() {
    const model = scope.useModel();
    const value = scope.useValue(model.address$);
    const id = scope.useIdentity();
    const edit = scope.useCommand(model.editAddress$);
    return (
      <label htmlFor={id}>
        Hydrated address
        <input
          id={id}
          value={value}
          onChange={(event) => edit(event.target.value)}
        />
      </label>
    );
  }
  const element = (
    <scope.Provider>
      <Address />
    </scope.Provider>
  );
  const container = document.createElement("div");
  container.innerHTML = renderToString(element);
  document.body.append(container);
  const before = container.querySelector("input")!.id;
  const recoverable = vi.fn();
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: recoverable,
      });
    });
    expect(container.querySelector("input")!.id).toBe(before);
    expect(recoverable).not.toHaveBeenCalled();
    fireEvent.change(container.querySelector("input")!, {
      target: { value: "hydrated" },
    });
    expect(container.querySelector("input")).toHaveValue("hydrated");
  } finally {
    act(() => root?.unmount());
    container.remove();
  }
});
