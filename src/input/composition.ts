import type { InputOwner } from "./lifecycle";

type State =
  | { kind: "idle" }
  | { kind: "composing"; owner: InputOwner }
  | { kind: "trailing"; value: string };

/** Native composition state, independent of DOM and CDP event timing. */
export class NativeComposition {
  private state: State = { kind: "idle" };

  get composing(): boolean {
    return this.state.kind === "composing";
  }

  reset(): void {
    this.state = { kind: "idle" };
  }

  start(owner: InputOwner | null): void {
    this.state = owner ? { kind: "composing", owner } : { kind: "idle" };
  }

  end(data: string, owner: InputOwner | null) {
    const commit =
      owner !== null &&
      this.state.kind === "composing" &&
      this.state.owner === owner;
    const value = owner ? data : "";
    // A late end may only consume its following value, never commit to a new owner.
    this.state = value ? { kind: "trailing", value } : { kind: "idle" };
    return { value, text: commit ? data : "" };
  }

  input(
    value: string,
    owner: InputOwner | null,
    compositionInput: boolean,
    isComposing: boolean,
  ) {
    if (!owner || (this.state.kind === "idle" && compositionInput)) {
      this.reset();
      return { keep: false, text: "" };
    }
    if (this.state.kind === "composing" || isComposing)
      return { keep: true, text: "" };
    const consumed = this.state.kind === "trailing" ? this.state.value : "";
    const text =
      consumed && value.startsWith(consumed)
        ? value.slice(consumed.length)
        : value;
    this.reset();
    return { keep: false, text };
  }
}
