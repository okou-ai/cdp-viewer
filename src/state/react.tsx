import {
  Component,
  createContext,
  useContext,
  useId,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { Command, Computed } from "ccstate";
import type { Instance, ValueBinding } from "./instance";

/** Private context metadata is shared; the provider's Store never is. */
export function createScope<Model extends Instance>(factory: () => Model) {
  const Context = createContext<{ model: Model; id: string } | null>(null);
  class InstanceProvider extends Component<{
    children: ReactNode;
    id: string;
  }> {
    // Store/graph construction is pure, including abandoned Strict Mode renders.
    private readonly model = factory();
    private readonly value = { model: this.model, id: this.props.id };

    render() {
      return <Context value={this.value}>{this.props.children}</Context>;
    }
  }
  function Provider({ children }: { children: ReactNode }) {
    const id = useId();
    return <InstanceProvider id={id}>{children}</InstanceProvider>;
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
    const binding: ValueBinding<T> = model.bindValue(value$);
    return useSyncExternalStore(binding.subscribe, binding.read, binding.read);
  }
  function useCommand<T, Args extends unknown[]>(action$: Command<T, Args>) {
    const model = useModel();
    return model.bindCommand(action$);
  }
  return Object.freeze({
    Provider,
    useModel,
    useIdentity,
    useValue,
    useCommand,
  });
}
