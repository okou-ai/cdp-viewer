import { command, computed, state } from "ccstate";
import { createInstance } from "../state/instance";
import type { ViewerError, ViewerSnapshot } from "./types";

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

type ViewerNotification = {
  readonly id: number;
  readonly error: ViewerError;
  readonly exiting: boolean;
  readonly entrance: "initial" | "replacement";
  readonly previous: {
    readonly id: number;
    readonly error: ViewerError;
  } | null;
};

export type TabAction =
  | { readonly type: "create" }
  | { readonly type: "close"; readonly targetId: string };

export type ViewerTransition =
  | { type: "reset" }
  | { type: "select"; targetId: string; paused: boolean }
  | { type: "target-lost"; error: ViewerError | null }
  | { type: "discovery-failed"; error: ViewerError }
  | { type: "paused" | "streaming" | "stopped" }
  | { type: "failed"; error: ViewerError }
  | { type: "disconnected"; established: boolean; error: ViewerError };

export type ViewerUpdate = Partial<
  Pick<ViewerSnapshot, "targets" | "navigation" | "error">
>;

function initialSnapshot(): ViewerSnapshot {
  return Object.freeze({
    status: "connecting",
    targets: Object.freeze([]),
    selectedTargetId: null,
    error: null,
    navigation: null,
  });
}

function createViewerSignals() {
  const internalSnapshot$ = state<ViewerSnapshot>(initialSnapshot());
  const internalRevision$ = state(0);
  const actions$ = state<ViewerActions | null>(null);
  const draft$ = state<AddressDraft | null>(null);
  const pendingTab$ = state<TabAction | null>(null);
  const internalNotification$ = state<ViewerNotification | null>(null);
  const notificationSequence$ = state(0);
  const internalConnected$ = state(false);
  const configuration$ = state({
    interactive: false,
    scoped: false,
  });
  const configure$ = command(
    ({ set }, value: { interactive: boolean; scoped: boolean }) =>
      set(configuration$, Object.freeze({ ...value })),
  );
  const setConnected$ = command(({ set }, value: boolean) =>
    set(internalConnected$, value),
  );
  const tabAction$ = computed((get) => get(pendingTab$));
  const setTabAction$ = command(({ set }, action: TabAction | null) => {
    set(pendingTab$, action);
  });
  const snapshot$ = computed((get) => get(internalSnapshot$));
  const notification$ = computed((get) => get(internalNotification$));
  const finishReplacement$ = command(({ get, set }, id: number) => {
    const notification = get(internalNotification$);
    if (
      notification?.id === id &&
      notification.previous &&
      !notification.exiting
    )
      set(
        internalNotification$,
        Object.freeze({ ...notification, previous: null }),
      );
  });
  const exitNotification$ = command(({ get, set }, id: number) => {
    const notification = get(internalNotification$);
    if (notification?.id === id && !notification.exiting)
      set(
        internalNotification$,
        Object.freeze({ ...notification, exiting: true, previous: null }),
      );
  });
  const removeNotification$ = command(({ get, set }, id: number) => {
    const notification = get(internalNotification$);
    if (notification?.id === id && notification.exiting)
      set(internalNotification$, null);
  });
  const revision$ = computed((get) => get(internalRevision$));
  const controls$ = computed((get) => {
    const snapshot = get(snapshot$);
    const { interactive, scoped } = get(configuration$);
    const streaming = snapshot.status === "streaming";
    const empty =
      snapshot.status === "unavailable" &&
      !snapshot.targets.length &&
      (!snapshot.error || snapshot.error.kind === "target-unavailable");
    const emptyUnscoped = empty && !scoped;
    const recovery =
      snapshot.status === "error" ||
      snapshot.status === "disconnected" ||
      (snapshot.status === "unavailable" &&
        snapshot.error?.kind !== "target-unavailable" &&
        !!snapshot.error);
    const canMutateTabs =
      interactive && get(internalConnected$) && !get(pendingTab$);
    return Object.freeze({
      streaming,
      emptyUnscoped,
      emptyScoped: empty && scoped,
      recovery,
      showRecovery: recovery || empty,
      showEmptyCreate: emptyUnscoped && interactive,
      canMutateTabs,
      canCreate: canMutateTabs && (streaming || emptyUnscoped),
      tabsDisabled: snapshot.status === "disconnected",
      placeholderTitle:
        snapshot.status === "disconnected"
          ? "Browser disconnected"
          : snapshot.status === "error"
            ? snapshot.error?.kind === "connection"
              ? "Unable to connect"
              : "Unable to show browser"
            : empty
              ? "No tabs open"
              : snapshot.status === "paused"
                ? "Viewing paused"
                : snapshot.status === "connecting"
                  ? "Connecting to browser…"
                  : recovery
                    ? "Browser view unavailable"
                    : "Choose a tab to continue",
    });
  });
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
    if (next.status !== "streaming") set(internalNotification$, null);
    else if (patch.error) {
      const previous = get(internalNotification$);
      const id = get(notificationSequence$) + 1;
      set(notificationSequence$, id);
      set(
        internalNotification$,
        Object.freeze({
          id,
          error: patch.error,
          exiting: false,
          entrance: previous ? "replacement" : "initial",
          previous: previous
            ? Object.freeze({ id: previous.id, error: previous.error })
            : null,
        }),
      );
    } else if (patch.error === null) {
      const notification = get(internalNotification$);
      if (notification) set(exitNotification$, notification.id);
    }
    set(internalSnapshot$, next);
  });
  const updateData$ = command(({ set }, patch: ViewerUpdate) =>
    set(update$, patch),
  );
  const transition$ = command(({ get, set }, event: ViewerTransition) => {
    switch (event.type) {
      case "reset":
        set(internalConnected$, false);
        set(pendingTab$, null);
        set(update$, initialSnapshot());
        break;
      case "select":
        set(update$, {
          selectedTargetId: event.targetId,
          status: event.paused ? "paused" : "connecting",
          error: null,
          navigation: null,
        });
        break;
      case "target-lost":
      case "discovery-failed":
        set(update$, {
          ...(event.type === "discovery-failed"
            ? { targets: Object.freeze([]) }
            : {}),
          selectedTargetId: null,
          status: "unavailable",
          error: event.error,
          navigation: null,
        });
        break;
      case "paused":
        if (get(snapshot$).selectedTargetId)
          set(update$, { status: "paused", error: null, navigation: null });
        break;
      case "streaming":
        set(update$, { status: "streaming", error: null });
        break;
      case "stopped":
        set(internalNotification$, null);
        if (get(snapshot$).navigation) set(update$, { navigation: null });
        break;
      case "failed":
        set(update$, {
          status: "error",
          error: event.error,
          navigation: null,
        });
        break;
      case "disconnected":
        set(internalConnected$, false);
        set(update$, {
          status: event.established ? "disconnected" : "error",
          error: event.error,
          navigation: null,
        });
        break;
    }
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
      set(internalNotification$, null);
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
    notification$,
    finishReplacement$,
    exitNotification$,
    removeNotification$,
    revision$,
    address$,
    tabAction$,
    controls$,
    configure$,
    setConnected$,
    setTabAction$,
    createTab$,
    closeTab$,
    updateData$,
    transition$,
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
    update: (patch: ViewerUpdate) =>
      instance.run(instance.signals.updateData$, patch),
    transition: (event: ViewerTransition) =>
      instance.run(instance.signals.transition$, event),
  };
}

export type ViewerModel = ReturnType<typeof createViewerModel>;
