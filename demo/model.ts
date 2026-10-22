import { command, computed, state } from "ccstate";
import type {
  CdpViewerProps,
  ViewerError,
  ViewerExtension,
  ViewerSnapshot,
} from "cdp-viewer";
import { createInstance } from "../src/state/instance";
import { parseConnection } from "./connection";
import type { Connection, ConnectionError } from "./connection";
import { callbackLimit, defaultOptions, summarizeSnapshot } from "./playground";
import type {
  CallbackEvent,
  PlaygroundOptions,
  SnapshotSummary,
} from "./playground";

export interface Panel {
  readonly id: number;
  readonly endpoint: string;
  readonly windowDraft: string;
  readonly extensions: readonly ViewerExtension[];
  readonly connection: Connection | null;
  readonly error: ConnectionError | null;
  readonly generation: number;
  readonly options: PlaygroundOptions;
  readonly snapshot: SnapshotSummary | null;
  readonly activity: readonly CallbackEvent[];
  readonly sequence: number;
}

function panel(id: number): Panel {
  return {
    id,
    endpoint: "",
    windowDraft: "",
    extensions: [],
    connection: null,
    error: null,
    generation: 0,
    options: { ...defaultOptions },
    snapshot: null,
    activity: [],
    sequence: 0,
  };
}

function createDemoSignals() {
  const internalAppearance$ =
    state<NonNullable<CdpViewerProps["colorScheme"]>>("system");
  const appearance$ = computed((get) => get(internalAppearance$));
  const setAppearance$ = command(({ set }, value: string) => {
    if (value === "light" || value === "dark" || value === "system")
      set(internalAppearance$, value);
  });
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
  const setExtension$ = command(
    ({ set }, id: number, extension: ViewerExtension, enabled: boolean) => {
      set(internalPanels$, (values) =>
        values.map((item) => {
          if (
            item.id !== id ||
            item.extensions.some((value) => value.id === extension.id) ===
              enabled
          )
            return item;
          return {
            ...item,
            extensions: enabled
              ? [...item.extensions, extension]
              : item.extensions.filter((value) => value.id !== extension.id),
          };
        }),
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
          snapshot: null,
          activity: [],
          connection: {
            ...result.value,
            extensions: item.extensions,
            generation,
          },
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
          snapshot: null,
          activity: [],
          connection: { ...item.connection, generation },
        };
      }),
    );
  });
  const disconnect$ = command(({ set }, id: number) => {
    set(internalPanels$, (values) =>
      values.map((item) =>
        item.id === id
          ? { ...item, connection: null, snapshot: null, activity: [] }
          : item,
      ),
    );
  });
  const configure$ = command(
    ({ set }, id: number, patch: Partial<PlaygroundOptions>) => {
      set(internalPanels$, (values) =>
        values.map((item) => {
          if (item.id !== id) return item;
          const options = { ...item.options, ...patch };
          if (
            item.connection &&
            options.interactive !== item.options.interactive
          ) {
            const generation = item.generation + 1;
            return {
              ...item,
              options,
              generation,
              connection: { ...item.connection, generation },
              snapshot: null,
              activity: [],
            };
          }
          return { ...item, options };
        }),
      );
    },
  );
  const clearActivity$ = command(({ set }, id: number) => {
    set(internalPanels$, (values) =>
      values.map((item) => (item.id === id ? { ...item, activity: [] } : item)),
    );
  });
  const observeStatus$ = command(
    (
      { get, set },
      id: number,
      generation: number,
      snapshot: ViewerSnapshot,
    ) => {
      const owner = get(internalPanels$).find((item) => item.id === id);
      if (!owner?.connection || owner.connection.generation !== generation)
        return;
      const value = summarizeSnapshot(snapshot);
      const sequence = owner.sequence + 1;
      const event: CallbackEvent = { sequence, name: "onStatusChange", value };
      set(internalPanels$, (values) =>
        values.map((item) =>
          item.id === id
            ? {
                ...item,
                snapshot: value,
                sequence,
                activity: [...item.activity, event].slice(-callbackLimit),
              }
            : item,
        ),
      );
    },
  );
  const observeError$ = command(
    ({ get, set }, id: number, generation: number, error: ViewerError) => {
      const owner = get(internalPanels$).find((item) => item.id === id);
      if (!owner?.connection || owner.connection.generation !== generation)
        return;
      const sequence = owner.sequence + 1;
      const event: CallbackEvent = {
        sequence,
        name: "onError",
        value: { kind: error.kind, message: error.message },
      };
      set(internalPanels$, (values) =>
        values.map((item) =>
          item.id === id
            ? {
                ...item,
                sequence,
                activity: [...item.activity, event].slice(-callbackLimit),
              }
            : item,
        ),
      );
    },
  );
  return {
    appearance$,
    setAppearance$,
    panels$,
    add$,
    remove$,
    edit$,
    setExtension$,
    connect$,
    reconnect$,
    disconnect$,
    configure$,
    clearActivity$,
    observeStatus$,
    observeError$,
  };
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
