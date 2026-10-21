import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  use: {
    headless: true,
    trace: "retain-on-failure",
    launchOptions: process.env.CDP_VIEWER_CHROMIUM
      ? { executablePath: process.env.CDP_VIEWER_CHROMIUM }
      : {},
  },
});
