import plugin from "./index.js";

const privateContextImport = Object.freeze({
  name: "ccstate-react",
  allowTypeImports: true,
  message:
    "Use the private instance scope so library state never binds to the host provider.",
});

// One contract for every production file; capabilities never depend on a filename.
export const architecture = [
  {
    files: ["src/**/*.{ts,tsx}", "demo/**/*.{ts,tsx}"],
    plugins: { ccstate: plugin },
    rules: {
      ...Object.fromEntries(
        Object.keys(plugin.rules).map((name) => ["ccstate/" + name, "error"]),
      ),
      "no-restricted-properties": [
        "error",
        { property: "setState", message: "Keep semantic state in ccstate." },
        {
          property: "forceUpdate",
          message: "Observe ccstate through the external-store subscription.",
        },
      ],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              allowImportNames: [
                "Component",
                "createContext",
                "useContext",
                "useId",
                "useSyncExternalStore",
                "StrictMode",
              ],
              allowTypeImports: true,
              message:
                "Keep semantic state in ccstate and resources in committed instance lifetimes.",
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
  {
    files: ["src/**/*.tsx", "demo/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              allowImportNames: [
                "Component",
                "createContext",
                "useContext",
                "useId",
                "useSyncExternalStore",
                "StrictMode",
              ],
              allowTypeImports: true,
              message:
                "Keep semantic state in ccstate and resources in committed instance lifetimes.",
            },
            {
              name: "ccstate",
              allowTypeImports: true,
              message:
                "Construct signal graphs in their model factory, outside views.",
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
            "Keep browser resources in a committed owner, outside views.",
        })),
      ],
    },
  },
];
