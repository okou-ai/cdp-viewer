import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A native test fixture outside the source tree, with its own installed dependencies. */
export async function prepareConsumer() {
  const directory = await mkdtemp(join(tmpdir(), "cdp-viewer-consumer-"));
  const run = (args) =>
    execFileSync("pnpm", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    });
  try {
    const tarball = join(directory, "viewer.tgz");
    execFileSync("pnpm", ["pack", "--out", tarball], {
      cwd: root,
      stdio: "pipe",
    });
    await cp(join(root, "tests/consumer"), directory, { recursive: true });
    const version = async (name) =>
      JSON.parse(
        await readFile(
          join(root, "node_modules", name, "package.json"),
          "utf8",
        ),
      ).version;
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify(
        {
          name: "cdp-viewer-external-consumer",
          private: true,
          type: "module",
          packageManager: "pnpm@12.14.0",
          dependencies: {
            "cdp-viewer": "file:" + tarball,
            react: "19.2.0",
            "react-dom": "19.2.0",
            ccstate: "6.0.0",
            "ccstate-react": "6.0.0",
          },
          devDependencies: {
            vite: await version("vite"),
            typescript: await version("typescript"),
            "@types/react": await version("@types/react"),
            "@types/react-dom": await version("@types/react-dom"),
          },
        },
        null,
        2,
      ),
    );
    run(["install", "--ignore-workspace", "--ignore-scripts"]);
    run(["exec", "tsc", "--noEmit"]);
    run(["exec", "vite", "build"]);
    // Importing the packed root on Node must not open a browser connection.
    run([
      "exec",
      "node",
      "--input-type=module",
      "-e",
      "const m = await import('cdp-viewer'); if (typeof m.CdpViewer !== 'function') throw new Error('Missing public component')",
    ]);
    const manifest = JSON.parse(
      await readFile(
        join(directory, "node_modules/cdp-viewer/package.json"),
        "utf8",
      ),
    );
    if (
      manifest.dependencies?.react ||
      !manifest.peerDependencies?.react ||
      !manifest.exports?.["./style.css"]
    ) {
      throw new Error("Packed React peers and stylesheet exports are invalid.");
    }
    return {
      directory,
      dist: join(directory, "dist"),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function savePackageReceipt() {
  const consumer = await prepareConsumer();
  try {
    const output = join(root, "test-results/package");
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, "receipt.json"),
      JSON.stringify(
        {
          react: "19.2.0",
          publicTypes: true,
          build: true,
          nodeImport: true,
          hostCcstateConsumerCompiled: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "Packed consumer: public types, React 19.2, CSS export, build and Node import passed.",
    );
  } finally {
    await consumer.cleanup();
  }
}
