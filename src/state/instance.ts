import { createStore } from "ccstate";
import type { Command, Computed } from "ccstate";

export interface ValueBinding<T> {
  readonly read: () => T;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface Instance {
  read: <T>(value$: Computed<T>) => T;
  watch: (value$: Computed<unknown>, listener: () => void) => () => void;
  run: <T, Args extends unknown[]>(
    action$: Command<T, Args>,
    ...args: Args
  ) => T;
  bindValue: <T>(value$: Computed<T>) => ValueBinding<T>;
  bindCommand: <T, Args extends unknown[]>(
    action$: Command<T, Args>,
  ) => (...args: Args) => T;
}

/** Pure instance allocation: no subscription or external resource before commit. */
class SignalInstance<Signals> implements Instance {
  private readonly store = createStore();
  private readonly values = new WeakMap<object, unknown>();
  private readonly commands = new WeakMap<object, unknown>();
  readonly signals: Signals;

  constructor(factory: () => Signals) {
    this.signals = factory();
  }

  readonly read = <T>(value$: Computed<T>): T => this.store.get(value$);
  readonly watch = (value$: Computed<unknown>, listener: () => void) =>
    this.store.watch(value$, listener);
  readonly run = <T, Args extends unknown[]>(
    action$: Command<T, Args>,
    ...args: Args
  ): T => this.store.set(action$, ...args);

  readonly bindValue = <T>(value$: Computed<T>): ValueBinding<T> => {
    // Each key fixes T; the weak cache never crosses this Store's lifetime.
    const cached = this.values.get(value$) as ValueBinding<T> | undefined;
    if (cached) return cached;
    const binding = Object.freeze({
      read: () => this.read(value$),
      subscribe: (listener: () => void) => this.watch(value$, listener),
    });
    this.values.set(value$, binding);
    return binding;
  };

  readonly bindCommand = <T, Args extends unknown[]>(
    action$: Command<T, Args>,
  ): ((...args: Args) => T) => {
    const cached = this.commands.get(action$) as
      ((...args: Args) => T) | undefined;
    if (cached) return cached;
    const invoke = (...args: Args) => this.run(action$, ...args);
    this.commands.set(action$, invoke);
    return invoke;
  };
}

export function createInstance<Signals>(factory: () => Signals) {
  return new SignalInstance(factory);
}
