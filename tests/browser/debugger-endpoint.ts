import { on } from "node:events";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Chromium's listening log can precede publication of its port file. */
export async function waitForDebuggerEndpoint(
  profile: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const watcher = watch(profile);
  const changes = on(watcher, "change", { signal });
  try {
    for (;;) {
      let contents = "";
      try {
        contents = await readFile(resolve(profile, "DevToolsActivePort"), {
          encoding: "utf8",
          signal,
        });
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      const [port, path] = contents.trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
      await changes.next();
    }
  } finally {
    watcher.close();
    await changes.return?.();
  }
}
