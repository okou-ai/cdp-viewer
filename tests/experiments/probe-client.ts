/** Minimal native keys/committed-text adapter, deliberately not NativeInput parity. */
export function installProbeClient({
  endpoint,
  owner,
}: {
  endpoint: string;
  owner: string;
}) {
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Executor experiment input");
  document.body.append(input);
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  let acknowledged = 0;
  const completed = new Set<number>();
  let stopped = false;
  const pending = new Set<number>();
  const pressed = new Set<string>();
  const stats = {
    sent: [] as number[],
    acknowledged: [] as number[],
    peakOutstanding: 0,
    revoked: false,
  };
  const stop = () => {
    stopped = true;
    stats.revoked = true;
    pending.clear();
    socket.close();
  };
  const send = (action: object) => {
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    if (sequence - acknowledged >= 64) {
      stop();
      return;
    }
    pending.add(++sequence);
    stats.peakOutstanding = Math.max(stats.peakOutstanding, pending.size);
    stats.sent.push(Date.now());
    socket.send(JSON.stringify({ owner, sequence, acknowledged, ...action }));
  };
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    const response = JSON.parse(event.data) as {
      type: string;
      sequence?: number;
      ok?: boolean;
    };
    if (response.type === "revoked" || response.ok === false) stop();
    else if (
      response.type === "ack" &&
      response.sequence !== undefined &&
      pending.delete(response.sequence)
    ) {
      completed.add(response.sequence);
      while (completed.delete(acknowledged + 1)) acknowledged++;
      stats.acknowledged.push(Date.now());
    }
  });
  socket.addEventListener("close", stop);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      stop();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    pressed.add(event.code);
    key(event, "rawKeyDown");
  });
  input.addEventListener("keyup", (event) => {
    if (pressed.delete(event.code)) key(event, "keyUp");
  });
  function key(event: KeyboardEvent, type: "rawKeyDown" | "keyUp") {
    send({
      kind: "key",
      key: {
        type,
        key: event.key,
        code: event.code,
        modifiers:
          (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0),
        windowsVirtualKeyCode: event.keyCode,
      },
    });
  }
  input.addEventListener("input", (event) => {
    if ((event as InputEvent).isComposing) {
      stop();
      return;
    }
    if (input.value) send({ kind: "text", text: input.value });
    input.value = "";
  });
  input.addEventListener("blur", stop);
  Object.assign(window, { probeStats: stats });
  return new Promise<void>((resolve) => {
    socket.addEventListener("open", () => {
      input.focus();
      resolve();
    });
  });
}
