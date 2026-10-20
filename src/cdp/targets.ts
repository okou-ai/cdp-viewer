import type { ViewerTarget } from "../viewer/types";
import { CdpClient } from "./client";
import { CdpFault, isRecord } from "./errors";

export class TargetDirectory {
  constructor(
    private readonly client: CdpClient,
    private readonly windowId: number | undefined,
  ) {}

  async assertMember(targetId: string): Promise<void> {
    if (this.windowId === undefined) return;
    let result: unknown;
    try {
      result = await this.client.request("Browser.getWindowForTarget", {
        targetId,
      });
    } catch (error) {
      throw new CdpFault(
        error instanceof CdpFault && error.code === -32601
          ? "unsupported-capability"
          : "scope",
        "Window membership could not be verified. Scoped viewing is unavailable.",
      );
    }
    if (!isRecord(result) || !Number.isSafeInteger(result.windowId)) {
      throw new CdpFault(
        "scope",
        "The browser returned invalid window membership.",
      );
    }
    if (result.windowId !== this.windowId) {
      throw new CdpFault(
        "scope",
        "This target is outside the selected window.",
      );
    }
  }

  async list(): Promise<readonly ViewerTarget[]> {
    const raw: unknown = await this.client.request(
      "Target.getTargets",
      undefined,
    );
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.targetInfos) ||
      raw.targetInfos.length > 512
    ) {
      throw new CdpFault(
        "protocol",
        "Invalid or oversized browser target list.",
      );
    }
    const pages: ViewerTarget[] = [];
    for (const info of raw.targetInfos as unknown[]) {
      if (
        !isRecord(info) ||
        info.type !== "page" ||
        info.subtype === "prerender"
      )
        continue;
      if (typeof info.targetId !== "string" || !info.targetId) {
        throw new CdpFault(
          "protocol",
          "The browser returned an invalid page target.",
        );
      }
      pages.push(
        Object.freeze({
          id: info.targetId,
          title:
            typeof info.title === "string" && info.title.trim()
              ? info.title.slice(0, 512)
              : "Untitled page",
        }),
      );
    }
    if (this.windowId === undefined) return Object.freeze(pages);

    const members: ViewerTarget[] = [];
    // Avoid an unbounded fan-out into the transport's request map.
    for (let offset = 0; offset < pages.length; offset += 4) {
      const results = await Promise.all(
        pages.slice(offset, offset + 4).map(async (page) => {
          const result: unknown = await this.lookup(page.id);
          if (!isRecord(result) || !Number.isSafeInteger(result.windowId)) {
            throw new CdpFault(
              "scope",
              "The browser returned invalid window membership.",
            );
          }
          return result.windowId === this.windowId ? page : null;
        }),
      );
      for (const page of results) if (page) members.push(page);
    }
    return Object.freeze(members);
  }

  private async lookup(targetId: string): Promise<unknown> {
    try {
      return await this.client.request("Browser.getWindowForTarget", {
        targetId,
      });
    } catch (error) {
      throw new CdpFault(
        error instanceof CdpFault && error.code === -32601
          ? "unsupported-capability"
          : "scope",
        "Window membership could not be verified. Scoped viewing is unavailable.",
      );
    }
  }
}
