import { defineConfig } from "@playwright/test";

// Explicit experiment, outside the default browser correctness suite.
export default defineConfig({
  testDir: ".",
  testMatch: "adjacent-input.spec.ts",
  outputDir: "../../test-results/adjacent-input",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  retries: 0,
  use: { headless: true, trace: "off" },
});
