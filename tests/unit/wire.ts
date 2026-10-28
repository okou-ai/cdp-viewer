import type { SocketFactory } from "../../src/cdp/client";

/** The fake wire carries observable raster dimensions instead of real image bytes. */
export function fakeRaster(data: string): { width: number; height: number } {
  return JSON.parse(atob(data)) as { width: number; height: number };
}

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
  holdReplyMethod: string | null = null;
  readonly heldReplies: { command: WireCommand; result: object }[] = [];
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
    if (command.method === this.holdReplyMethod) {
      this.heldReplies.push({ command, result });
      return;
    }
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
  unsupportedClock = false;
  navigationHistory = {
    currentIndex: 0,
    entries: [{ id: 1, url: "https://fixture.invalid/", title: "Fixture" }],
  };
  favicon: unknown = null;
  holdFavicon = false;
  nativeDpr = 1;
  browserZoom = 1;
  windowState = "normal";
  readonly windowSizes = new Map<number, { width: number; height: number }>();
  private readonly emulation = new Map<
    string,
    { width: number; height: number; dpr: number }
  >();
  private readonly streams = new Map<string, FakeSocket>();
  private readonly captureBounds = new Map<
    string,
    { width: number; height: number }
  >();
  private nativeClock = 1_800_000_000;
  private readonly clocks = new Set<string>();
  frameClockStep = 0.002;
  holdAttach = false;
  holdFrames = false;
  readonly heldFrames: (() => void)[] = [];
  holdMethod: string | null = null;
  holdCommand: ((command: WireCommand) => boolean) | null = null;
  holdExpression: string | null = null;
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

  resume(command: WireCommand, socket: FakeSocket): void {
    if (this.holds(command))
      throw new Error("Clear the held method before resuming it.");
    this.respond(command, socket);
  }

  private holds(command: WireCommand): boolean {
    return (
      this.holdCommand?.(command) === true ||
      (this.holdMethod === command.method &&
        (this.holdExpression === null ||
          command.params?.expression === this.holdExpression))
    );
  }

  frame(
    socket: FakeSocket,
    sessionId: string,
    frameId = 73,
    nativeMetadata = true,
  ): void {
    const target = this.targets.find(
      (value) => value.id === this.sessions.get(sessionId),
    );
    const native = target ? this.windowSizes.get(target.windowId) : undefined;
    const size = native ?? { width: 800, height: 600 };
    const bounds = this.captureBounds.get(sessionId) ?? {
      width: 4096,
      height: 4096,
    };
    const scale = Math.min(
      this.nativeDpr,
      bounds.width / size.width,
      bounds.height / size.height,
    );
    const timestamp = this.clocks.has(this.sessions.get(sessionId) ?? sessionId)
      ? (this.nativeClock += this.frameClockStep)
      : undefined;
    const emit = () =>
      socket.emit(
        "Page.screencastFrame",
        {
          data: btoa(
            JSON.stringify({
              width: Math.round(size.width * scale),
              height: Math.round(size.height * scale),
            }),
          ),
          sessionId: frameId,
          ...(native || nativeMetadata || timestamp !== undefined
            ? {
                metadata: {
                  deviceWidth: size.width,
                  deviceHeight: size.height,
                  pageScaleFactor: 1,
                  ...(timestamp === undefined ? {} : { timestamp }),
                },
              }
            : {}),
        },
        sessionId,
      );
    if (this.holdFrames) this.heldFrames.push(emit);
    else emit();
  }

  private respond(command: WireCommand, socket: FakeSocket): void {
    queueMicrotask(() => {
      if (this.holds(command)) {
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
            String(command.params?.expression).startsWith(
              "/* cdp-viewer favicon */",
            )
          ) {
            if (this.holdFavicon) this.heldCommands.push({ command, socket });
            else
              socket.reply(command, {
                result: { type: typeof this.favicon, value: this.favicon },
              });
            break;
          }
          if (
            command.params?.expression === "Date.now()" ||
            (command.params?.awaitPromise === true &&
              String(command.params.expression).includes("Date.now()"))
          ) {
            if (this.unsupportedClock) {
              socket.reply(command, { result: { type: "undefined" } });
              break;
            }
            // A page's native clock is shared by control and capture sessions.
            this.clocks.add(
              this.sessions.get(command.sessionId!) ?? command.sessionId!,
            );
            this.nativeClock += 0.01;
            const sampled = Math.floor(this.nativeClock * 1000);
            this.nativeClock = sampled / 1000;
            if (command.params?.awaitPromise === true) {
              // Model the renderer clock after the requested native timer turn.
              const fence = sampled + 1;
              this.nativeClock = fence / 1000;
              socket.reply(command, {
                result: { type: "object", value: { fence, now: fence } },
              });
              break;
            }
            socket.reply(command, {
              result: { type: "number", value: sampled },
            });
            break;
          }
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
                  width: Math.round(size.width / this.browserZoom),
                  height: Math.round(size.height / this.browserZoom),
                  dpr:
                    (this.emulation.get(command.sessionId!)?.dpr ??
                      this.nativeDpr) * this.browserZoom,
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
              this.created({
                id: `new-${++this.nextTarget}`,
                windowId: source?.windowId ?? 0,
                title: "New tab",
                url: JSON.parse(match![1]!) as string,
              });
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
        case "Page.getLayoutMetrics": {
          const target = this.targets.find(
            (value) => value.id === this.sessions.get(command.sessionId!),
          );
          const size = this.emulation.get(command.sessionId!) ??
            (target ? this.windowSizes.get(target.windowId) : undefined) ?? {
              width: 800,
              height: 600,
            };
          const width = size.width / this.browserZoom,
            height = size.height / this.browserZoom;
          socket.reply(command, {
            visualViewport: {
              clientWidth: width * this.nativeDpr * this.browserZoom,
              clientHeight: height * this.nativeDpr * this.browserZoom,
            },
            cssVisualViewport: {
              zoom: this.browserZoom,
              offsetX: 0,
              offsetY: 0,
              clientWidth: width,
              clientHeight: height,
            },
          });
          break;
        }
        case "Page.getNavigationHistory":
          socket.reply(command, this.navigationHistory);
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
          else {
            const size = this.windowSizes.get(target.windowId) ?? {
              width: 800,
              height: 600,
            };
            socket.reply(command, {
              windowId: target.windowId,
              bounds: {
                width: Math.round(size.width),
                height: Math.round(size.height) + 87,
                windowState: this.windowState,
              },
            });
          }
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
            if (this.streams.has(command.sessionId!))
              this.frame(socket, command.sessionId!);
          }
          break;
        case "Emulation.clearDeviceMetricsOverride":
          this.emulation.delete(command.sessionId!);
          socket.reply(command);
          socket.emit("Page.frameResized", {}, command.sessionId);
          this.frame(socket, command.sessionId!, 73, true);
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
          for (const [session, streamSocket] of this.streams) {
            const target = this.targets.find(
              (value) => value.id === this.sessions.get(session),
            );
            if (target?.windowId === command.params?.windowId) {
              streamSocket.emit("Page.frameResized", {}, session);
              this.frame(streamSocket, session);
            }
          }
          break;
        case "Target.detachFromTarget":
          this.emulation.delete(String(command.params?.sessionId));
          this.streams.delete(String(command.params?.sessionId));
          this.captureBounds.delete(String(command.params?.sessionId));
          socket.reply(command);
          break;
        case "Page.stopScreencast":
          this.streams.delete(command.sessionId!);
          this.captureBounds.delete(command.sessionId!);
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
          this.created({
            id: targetId,
            title: "New tab",
            windowId: 0,
            url: "about:blank",
          });
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
          if (this.unsupportedStream || this.streams.has(command.sessionId!)) {
            socket.reject(command);
            break;
          }
          this.streams.set(command.sessionId!, socket);
          this.captureBounds.set(command.sessionId!, {
            width:
              typeof command.params?.maxWidth === "number"
                ? command.params.maxWidth
                : 4096,
            height:
              typeof command.params?.maxHeight === "number"
                ? command.params.maxHeight
                : 4096,
          });
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

  private created(target: FakeTarget): void {
    this.targets.push(target);
    for (const socket of this.sockets)
      socket.emit("Target.targetCreated", {
        targetInfo: {
          targetId: target.id,
          type: "page",
          title: target.title,
          url: target.url ?? "about:blank",
          attached: false,
          canAccessOpener: false,
        },
      });
  }
}
