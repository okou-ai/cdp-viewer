import { command, computed, state } from "ccstate";
import { createInstance } from "../state/instance";
import type { ViewerSnapshot } from "./types";

export interface ViewerActions {
  select(targetId: string): void;
  createTab(): void;
  closeTab(targetId: string): void;
  navigate(action: "back" | "forward" | "reload" | { url: string }): void;
}

interface AddressDraft {
  value: string;
  editing: boolean;
}

export type TabAction =
  | { readonly type: "create" }
  | { readonly type: "close"; readonly targetId: string };

function createViewerSignals() {
  const internalSnapshot$ = state<ViewerSnapshot>(
    Object.freeze({
      status: "connecting",
      targets: Object.freeze([]),
      selectedTargetId: null,
      error: null,
      navigation: null,
    }),
  );
  const internalRevision$ = state(0);
  const actions$ = state<ViewerActions | null>(null);
  const draft$ = state<AddressDraft | null>(null);
  const pendingTab$ = state<TabAction | null>(null);
  const internalConnected$ = state(false);
  const connected$ = computed((get) => get(internalConnected$));
  const setConnected$ = command(({ set }, value: boolean) =>
    set(internalConnected$, value),
  );
  const tabAction$ = computed((get) => get(pendingTab$));
  const setTabAction$ = command(({ set }, action: TabAction | null) => {
    set(pendingTab$, action);
  });
  const snapshot$ = computed((get) => get(internalSnapshot$));
  const revision$ = computed((get) => get(internalRevision$));
  const address$ = computed((get) => {
    const draft = get(draft$);
    const remoteUrl = get(snapshot$).navigation?.url ?? "";
    const url = remoteUrl === "about:blank" ? "" : remoteUrl;
    return draft ? draft.value : url;
  });
  const update$ = command(({ get, set }, patch: Partial<ViewerSnapshot>) => {
    const old = get(internalSnapshot$);
    const next = Object.freeze({ ...old, ...patch });
    // A completed draft belongs to this URL lifetime, including reconnects
    // through null that subsequently reopen exactly the same remote address.
    if (old.navigation?.url !== next.navigation?.url && !get(draft$)?.editing)
      set(draft$, null);
    set(internalSnapshot$, next);
  });
  const bind$ = command(({ set }, actions: ViewerActions) => {
    set(pendingTab$, null);
    set(actions$, actions);
  });
  const unbind$ = command(({ get, set }, actions: ViewerActions) => {
    if (get(actions$) === actions) {
      set(actions$, null);
      set(pendingTab$, null);
      set(internalConnected$, false);
    }
  });
  const reconnect$ = command(({ set }) => {
    set(internalRevision$, (value) => value + 1);
  });
  const select$ = command(({ get }, targetId: string) => {
    get(actions$)?.select(targetId);
  });
  const createTab$ = command(({ get }) => get(actions$)?.createTab());
  const closeTab$ = command(({ get }, targetId: string) =>
    get(actions$)?.closeTab(targetId),
  );
  const navigate$ = command(
    ({ get }, action: "back" | "forward" | "reload") => {
      get(actions$)?.navigate(action);
    },
  );
  const resetAddress$ = command(({ set }) => {
    set(draft$, null);
  });
  const focusAddress$ = command(({ get, set }) => {
    set(draft$, {
      value: get(address$),
      editing: true,
    });
  });
  const editAddress$ = command(({ set }, value: string) => {
    set(draft$, {
      value,
      editing: true,
    });
  });
  const blurAddress$ = command(({ get, set }) => {
    const draft = get(draft$);
    if (draft)
      set(draft$, {
        ...draft,
        editing: false,
      });
  });
  const submitAddress$ = command(({ get, set }) => {
    const url = get(address$).trim();
    set(blurAddress$);
    get(actions$)?.navigate({ url });
  });
  return {
    snapshot$,
    revision$,
    address$,
    tabAction$,
    connected$,
    setConnected$,
    setTabAction$,
    createTab$,
    closeTab$,
    update$,
    bind$,
    unbind$,
    reconnect$,
    select$,
    navigate$,
    resetAddress$,
    focusAddress$,
    editAddress$,
    blurAddress$,
    submitAddress$,
  };
}

export function createViewerModel() {
  const instance = createInstance(createViewerSignals);
  return {
    ...instance.signals,
    read: instance.read,
    watch: instance.watch,
    run: instance.run,
    getSnapshot: () => instance.read(instance.signals.snapshot$),
    subscribe: (listener: () => void) =>
      instance.watch(instance.signals.snapshot$, listener),
    update: (patch: Partial<ViewerSnapshot>) =>
      instance.run(instance.signals.update$, patch),
  };
}

export type ViewerModel = ReturnType<typeof createViewerModel>;
