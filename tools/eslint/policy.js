import plugin from "./index.js";

const privateContextImport = Object.freeze({
  name: "ccstate-react",
  allowTypeImports: true,
  message:
    "Use the private instance scope so library state never binds to the host provider.",
});

// Capabilities are granted at primitive definition sites, never to directories.
// See docs/state-architecture.md before changing an entry.
const primitiveCapabilities = Object.freeze([
  {
    files: ["src/state/instance.ts"],
    rules: { "ccstate/no-create-store": "off" },
  },
  {
    files: ["src/cdp/client.ts"],
    rules: {
      "ccstate/no-new-abort-controller": "off",
      "ccstate/no-new-promise": "off",
    },
  },
  {
    files: [
      "src/viewer/controller.ts",
      "src/viewer/favicons.ts",
      "src/input/native.ts",
    ],
    rules: { "ccstate/no-new-abort-controller": "off" },
  },
]);

export const architecture = [
  {
    files: ["src/**/*.{ts,tsx}", "demo/**/*.{ts,tsx}"],
    plugins: { ccstate: plugin },
    rules: {
      ...Object.fromEntries(
        Object.keys(plugin.rules)
          .filter((name) => !["no-catch-abort", "view-writes"].includes(name))
          .map((name) => ["ccstate/" + name, "error"]),
      ),
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              allowTypeImports: true,
              message:
                "React primitives belong to the exact private bridge/runtime definitions.",
            },
            privateContextImport,
          ],
          patterns: [
            {
              group: ["react/*", "ccstate/*", "ccstate-react/*"],
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // Async signal commands use AbortSignal cancellation; the wire/native engines
  // use their documented captured owners and protocol-specific recovery instead.
  {
    files: ["src/viewer/model.ts", "demo/model.ts", "src/state/instance.ts"],
    rules: { "ccstate/no-catch-abort": "error" },
  },
  ...primitiveCapabilities,
  ...[
    [
      "src/state/react.tsx",
      [
        "createContext",
        "useCallback",
        "useContext",
        "useId",
        "useState",
        "useSyncExternalStore",
      ],
    ],
    [
      "src/react/runtime.tsx",
      [
        "createContext",
        "useContext",
        "useEffect",
        "useLayoutEffect",
        "useMemo",
        "useRef",
      ],
    ],
  ].map(([file, hooks]) => ({
    files: [file],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", allowImportNames: hooks, allowTypeImports: true },
            privateContextImport,
          ],
          patterns: [
            {
              group: ["react/*", "ccstate/*", "ccstate-react/*"],
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  })),
  {
    files: ["src/**/*.tsx", "demo/**/*.tsx"],
    ignores: ["src/state/react.tsx", "src/react/runtime.tsx"],
    rules: {
      "ccstate/view-writes": "error",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              allowTypeImports: true,
              message:
                "Use private ccstate scope reads/commands. React state/effects belong only to the named bootstrap/runtime adapters.",
            },
            {
              name: "ccstate",
              allowTypeImports: true,
              message:
                "Construct signal graphs in their model owner, outside views.",
            },
            privateContextImport,
          ],
          patterns: [
            {
              group: [
                "react/*",
                "ccstate/*",
                "ccstate-react/*",
                "**/cdp/*",
                "**/input/*",
                "**/render/*",
                "**/viewer/controller",
                "**/viewer/controller.*",
              ],
              allowTypeImports: true,
              message: "Views must not acquire or control runtime resources.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "globalThis",
          "fetch",
          "WebSocket",
          "localStorage",
          "sessionStorage",
        ].map((name) => ({
          name,
          message:
            "Keep browser resources in their owned primitive, not a view.",
        })),
      ],
    },
  },
  {
    files: ["demo/main.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              allowImportNames: ["StrictMode"],
              allowTypeImports: true,
            },
            { name: "ccstate", allowTypeImports: true },
            privateContextImport,
          ],
          patterns: [
            {
              group: ["react/*", "ccstate/*", "ccstate-react/*"],
              allowTypeImports: true,
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "globalThis",
          "fetch",
          "WebSocket",
          "localStorage",
          "sessionStorage",
        ].map((name) => ({ name })),
      ],
    },
  },
];
