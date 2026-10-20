import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { build } from "vite";

const mode = process.argv[2];
if (!["--write", "--check"].includes(mode)) {
  throw new Error("Use --write or --check for the committed stylesheet.");
}
const result = await build({ logLevel: "silent", build: { write: false } });
const bundles = Array.isArray(result) ? result : [result];
const asset = bundles
  .flatMap((bundle) => bundle.output)
  .find((entry) => entry.type === "asset" && entry.fileName === "style.css");
if (!asset || typeof asset.source !== "string") {
  throw new Error("The library build did not produce its stylesheet.");
}
const expected = await format(asset.source, { parser: "css" });
const target = new URL("../styles/viewer.css", import.meta.url);
if (mode === "--write") {
  await mkdir(fileURLToPath(new URL("../styles/", import.meta.url)), {
    recursive: true,
  });
  await writeFile(target, expected);
} else if ((await readFile(target, "utf8")) !== expected) {
  throw new Error("Committed CSS is stale. Run pnpm css:write and commit it.");
}
console.log("Committed viewer CSS matches its source.");
