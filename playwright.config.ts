import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  webServer: {
    command: "node scripts/fixture-server.mjs",
    url: "http://127.0.0.1:4174/products.html",
    reuseExistingServer: true,
    timeout: 10_000
  },
  use: { trace: "retain-on-failure" }
});
