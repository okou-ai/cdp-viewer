import { execFileSync } from "node:child_process";

/** Each independently selected experiment entrypoint requires matched runtime. */
export function assertExperimentSource(): void {
  const source = process.env.CDP_VIEWER_SOURCE_SHA;
  if (!source || !/^[a-f0-9]{40}$/.test(source))
    throw new Error("Set an explicit immutable public consumer source SHA");
  execFileSync("git", ["diff", "--exit-code", source, "--", "src", "styles"]);
}
