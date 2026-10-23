import { clipboardTextLimit } from "./selection";
import type { InputBinding } from "./ingress";

export interface ClipboardRecovery {
  readonly message: string;
  readonly text: string | null;
}

const recoveryMessage =
  "Automatic copy is unavailable. Select the text below and use your browser's Copy command, or try Copy text.";
const unavailableMessage =
  "Copy is unavailable for this selection. Use selected page text or a supported text control.";

interface CopyAttempt {
  reject: (reason: Error) => void;
  text: string | null;
  failed: boolean;
}

/** Local clipboard effects belong to this proxy and the original user gesture. */
export class NativeClipboard {
  private attempt: CopyAttempt | null = null;
  private recovery: ClipboardRecovery | null = null;

  constructor(
    private readonly proxy: HTMLTextAreaElement,
    private readonly input: (event?: Event) => InputBinding | null,
    private readonly composing: () => boolean,
    private readonly changed: (recovery: ClipboardRecovery | null) => void,
    signal: AbortSignal,
  ) {
    proxy.addEventListener("copy", this.copy, { signal });
    proxy.addEventListener("paste", this.paste, { signal });
    proxy.addEventListener(
      "cut",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      { signal },
    );
  }

  reset(keepRecovery = false): void {
    const attempt = this.attempt;
    this.attempt = null;
    attempt?.reject(new Error("Copy cancelled"));
    if (!keepRecovery) this.show(null);
  }

  private show(value: ClipboardRecovery | null): void {
    this.recovery = value;
    this.changed(value);
  }

  private focused(event?: Event): InputBinding | null {
    return document.activeElement === this.proxy ? this.input(event) : null;
  }

  private readonly paste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const input = this.focused(event);
    const owner = input?.owner;
    if (!event.isTrusted || !input || !owner) return;
    if (this.composing()) {
      input.clipboardError("Finish composing text before pasting.");
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length > clipboardTextLimit) {
      input.clipboardError("Clipboard text exceeds the supported size.");
      return;
    }
    if (
      !text &&
      event.clipboardData?.types.length &&
      !event.clipboardData.types.includes("text/plain")
    ) {
      input.clipboardError("Only plain-text clipboard transfer is supported.");
      return;
    }
    if (text) input.text(text, owner);
  };

  private readonly copy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const input = this.focused(event);
    const owner = input?.owner;
    if (!event.isTrusted || !input || !owner) return;
    this.reset();
    if (this.composing()) {
      input.clipboardError("Finish composing text before copying.");
      return;
    }
    let resolveData!: (value: Blob) => void;
    let rejectData!: (reason: Error) => void;
    const data = new Promise<Blob>((resolve, reject) => {
      resolveData = resolve;
      rejectData = reject;
    });
    // A rejected representation must also be handled when write is unsupported
    // or throws before the browser consumes the promise.
    data.catch(() => undefined);
    const attempt: CopyAttempt = {
      reject: rejectData,
      text: null,
      failed: false,
    };
    this.attempt = attempt;
    const failed = () => {
      if (this.attempt !== attempt) return;
      attempt.failed = true;
      if (attempt.text !== null) {
        this.show({ message: recoveryMessage, text: attempt.text });
        input.clipboardError(
          "Local clipboard access failed. Use the copy recovery controls.",
        );
      }
    };
    // Start the browser write synchronously, before awaiting any CDP request.
    try {
      const write = navigator.clipboard.write([
        new ClipboardItem({ "text/plain": data }),
      ]);
      write.then(() => {
        if (this.attempt === attempt) {
          this.attempt = null;
          this.show(null);
        }
      }, failed);
    } catch {
      failed();
    }
    input.selection(owner).then(
      (result) => {
        if (
          this.attempt !== attempt ||
          this.focused() !== input ||
          input.owner !== owner
        ) {
          rejectData(new Error("Copy cancelled"));
          return;
        }
        if (result.status !== "ok" || !result.text) {
          this.attempt = null;
          rejectData(new Error("No supported selection"));
          if (result.status !== "empty") {
            const message =
              result.status === "too-large"
                ? "Selected text exceeds the supported clipboard size."
                : result.status === "stale"
                  ? "The selection changed while copying. Select the text again."
                  : unavailableMessage;
            input.clipboardError(message);
            this.show({ message, text: null });
          }
          return;
        }
        attempt.text = result.text;
        resolveData(new Blob([result.text], { type: "text/plain" }));
        if (attempt.failed) failed();
      },
      () => {
        rejectData(new Error("Selection unavailable"));
        if (this.attempt !== attempt) return;
        this.attempt = null;
        input.clipboardError(
          "Copy could not be completed. Select the text and try again.",
        );
      },
    );
  };

  /** Invoked synchronously by a fresh local button gesture. Never reread remotely. */
  copyRecovery(): void {
    const recovery = this.recovery;
    if (recovery?.text === null || !recovery) return;
    try {
      navigator.clipboard.writeText(recovery.text).then(
        () => {
          if (this.recovery === recovery) this.reset();
        },
        () => {
          if (this.recovery === recovery)
            this.input()?.clipboardError(
              "Use your browser's Copy command on the selected recovery text.",
            );
        },
      );
    } catch {
      this.input()?.clipboardError(
        "Use your browser's Copy command on the selected recovery text.",
      );
    }
  }
}
