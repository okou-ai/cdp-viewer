import { interval } from "signal-timers";
import type { CdpClient, CdpEvent } from "../cdp/client";
import { CdpFault, isRecord } from "../cdp/errors";
import type { TargetDirectory } from "../cdp/targets";
import { releaseRuntimeObjects } from "../cdp/runtime-objects";
import { iconExpression, iconScore, parseIcons } from "./favicon-declarations";
import { decodeFavicon } from "./favicon-image";
import type { FaviconImage } from "./favicon-image";

interface IconOwner {
  readonly targetId: string;
  sessionId: string | null;
  url: string | null;
  signature: string | null;
  revision: number;
  dirty: boolean;
  busy: boolean;
  failed: boolean;
  abort: AbortController;
  document: { frameId: string; loaderId: string; contextId: number } | null;
}

const byteLimit = 128 * 1024;

/** Optional, connection-owned work; it never activates or streams a target. */
export class FaviconDirectory {
  private readonly owners = new Map<string, IconOwner>();
  private readonly sessions = new Map<string, IconOwner>();
  private targets: readonly string[] = [];
  private paused = true;
  private disabled = false;
  private closed = false;
  private running = 0;

  constructor(
    private readonly client: CdpClient,
    private readonly directory: TargetDirectory,
    signal: AbortSignal,
    private readonly publish: (targetId: string, src: string | null) => void,
    private readonly decode: (
      blob: Blob,
      signal: AbortSignal,
    ) => Promise<FaviconImage> = decodeFavicon,
  ) {
    interval(() => this.poll(), 2_000, { signal });
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  reconcile(targets: readonly string[]): void {
    this.targets = targets
      .slice(0, 512)
      .filter((id) => this.directory.mayHaveFavicon(id));
    for (const owner of this.owners.values())
      if (!this.targets.includes(owner.targetId)) this.release(owner, true);
    if (this.paused || this.closed || this.disabled) return;
    for (const targetId of this.targets) {
      if (!this.owners.has(targetId))
        this.owners.set(targetId, {
          targetId,
          sessionId: null,
          url: null,
          signature: null,
          revision: 0,
          dirty: true,
          busy: false,
          failed: false,
          abort: new AbortController(),
          document: null,
        });
    }
    this.pump();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      for (const owner of this.owners.values()) this.release(owner, false);
    } else this.reconcile(this.targets);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const owner of this.owners.values()) this.release(owner, true);
  }

  event(event: CdpEvent): void {
    if (this.closed || this.paused || this.disabled) return;
    const params = event.params;
    if (event.method === "Target.targetDestroyed") {
      const owner = this.owners.get(String(params.targetId));
      if (owner) this.release(owner, true);
      return;
    }
    if (
      event.method === "Target.targetInfoChanged" &&
      isRecord(params.targetInfo)
    ) {
      const info = params.targetInfo;
      const owner = this.owners.get(String(info.targetId));
      if (owner?.url && typeof info.url === "string" && info.url !== owner.url)
        this.invalidate(owner);
      return;
    }
    const owner = this.sessions.get(
      event.method === "Target.detachedFromTarget"
        ? String(params.sessionId)
        : (event.sessionId ?? ""),
    );
    if (!owner) return;
    if (
      event.method === "Page.frameNavigated" &&
      isRecord(params.frame) &&
      !params.frame.parentId
    )
      this.invalidate(owner);
    else if (
      (event.method === "Page.navigatedWithinDocument" ||
        event.method === "Page.frameDetached") &&
      params.frameId === owner.document?.frameId
    )
      this.invalidate(owner);
    else if (event.method === "Target.detachedFromTarget") {
      owner.abort.abort();
      this.sessions.delete(owner.sessionId!);
      owner.sessionId = null;
      owner.failed = true;
      owner.revision++;
      this.publish(owner.targetId, null);
    }
  }

  private invalidate(owner: IconOwner): void {
    owner.abort.abort();
    owner.abort = new AbortController();
    owner.revision++;
    owner.signature = null;
    owner.document = null;
    owner.dirty = true;
    owner.failed = false;
    this.publish(owner.targetId, null);
    this.pump();
  }

  private poll(): void {
    if (this.closed || this.paused || this.disabled) return;
    for (const owner of this.owners.values()) owner.dirty = true;
    this.pump();
  }

  private current(owner: IconOwner, revision = owner.revision): boolean {
    return (
      !this.closed &&
      !this.paused &&
      !this.disabled &&
      this.owners.get(owner.targetId) === owner &&
      owner.revision === revision
    );
  }

  private release(owner: IconOwner, clear: boolean): void {
    this.owners.delete(owner.targetId);
    owner.abort.abort();
    owner.revision++;
    if (owner.sessionId) {
      this.sessions.delete(owner.sessionId);
      // Keep a busy session until its finally block can close session-local IO.
      if (!owner.busy) this.detach(owner);
    }
    if (clear) this.publish(owner.targetId, null);
  }

  private detach(owner: IconOwner): void {
    const sessionId = owner.sessionId;
    owner.sessionId = null;
    if (sessionId) this.client.notify("Target.detachFromTarget", { sessionId });
  }

  private pump(): void {
    for (const owner of this.owners.values()) {
      if (this.running === 4) break;
      if (!this.current(owner) || owner.busy || owner.failed || !owner.dirty)
        continue;
      owner.busy = true;
      // Rotate completed/slow targets so a large directory cannot starve its tail.
      this.owners.delete(owner.targetId);
      this.owners.set(owner.targetId, owner);
      owner.dirty = false;
      this.running++;
      const revision = owner.revision;
      this.inspect(owner, revision)
        .catch((error: unknown) => {
          // A few expired late-result owners must never exhaust the shared wire.
          if (
            error instanceof CdpFault &&
            (error.code === -32601 ||
              error.message === "The browser request timed out.")
          ) {
            this.disabled = true;
            for (const entry of this.owners.values()) this.release(entry, true);
            return;
          }
          if (!this.current(owner, revision)) return;
          owner.failed = true;
          this.publish(owner.targetId, null);
        })
        .finally(() => {
          owner.busy = false;
          if (!this.current(owner)) this.detach(owner);
          this.running--;
          this.pump();
        });
    }
  }

  private async attach(owner: IconOwner, revision: number): Promise<void> {
    await this.directory.assertMember(owner.targetId);
    if (!this.current(owner, revision)) return;
    const attached: unknown = await this.client.request(
      "Target.attachToTarget",
      { targetId: owner.targetId, flatten: true },
      undefined,
      (late) => {
        if (isRecord(late) && typeof late.sessionId === "string")
          this.client.notify("Target.detachFromTarget", {
            sessionId: late.sessionId,
          });
      },
    );
    if (
      !isRecord(attached) ||
      typeof attached.sessionId !== "string" ||
      !attached.sessionId
    )
      throw new Error("Invalid optional icon session.");
    if (!this.current(owner, revision)) {
      this.client.notify("Target.detachFromTarget", {
        sessionId: attached.sessionId,
      });
      return;
    }
    owner.sessionId = attached.sessionId;
    this.sessions.set(attached.sessionId, owner);
    await this.client.request("Page.enable", undefined, attached.sessionId);
  }

  private async read(owner: IconOwner, revision: number) {
    if (!this.current(owner, revision) || !owner.sessionId) return null;
    const sessionId = owner.sessionId;
    const document = owner.document ?? (await this.document(owner, revision));
    if (!document || !this.current(owner, revision)) return null;
    const release = (value: unknown) =>
      releaseRuntimeObjects(this.client, sessionId, value);
    const result = await this.client.request(
      "Runtime.evaluate",
      {
        expression: iconExpression,
        contextId: document.contextId,
        returnByValue: true,
        timeout: 1_000,
      },
      sessionId,
      release,
    );
    release(result);
    if (!this.current(owner, revision) || result.exceptionDetails) return null;
    const icons = parseIcons(result.result.value);
    return icons
      ? {
          frameId: document.frameId,
          icons,
          signature: JSON.stringify([
            document.frameId,
            document.loaderId,
            icons,
          ]),
        }
      : null;
  }

  private async document(owner: IconOwner, revision: number) {
    const sessionId = owner.sessionId;
    if (!sessionId) return null;
    const tree: unknown = await this.client.request(
      "Page.getFrameTree",
      undefined,
      sessionId,
    );
    if (!this.current(owner, revision)) return null;
    if (
      !isRecord(tree) ||
      !isRecord(tree.frameTree) ||
      !isRecord(tree.frameTree.frame)
    )
      return null;
    const frame = tree.frameTree.frame;
    if (
      typeof frame.id !== "string" ||
      !frame.id ||
      typeof frame.loaderId !== "string" ||
      !frame.loaderId
    )
      return null;
    const world = await this.client.request(
      "Page.createIsolatedWorld",
      {
        frameId: frame.id,
        worldName: "cdp-viewer-favicons",
      },
      sessionId,
    );
    if (!this.current(owner, revision)) return null;
    if (!Number.isSafeInteger(world.executionContextId)) return null;
    owner.document = {
      frameId: frame.id,
      loaderId: frame.loaderId,
      contextId: world.executionContextId,
    };
    return owner.document;
  }

  private async inspect(owner: IconOwner, revision: number): Promise<void> {
    if (!owner.sessionId) await this.attach(owner, revision);
    if (!this.current(owner, revision)) return;
    await this.directory.assertMember(owner.targetId);
    if (!this.current(owner, revision)) return;
    const page = await this.read(owner, revision);
    if (!page || !this.current(owner, revision)) return;
    owner.url = page.icons.url;
    if (owner.signature === page.signature) return;
    this.publish(owner.targetId, null);
    let best: FaviconImage | null = null;
    const signal = AbortSignal.any([
      owner.abort.signal,
      AbortSignal.timeout(5_000),
    ]);
    // The last entry may be the extra conventional /favicon.ico fallback.
    for (const candidate of page.icons.candidates) {
      if (candidate.fallback && best) break;
      if (!this.current(owner, revision)) return;
      try {
        const blob = await this.load(
          owner,
          revision,
          page.frameId,
          candidate.url,
        );
        if (!blob || !this.current(owner, revision)) continue;
        const image = await this.decode(blob, signal);
        if (!this.current(owner, revision)) return;
        if (!best || iconScore(image.size) < iconScore(best.size)) best = image;
        if (image.size === 0 || image.size === 16) break;
      } catch (error) {
        if (error instanceof CdpFault) throw error;
        // Invalid/unsupported images do not affect the stream or other tabs.
      }
    }
    const confirmed = await this.read(owner, revision);
    if (!confirmed || !this.current(owner, revision)) return;
    if (confirmed.signature !== page.signature) {
      owner.dirty = true;
      return;
    }
    await this.directory.assertMember(owner.targetId);
    if (!this.current(owner, revision)) return;
    owner.signature = page.signature;
    this.publish(owner.targetId, best?.src ?? null);
  }

  private async load(
    owner: IconOwner,
    revision: number,
    frameId: string,
    url: string,
  ): Promise<Blob | null> {
    if (url.startsWith("data:")) {
      const match =
        /^data:(image\/[\w.+-]+)(?:;charset=[\w-]+)?(;base64)?,(.*)$/s.exec(
          url,
        );
      if (!match) return null;
      const value = match[2] ? atob(match[3]!) : decodeURIComponent(match[3]!);
      const bytes = match[2]
        ? Uint8Array.from(value, (c) => c.charCodeAt(0))
        : new TextEncoder().encode(value);
      return bytes.length <= byteLimit
        ? new Blob([bytes], { type: match[1]! })
        : null;
    }
    const sessionId = owner.sessionId!;
    const result = await this.client.request(
      "Network.loadNetworkResource",
      {
        frameId,
        url,
        options: { disableCache: false, includeCredentials: true },
      },
      sessionId,
      (late) => {
        if (
          isRecord(late) &&
          isRecord(late.resource) &&
          typeof late.resource.stream === "string"
        )
          this.client.notify(
            "IO.close",
            { handle: late.resource.stream },
            sessionId,
          );
      },
    );
    const resource: unknown = result.resource;
    if (!isRecord(resource)) return null;
    const handle = typeof resource.stream === "string" ? resource.stream : null;
    try {
      if (!handle || !resource.success || !this.current(owner, revision))
        return null;
      const contentType = Object.entries(
        isRecord(resource.headers) ? resource.headers : {},
      ).find(([name]) => name.toLowerCase() === "content-type")?.[1];
      const mime =
        typeof contentType === "string"
          ? contentType.split(";")[0]!.trim().toLowerCase()
          : "application/octet-stream";
      if (!mime.startsWith("image/") && mime !== "application/octet-stream")
        return null;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      // Bound empty/non-final responses too, even from an invalid peer.
      for (let reads = 0; reads < 8 && this.current(owner, revision); reads++) {
        const chunk = await this.client.request(
          "IO.read",
          {
            handle,
            size: 32 * 1024,
          },
          sessionId,
        );
        if (chunk.data.length > 48 * 1024) return null;
        const bytes = chunk.base64Encoded
          ? Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(chunk.data);
        size += bytes.byteLength;
        if (size > byteLimit) return null;
        chunks.push(bytes);
        if (chunk.eof) return new Blob(chunks, { type: mime });
      }
      return null;
    } finally {
      if (handle) this.client.notify("IO.close", { handle }, sessionId);
    }
  }
}
