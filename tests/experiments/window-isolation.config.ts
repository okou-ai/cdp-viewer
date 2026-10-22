import { defineConfig } from "@playwright/test";
import browserConfig from "../../playwright.config";

// Explicit capability probe, outside default browser correctness CI.
export default defineConfig({
  ...browserConfig,
  testDir: ".",
  testMatch: "windows.spec.ts",
  globalSetup: "../browser/setup.ts",
  outputDir: "../../test-results/window-isolation",
});
