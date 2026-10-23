import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A native test fixture outside the source tree, with its own dependencies. */
export async function prepareConsumer() {
  const directory = await mkdtemp(join(tmpdir(), "cdp-viewer-consumer-"));
  const run = (args) => {
    try {
      return execFileSync("pnpm", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      throw new Error("Consumer pnpm failed:\n" + error.stdout + error.stderr, {
        cause: error,
      });
    }
  };
  try {
    const mode = process.env.CDP_VIEWER_CONSUMER_SOURCE ?? "github";
    if (!["github", "tarball"].includes(mode)) {
      throw new Error("Consumer source must be github or tarball.");
    }
    let specifier;
    if (mode === "tarball") {
      const tarball = join(directory, "viewer.tgz");
      execFileSync("pnpm", ["pack", "--out", tarball], {
        cwd: root,
        stdio: "pipe",
      });
      specifier = "file:" + tarball;
    } else {
      const repository =
        process.env.CDP_VIEWER_SOURCE_REPO ?? "okou-ai/cdp-viewer";
      const sha =
        process.env.CDP_VIEWER_SOURCE_SHA ??
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
      if (
        !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
        !/^[a-f0-9]{40}$/.test(sha)
      ) {
        throw new Error(
          "A GitHub repository and full commit SHA are required.",
        );
      }
      specifier = "github:" + repository + "#" + sha;
    }
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
          packageManager: "pnpm@10.33.4",
          dependencies: {
            "cdp-viewer": specifier,
            react: "19.2.6",
            "react-dom": "19.2.6",
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
    const packageManager = run(["--version"]).trim();
    if (packageManager !== "10.33.4") {
      throw new Error("The external consumer must run pnpm 10.33.4.");
    }
    const install = [
      "install",
      "--ignore-workspace",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
    ];
    run(install);
    const lockfile = await readFile(join(directory, "pnpm-lock.yaml"), "utf8");
    if (!lockfile.includes(specifier)) {
      throw new Error(
        "The consumer lockfile does not record the selected source.",
      );
    }
    await rm(join(directory, "node_modules"), { recursive: true, force: true });
    run([...install, "--frozen-lockfile", "--offline"]);
    if (
      (await readFile(join(directory, "pnpm-lock.yaml"), "utf8")) !== lockfile
    ) {
      throw new Error("Frozen reinstall changed the consumer lockfile.");
    }
    const installed = join(directory, "node_modules/cdp-viewer");
    const manifest = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    const entry = manifest.exports?.["."];
    const stylesheet = manifest.exports?.["./style.css"];
    if (
      manifest.private !== true ||
      manifest.dependencies?.react ||
      manifest.dependencies?.["react-dom"] ||
      !manifest.peerDependencies?.react ||
      !manifest.peerDependencies?.["react-dom"] ||
      !entry?.import?.startsWith("./src/") ||
      !entry?.types?.startsWith("./src/") ||
      !stylesheet?.startsWith("./styles/") ||
      ["prepare", "preinstall", "install", "postinstall"].some(
        (name) => manifest.scripts?.[name],
      )
    ) {
      throw new Error(
        "Installed source exports, CSS, React peers or hooks are invalid.",
      );
    }
    for (const file of [entry.import, entry.types, stylesheet]) {
      if (!(await readFile(join(installed, file), "utf8")).trim()) {
        throw new Error("An installed public source/CSS entry is empty.");
      }
    }
    for (const subpath of ["./extensions", "./extensions/browser-use"]) {
      const extension = manifest.exports?.[subpath];
      if (
        !extension?.import?.startsWith("./src/") ||
        !extension?.types?.startsWith("./src/")
      ) {
        throw new Error("Installed extension source/type exports are invalid.");
      }
      for (const file of [extension.import, extension.types]) {
        if (!(await readFile(join(installed, file), "utf8")).trim()) {
          throw new Error("An installed extension entry is empty.");
        }
      }
    }
    // Check ordinary inline file links against the installed package, not the checkout.
    const readme = await readFile(join(installed, "README.md"), "utf8");
    for (const [, href] of readme.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
      const file = resolve(
        installed,
        decodeURIComponent(href.split(/[?#]/)[0]),
      );
      if (
        !file.startsWith(installed + sep) ||
        !(await stat(file).catch(() => null))?.isFile()
      ) {
        throw new Error(
          "Installed README links to an unavailable file: " + href,
        );
      }
    }
    run(["exec", "tsc", "--noEmit"]);
    run(["exec", "vite", "build"]);
    // Bundle source for SSR; plain Node is not a TSX compiler.
    run(["exec", "vite", "build", "--ssr", "ssr.tsx", "--outDir", "ssr-dist"]);
    run([
      "exec",
      "node",
      "--input-type=module",
      "-e",
      "globalThis.WebSocket = class { constructor() { throw new Error('SSR opened a connection'); } }; const m = await import('./ssr-dist/ssr.js'); if (!m.renderViewer().includes('Remote browser viewer')) throw new Error('SSR did not render the public viewer')",
    ]);
    return {
      directory,
      dist: join(directory, "dist"),
      receipt: {
        source: mode,
        specifier,
        packageManager,
        react: "19.2.6",
        lifecycleScripts: false,
        frozenReinstall: true,
        lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
        documentationLinks: true,
        publicTypes: true,
        extensionExports: true,
        build: true,
        ssr: true,
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function writePackageReceipt(consumer) {
  const output = join(root, "test-results/package");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(consumer.receipt, null, 2),
  );
  console.log(
    "External " +
      consumer.receipt.source +
      " consumer passed: pnpm 10.33.4, source types/CSS, frozen reinstall, React 19.2.6 build and SSR.",
  );
}

export async function savePackageReceipt() {
  const consumer = await prepareConsumer();
  try {
    await writePackageReceipt(consumer);
  } finally {
    await consumer.cleanup();
  }
}
