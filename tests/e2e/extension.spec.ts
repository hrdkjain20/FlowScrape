import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import path from "node:path";

let context: BrowserContext;
let extensionWorker: Worker;
test.beforeAll(async () => {
  const extensionPath = path.resolve("dist");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  extensionWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
});
test.afterAll(async () => context?.close());

test("loads the MV3 worker, privacy page, and React side panel", async () => {
  const extensionId = new URL(extensionWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/privacy/index.html`);
  await expect(page.getByRole("heading", { name: "FlowScrape privacy & threat model" })).toBeVisible();
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await expect(page.getByRole("heading", { name: "FlowScrape" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Smart detect" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "AI cleanup · Groq" })).toBeVisible();
  await expect(page.getByLabel("Groq API key")).toHaveAttribute("type", "password");
  await expect(page.getByText("Not configured")).toBeVisible();
});
