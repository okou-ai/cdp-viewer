import { expect, test } from "@playwright/test";
import { launchBackend, serveBrowserConsumer } from "./backend";
import type {} from "../consumer/api";

let server: Awaited<ReturnType<typeof serveBrowserConsumer>>;
test.beforeAll(async () => {
  server = await serveBrowserConsumer();
});
test.afterAll(async () => {
  await server?.close();
});

test("a custom adapter from the installed public SDK follows a live page event", async ({
  page,
}, info) => {
  const backend = await launchBackend(
    info.outputPath("backend"),
    server.origin,
  );
  try {
    const remote = await backend.context.newPage();
    await remote.goto(server.origin + "/fixture/red");
    await backend.session.send("Target.createTarget", {
      url: server.origin + "/fixture/blue",
      newWindow: true,
    });
    await expect(remote).toHaveTitle("rgb(232,32,48)");
    await page.goto(server.origin);
    await page.waitForFunction(
      () => typeof window.configureViewers === "function",
    );
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      second: false,
      extensions: true,
    });
    const viewer = page.locator("#viewer-a section");
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await viewer.getByRole("tab", { name: "rgb(24,80,224)" }).click();
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    await expect(viewer.getByRole("tab", { selected: true })).toHaveText(
      "rgb(24,80,224)",
    );
    await remote.evaluate(() => {
      document.title = "Adapter selected page";
    });
    await expect(viewer.getByRole("tab", { selected: true })).toHaveText(
      "Adapter selected page",
    );
    await expect(viewer).toHaveAttribute("data-status", "streaming");
    // Removing adapters keeps the current stream but stops automatic selection.
    await page.evaluate((settings) => window.configureViewers!(settings), {
      cdpUrl: backend.endpoint,
      second: false,
      extensions: false,
    });
    await expect(page.locator("#host-shell")).toHaveAttribute(
      "data-extensions",
      "off",
    );
    await viewer.getByRole("tab", { name: "rgb(24,80,224)" }).click();
    await remote.evaluate(() => {
      document.title = "Adapter should stay ignored";
    });
    await expect(
      viewer.getByRole("tab", { name: "Adapter should stay ignored" }),
    ).toBeVisible();
    await expect(viewer.getByRole("tab", { selected: true })).toHaveText(
      "rgb(24,80,224)",
    );
    await expect(viewer).toHaveAttribute("data-status", "streaming");
  } finally {
    await backend.close();
  }
});
