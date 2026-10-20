import type { SocketFactory } from "../../src/cdp/client";

export interface WireCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  readonly commands: WireCommand[] = [];
  constructor(
    readonly handle?: (command: WireCommand, socket: FakeSocket) => void,
  ) {
    super();
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(raw: string) {
    const command = JSON.parse(raw) as WireCommand;
    this.commands.push(command);
    this.handle?.(command, this);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  reply(command: WireCommand, result: object = {}) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ id: command.id, result }),
      }),
    );
  }
  reject(command: WireCommand, code = -32601) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: command.id,
          error: { code, message: "provider private data" },
        }),
      }),
    );
  }
  emit(method: string, params: object, sessionId?: string) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ method, params, sessionId }),
      }),
    );
  }
  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

export interface FakeTarget {
  id: string;
  windowId: number;
  title: string;
}

export class FakeBrowser {
  readonly sockets: FakeSocket[] = [];
  targets: FakeTarget[] = [
    { id: "page-a", windowId: 0, title: "Window A" },
    { id: "page-b", windowId: 2, title: "Window B" },
  ];
  unsupportedWindows = false;
  unsupportedStream = false;
  holdAttach = false;
  readonly held: {
    command: WireCommand;
    socket: FakeSocket;
    sessionId: string;
  }[] = [];
  private nextSession = 0;

  readonly factory: SocketFactory = () => {
    const socket = new FakeSocket((command, wire) =>
      this.respond(command, wire),
    );
    this.sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket.asWebSocket();
  };

  frame(socket: FakeSocket, sessionId: string, frameId = 73): void {
    socket.emit(
      "Page.screencastFrame",
      { data: "aW1hZ2U=", sessionId: frameId },
      sessionId,
    );
  }

  private respond(command: WireCommand, socket: FakeSocket): void {
    queueMicrotask(() => {
      switch (command.method) {
        case "Target.getTargets":
          socket.reply(command, {
            targetInfos: this.targets.map((t) => ({
              targetId: t.id,
              title: t.title,
              type: "page",
              url: "about:blank",
            })),
          });
          break;
        case "Browser.getWindowForTarget": {
          const target = this.targets.find(
            (t) => t.id === command.params?.targetId,
          );
          if (this.unsupportedWindows || !target) socket.reject(command);
          else socket.reply(command, { windowId: target.windowId, bounds: {} });
          break;
        }
        case "Target.attachToTarget": {
          const sessionId = "session-" + ++this.nextSession;
          if (this.holdAttach) this.held.push({ command, socket, sessionId });
          else socket.reply(command, { sessionId });
          break;
        }
        case "Page.startScreencast":
          if (this.unsupportedStream) {
            socket.reject(command);
            break;
          }
          socket.reply(command);
          if (command.sessionId) this.frame(socket, command.sessionId);
          break;
        default:
          socket.reply(command);
      }
    });
  }
}
