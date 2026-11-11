import { defineConfig } from "@playwright/test";

// E2E drives the real Electron build. Run via `npm run e2e`, which wraps it in xvfb-run so
// nothing ever opens on the live desktop (spec PERF-6).
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
});
