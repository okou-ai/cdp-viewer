import { defineConfig } from "@playwright/test";
import browserConfig from "../../playwright.config";

// Explicit measurement, outside default correctness CI. No credential-bearing traces.
export default defineConfig({
  ...browserConfig,
  testDir: ".",
  testMatch: "transport.spec.ts",
  globalSetup: "../browser/setup.ts",
  outputDir: "../../test-results/transport",
  timeout: 180_000,
  use: { ...browserConfig.use, trace: "off" },
});
