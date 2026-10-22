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
    if (this.readyState !== 0) return;
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
  url?: string;
}

export class FakeBrowser {
  readonly sockets: FakeSocket[] = [];
  targets: FakeTarget[] = [
    { id: "page-a", windowId: 0, title: "Window A" },
    { id: "page-b", windowId: 2, title: "Window B" },
  ];
  unsupportedWindows = false;
  unsupportedStream = false;
  unsupportedDisplay = false;
  unsupportedContentsSize = false;
  nativeDpr = 1;
  windowState = "normal";
  readonly windowSizes = new Map<number, { width: number; height: number }>();
  private readonly emulation = new Map<
    string,
    { width: number; height: number; dpr: number }
  >();
  private readonly streams = new Set<string>();
  holdAttach = false;
  holdMethod: string | null = null;
  blockOpen = false;
  readonly heldCommands: { command: WireCommand; socket: FakeSocket }[] = [];
  readonly held: {
    command: WireCommand;
    socket: FakeSocket;
    sessionId: string;
  }[] = [];
  private nextSession = 0;
  private nextTarget = 0;
  private readonly sessions = new Map<string, string>();

  readonly factory: SocketFactory = () => {
    const socket = new FakeSocket((command, wire) =>
      this.respond(command, wire),
    );
    this.sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket.asWebSocket();
  };

  frame(socket: FakeSocket, sessionId: string, frameId = 73): void {
    const target = this.targets.find(
      (value) => value.id === this.sessions.get(sessionId),
    );
    const size = target ? this.windowSizes.get(target.windowId) : undefined;
    socket.emit(
      "Page.screencastFrame",
      {
        data: "aW1hZ2U=",
        sessionId: frameId,
        ...(size
          ? {
              metadata: {
                deviceWidth: size.width,
                deviceHeight: size.height,
                pageScaleFactor: 1,
              },
            }
          : {}),
      },
      sessionId,
    );
  }

  private respond(command: WireCommand, socket: FakeSocket): void {
    queueMicrotask(() => {
      if (command.method === this.holdMethod) {
        this.heldCommands.push({ command, socket });
        return;
      }
      switch (command.method) {
        case "Page.createIsolatedWorld":
          socket.reply(command, { executionContextId: 42 });
          break;
        case "Page.getFrameTree":
          socket.reply(command, { frameTree: { frame: { id: "main" } } });
          break;
        case "Runtime.evaluate":
          if (
            command.params?.expression ===
            "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"
          ) {
            const target = this.targets.find(
              (value) => value.id === this.sessions.get(command.sessionId!),
            );
            const size = this.emulation.get(command.sessionId!) ??
              (target ? this.windowSizes.get(target.windowId) : undefined) ?? {
                width: 800,
                height: 600,
              };
            socket.reply(command, {
              result: {
                type: "object",
                value: {
                  width: size.width,
                  height: size.height,
                  dpr:
                    this.emulation.get(command.sessionId!)?.dpr ??
                    this.nativeDpr,
                },
              },
            });
            break;
          }
          if (
            String(command.params?.expression).includes(
              "const tab = window.open(",
            )
          ) {
            if (!this.blockOpen) {
              const match = /window\.open\(("[^"]+")/.exec(
                String(command.params?.expression),
              );
              const source = this.targets.find(
                (target) => target.id === this.sessions.get(command.sessionId!),
              );
              this.targets.push({
                id: `new-${++this.nextTarget}`,
                windowId: source?.windowId ?? 0,
                title: "New tab",
                url: JSON.parse(match![1]!) as string,
              });
              for (const wire of this.sockets)
                wire.emit("Target.targetCreated", {});
            }
            socket.reply(command, {
              result: { type: "boolean", value: !this.blockOpen },
            });
            break;
          }
          socket.reply(command, {
            result: {
              type: "object",
              value: {
                x: 10,
                y: 20,
                width: 800,
                height: 600,
                offsetX: 0,
                offsetY: 0,
              },
            },
          });
          break;
        case "Runtime.callFunctionOn":
          socket.reply(command, {
            result: {
              type: "object",
              value: {
                editable: true,
                supported: true,
                x: 10,
                y: 20,
                width: 800,
                height: 600,
                offsetX: 0,
                offsetY: 0,
              },
            },
          });
          break;
        case "Page.getLayoutMetrics":
          socket.reply(command, {
            visualViewport: {
              clientWidth: 800 * this.nativeDpr,
              clientHeight: 600 * this.nativeDpr,
            },
            cssVisualViewport: {
              offsetX: 0,
              offsetY: 0,
              clientWidth: 800,
              clientHeight: 600,
            },
          });
          break;
        case "Page.getNavigationHistory":
          socket.reply(command, {
            currentIndex: 0,
            entries: [
              { id: 1, url: "https://fixture.invalid/", title: "Fixture" },
            ],
          });
          break;
        case "Target.getTargetInfo": {
          const target = this.targets.find(
            (t) => t.id === command.params?.targetId,
          );
          if (!target) socket.reject(command, -32000);
          else
            socket.reply(command, {
              targetInfo: {
                targetId: target.id,
                type: "page",
                title: target.title,
                url: target.url ?? "about:blank",
              },
            });
          break;
        }
        case "Target.getTargets":
          socket.reply(command, {
            targetInfos: this.targets.map((t) => ({
              targetId: t.id,
              title: t.title,
              type: "page",
              url: t.url ?? "about:blank",
            })),
          });
          break;
        case "Browser.getWindowForTarget": {
          const target = this.targets.find(
            (t) => t.id === command.params?.targetId,
          );
          if (this.unsupportedWindows || !target) socket.reject(command);
          else
            socket.reply(command, {
              windowId: target.windowId,
              bounds: { windowState: this.windowState },
            });
          break;
        }
        case "Emulation.setDeviceMetricsOverride":
          if (this.unsupportedDisplay) socket.reject(command);
          else {
            this.emulation.set(command.sessionId!, {
              width: Number(command.params?.width),
              height: Number(command.params?.height),
              dpr: Number(command.params?.deviceScaleFactor),
            });
            socket.reply(command);
            socket.emit("Page.frameResized", {}, command.sessionId);
          }
          break;
        case "Emulation.clearDeviceMetricsOverride":
          this.emulation.delete(command.sessionId!);
          socket.reply(command);
          socket.emit("Page.frameResized", {}, command.sessionId);
          this.frame(socket, command.sessionId!);
          break;
        case "Browser.setContentsSize":
          if (this.unsupportedContentsSize) {
            socket.reject(command);
            break;
          }
          this.windowSizes.set(Number(command.params?.windowId), {
            width: Number(command.params?.width),
            height: Number(command.params?.height),
          });
          socket.reply(command);
          for (const session of this.streams) {
            const target = this.targets.find(
              (value) => value.id === this.sessions.get(session),
            );
            if (target?.windowId === command.params?.windowId) {
              socket.emit("Page.frameResized", {}, session);
              this.frame(socket, session);
            }
          }
          break;
        case "Target.detachFromTarget":
          this.emulation.delete(String(command.params?.sessionId));
          this.streams.delete(String(command.params?.sessionId));
          socket.reply(command);
          break;
        case "Page.stopScreencast":
          this.streams.delete(command.sessionId!);
          socket.reply(command);
          break;
        case "Target.attachToTarget": {
          const sessionId = "session-" + ++this.nextSession;
          this.sessions.set(sessionId, String(command.params?.targetId));
          if (this.holdAttach) this.held.push({ command, socket, sessionId });
          else socket.reply(command, { sessionId });
          break;
        }
        case "Target.createTarget": {
          const targetId = `new-${++this.nextTarget}`;
          this.targets.push({
            id: targetId,
            title: "New tab",
            windowId: 0,
            url: "about:blank",
          });
          for (const wire of this.sockets)
            wire.emit("Target.targetCreated", {});
          socket.reply(command, { targetId });
          break;
        }
        case "Target.closeTarget": {
          const targetId = command.params?.targetId;
          this.targets = this.targets.filter(
            (target) => target.id !== targetId,
          );
          for (const wire of this.sockets)
            wire.emit("Target.targetDestroyed", { targetId });
          socket.reply(command, { success: true });
          break;
        }
        case "Page.startScreencast":
          if (this.unsupportedStream) {
            socket.reject(command);
            break;
          }
          this.streams.add(command.sessionId!);
          socket.reply(command);
          // Deliver before the awaiting startup continuation: frames may race
          // the start response, and must not become a cancelled-timer error.
          if (command.sessionId) this.frame(socket, command.sessionId);
          break;
        default:
          socket.reply(command);
      }
    });
  }
}
