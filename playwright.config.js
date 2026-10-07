import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir: process.env.TAB_DEDUP_TEST_OUTPUT || "test-results",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
