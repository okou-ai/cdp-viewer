import { command, computed, state } from "ccstate";
import { createInstance } from "../src/state/instance";
import { parseConnection } from "./connection";
import type { Connection, ConnectionError } from "./connection";

export interface Panel {
  readonly id: number;
  readonly endpoint: string;
  readonly windowDraft: string;
  readonly connection: Connection | null;
  readonly error: ConnectionError | null;
  readonly generation: number;
}

function panel(id: number): Panel {
  return {
    id,
    endpoint: "",
    windowDraft: "",
    connection: null,
    error: null,
    generation: 0,
  };
}

function createDemoSignals() {
  const internalPanels$ = state<readonly Panel[]>([panel(1)]);
  const nextId$ = state(2);
  const panels$ = computed((get) => get(internalPanels$));
  const add$ = command(({ get, set }) => {
    const id = get(nextId$);
    set(nextId$, id + 1);
    set(internalPanels$, (values) => [...values, panel(id)]);
  });
  const remove$ = command(({ set }, id: number) => {
    set(internalPanels$, (values) => values.filter((item) => item.id !== id));
  });
  const edit$ = command(
    ({ set }, id: number, field: "endpoint" | "windowDraft", value: string) => {
      set(internalPanels$, (values) =>
        values.map((item) =>
          item.id === id ? { ...item, [field]: value } : item,
        ),
      );
    },
  );
  const connect$ = command(({ set }, id: number) => {
    set(internalPanels$, (values) =>
      values.map((item) => {
        if (item.id !== id) return item;
        const result = parseConnection(item.endpoint, item.windowDraft);
        if ("error" in result) return { ...item, error: result.error };
        const generation = item.generation + 1;
        return {
          ...item,
          error: null,
          generation,
          connection: { ...result.value, generation },
        };
      }),
    );
  });
  const reconnect$ = command(({ set }, id: number) => {
    set(internalPanels$, (values) =>
      values.map((item) => {
        if (item.id !== id || !item.connection) return item;
        const generation = item.generation + 1;
        return {
          ...item,
          generation,
          connection: { ...item.connection, generation },
        };
      }),
    );
  });
  const disconnect$ = command(({ set }, id: number) => {
    set(internalPanels$, (values) =>
      values.map((item) =>
        item.id === id ? { ...item, connection: null } : item,
      ),
    );
  });
  return { panels$, add$, remove$, edit$, connect$, reconnect$, disconnect$ };
}

export function createDemoModel() {
  const instance = createInstance(createDemoSignals);
  return {
    ...instance.signals,
    read: instance.read,
    watch: instance.watch,
    run: instance.run,
  };
}
