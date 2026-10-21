import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";
import { architecture } from "./tools/eslint/policy.js";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "codex-work/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "react-hooks": hooks,
      "jsx-a11y": a11y,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...hooks.configs.recommended.rules,
      ...a11y.configs.recommended.rules,
    },
  },
  ...architecture,
];
