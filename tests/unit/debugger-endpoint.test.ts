// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { waitForDebuggerEndpoint } from "../browser/debugger-endpoint";

const profiles: string[] = [];
const owners: AbortController[] = [];
afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.abort());
  await Promise.all(
    profiles
      .splice(0)
      .map((profile) => rm(profile, { recursive: true, force: true })),
  );
});

async function fixture() {
  await mkdir("test-results", { recursive: true });
  const profile = await mkdtemp("test-results/debugger-endpoint-");
  profiles.push(profile);
  const owner = new AbortController();
  owners.push(owner);
  return { profile, owner, file: join(profile, "DevToolsActivePort") };
}

it("reads an endpoint published before the readiness check", async () => {
  const { profile, file, owner } = await fixture();
  await writeFile(file, "9222\n/devtools/browser/owned-fixture");
  await expect(waitForDebuggerEndpoint(profile, owner.signal)).resolves.toBe(
    "ws://127.0.0.1:9222/devtools/browser/owned-fixture",
  );
});

it("observes endpoint publication after the readiness check starts", async () => {
  const { profile, file, owner } = await fixture();
  const ready = waitForDebuggerEndpoint(profile, owner.signal);
  await writeFile(file, "9222\n/devtools/browser/owned-fixture");
  await expect(ready).resolves.toBe(
    "ws://127.0.0.1:9222/devtools/browser/owned-fixture",
  );
});

it("waits for the endpoint path after a partial port file", async () => {
  const { profile, file, owner } = await fixture();
  await writeFile(file, "9222\n");
  const ready = waitForDebuggerEndpoint(profile, owner.signal);
  await writeFile(file, "9222\n/devtools/browser/owned-fixture");
  await expect(ready).resolves.toBe(
    "ws://127.0.0.1:9222/devtools/browser/owned-fixture",
  );
});

it("cancels an unpublished endpoint instead of failing on a missing file", async () => {
  const { profile, owner } = await fixture();
  const ready = waitForDebuggerEndpoint(profile, owner.signal);
  const rejected = expect(ready).rejects.toMatchObject({ name: "AbortError" });
  owner.abort();
  await rejected;
});

it("preserves filesystem errors other than a file not yet published", async () => {
  const { profile, file, owner } = await fixture();
  await mkdir(file);
  await expect(
    waitForDebuggerEndpoint(profile, owner.signal),
  ).rejects.toMatchObject({ code: "EISDIR" });
});
