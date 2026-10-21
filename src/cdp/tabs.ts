import type { CdpClient } from "./client";
import { CdpFault, isRecord } from "./errors";
import type { TargetDirectory } from "./targets";

/** One explicit create, with cleanup bound to the original transport/session. */
export async function openTab(
  client: CdpClient,
  directory: TargetDirectory,
  source: { targetId: string; sessionId: string } | null,
  current: () => boolean,
): Promise<string> {
  const check = () => {
    if (!current())
      throw new CdpFault("tab", "The tab action is no longer current.");
  };
  check();
  let targetId: string;
  if (!source) {
    const created = await client.request("Target.createTarget", {
      url: "about:blank",
    });
    check();
    targetId = created.targetId;
  } else {
    await directory.assertMember(source.targetId);
    check();
    const tree = await client.request(
      "Page.getFrameTree",
      undefined,
      source.sessionId,
    );
    check();
    const world = await client.request(
      "Page.createIsolatedWorld",
      {
        frameId: tree.frameTree.frame.id,
        worldName: "cdp-viewer-tabs",
      },
      source.sessionId,
    );
    check();
    await directory.assertMember(source.targetId);
    check();
    // getRandomValues also works in HTTP hosts where randomUUID is unavailable.
    const token = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const marker = `about:blank#cdpv-${token}`;
    const release = (value: unknown) => {
      if (!isRecord(value)) return;
      for (const remote of [
        value.result,
        isRecord(value.exceptionDetails)
          ? value.exceptionDetails.exception
          : null,
      ]) {
        if (isRecord(remote) && typeof remote.objectId === "string")
          client.notify(
            "Runtime.releaseObject",
            { objectId: remote.objectId },
            source.sessionId,
          );
      }
    };
    const result = await client.request(
      "Runtime.evaluate",
      {
        expression: `(() => { const tab = window.open(${JSON.stringify(marker)}, "_blank"); if (tab) tab.opener = null; return !!tab; })()`,
        contextId: world.executionContextId,
        userGesture: true,
        returnByValue: true,
      },
      source.sessionId,
      release,
    );
    release(result);
    check();
    if (result.exceptionDetails || result.result.value !== true)
      throw new CdpFault(
        "tab",
        "The browser blocked the new tab. Check the page's popup or sandbox policy.",
      );
    const targets = await client.request("Target.getTargets", undefined);
    check();
    const matches = targets.targetInfos.filter(
      (target) => target.type === "page" && target.url === marker,
    );
    if (matches.length !== 1 || !matches[0])
      throw new CdpFault(
        "tab",
        "The new tab could not be identified. Check the browser before trying again.",
      );
    targetId = matches[0].targetId;
  }
  if (typeof targetId !== "string" || !targetId)
    throw new CdpFault("tab", "The browser returned an invalid new tab.");
  await directory.assertMember(targetId);
  check();
  if (!source) return targetId;
  const detach = (value: unknown) => {
    if (isRecord(value) && typeof value.sessionId === "string")
      client.notify("Target.detachFromTarget", { sessionId: value.sessionId });
  };
  const attached = await client.request(
    "Target.attachToTarget",
    { targetId, flatten: true },
    undefined,
    detach,
  );
  if (
    !isRecord(attached) ||
    typeof attached.sessionId !== "string" ||
    !attached.sessionId
  )
    throw new CdpFault(
      "tab",
      "The browser returned an invalid new-tab session.",
    );
  try {
    check();
    await directory.assertMember(targetId);
    check();
    const navigation = await client.request(
      "Page.navigate",
      { url: "about:blank" },
      attached.sessionId,
    );
    check();
    if (navigation.errorText)
      throw new CdpFault(
        "tab",
        "The new tab could not be prepared. Check the browser before trying again.",
      );
    return targetId;
  } finally {
    detach(attached);
  }
}
