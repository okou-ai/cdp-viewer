import {
  createContext,
  useCallback,
  useContext,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { Command, Computed } from "ccstate";
import type { Instance } from "./instance";

/** Private context metadata is shared; the provider's Store never is. */
export function createScope<Model extends Instance>(factory: () => Model) {
  const Context = createContext<{ model: Model; id: string } | null>(null);
  function Provider({ children }: { children: ReactNode }) {
    // Only pure graph allocation is allowed here. Active resources start after
    // commit in their DOM/runtime owner, including under Strict Mode and SSR.
    const [model] = useState(factory);
    const id = useId();
    const [value] = useState(() => ({ model, id }));
    return <Context value={value}>{children}</Context>;
  }
  function useScope() {
    const value = useContext(Context);
    if (!value) throw new Error("State must belong to its private instance.");
    return value;
  }
  function useModel(): Model {
    return useScope().model;
  }
  function useIdentity(): string {
    return useScope().id;
  }
  function useValue<T>(value$: Computed<T>): T {
    const model = useModel();
    const subscribe = useCallback(
      (listener: () => void) => model.watch(value$, listener),
      [model, value$],
    );
    const read = useCallback(() => model.read(value$), [model, value$]);
    return useSyncExternalStore(subscribe, read, read);
  }
  function useCommand<T, Args extends unknown[]>(action$: Command<T, Args>) {
    const model = useModel();
    return useCallback(
      (...args: Args) => model.run(action$, ...args),
      [model, action$],
    );
  }
  return Object.freeze({
    Provider,
    useModel,
    useIdentity,
    useValue,
    useCommand,
  });
}
