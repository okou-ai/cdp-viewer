import { createStore } from "ccstate";
import type { Command, Computed } from "ccstate";

export interface Instance {
  read: <T>(value$: Computed<T>) => T;
  watch: (value$: Computed<unknown>, listener: () => void) => () => void;
  run: <T, Args extends unknown[]>(
    action$: Command<T, Args>,
    ...args: Args
  ) => T;
}

/** The sole Store construction boundary. Every call owns a fresh graph. */
export function createInstance<Signals>(factory: () => Signals) {
  const store = createStore();
  const signals = factory();
  return {
    signals,
    read: <T>(value$: Computed<T>): T => store.get(value$),
    watch: (value$: Computed<unknown>, listener: () => void): (() => void) =>
      store.watch(value$, listener),
    run: <T, Args extends unknown[]>(
      action$: Command<T, Args>,
      ...args: Args
    ): T => store.set(action$, ...args),
  };
}
