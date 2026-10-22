import type { ClipboardRecovery } from "../../src/input/clipboard";
import { navigationAddress } from "../../src/input/address";
import type { ViewerNavigation } from "../../src/viewer/types";
import type { NavigationAction } from "./native-actions";

/** Private fixture controls render the real adapter's recovery, without copying it. */
export function nativeControls(
  stage: HTMLElement,
  navigate: (action: NavigationAction) => void,
  copy: () => void,
  dismiss: () => void,
) {
  const toolbar = document.createElement("div");
  toolbar.setAttribute("aria-label", "Executor controls");
  const address = document.createElement("input");
  address.setAttribute("aria-label", "Executor address");
  const status = document.createElement("output");
  status.setAttribute("aria-label", "Executor status");
  const recovery = document.createElement("div");
  const text = document.createElement("textarea");
  text.readOnly = true;
  text.setAttribute("aria-label", "Text to copy");
  text.addEventListener("focus", () => text.select());
  const message = document.createElement("span");
  let ready = true;
  let navigation: ViewerNavigation | null = null;
  const button = (name: string, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = name;
    element.addEventListener("click", run);
    return element;
  };
  const go = () => {
    const url =
      address.value.length <= 64 * 1024
        ? navigationAddress(address.value)
        : null;
    if (!url) status.textContent = "Enter a supported page address.";
    else if (ready) navigate({ url });
  };
  const back = button("Executor back", () => navigate("back"));
  const forward = button("Executor forward", () => navigate("forward"));
  const reload = button("Executor reload", () => navigate("reload"));
  const submit = button("Executor navigate", go);
  const update = () => {
    back.disabled = !ready || !navigation?.canGoBack;
    forward.disabled = !ready || !navigation?.canGoForward;
    reload.disabled = submit.disabled = !ready;
  };
  address.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      go();
    }
  });
  recovery.append(
    message,
    text,
    button("Copy text", copy),
    button("Dismiss copy", dismiss),
  );
  recovery.hidden = true;
  toolbar.append(back, forward, reload, address, submit, status, recovery);
  stage.before(toolbar);
  return {
    navigation(value: ViewerNavigation | null) {
      navigation = value;
      if (document.activeElement !== address) address.value = value?.url ?? "";
      update();
    },
    ready(value: boolean) {
      ready = value;
      update();
    },
    error(value: string | null) {
      status.textContent = value ?? "";
    },
    recovery(value: ClipboardRecovery | null) {
      recovery.hidden = value === null;
      message.textContent = value?.message ?? "";
      text.value = value?.text ?? "";
      text.hidden = value?.text == null;
    },
    focus: () => address.focus(),
    dispose: () => toolbar.remove(),
  };
}
