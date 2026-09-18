import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3100;
const ci = process.env.CI !== undefined;

// The app runs on localhost:5173 because that is the allowed origin of the fixture app it signs in as.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: ci,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node --env-file-if-exists=../../.env.local --experimental-strip-types src/server.ts",
      url: `http://127.0.0.1:${API_PORT}/v1/openapi.json`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Mode e2e reads apps/web/.env.e2e, which points the app at the test API above.
      command: "pnpm --filter @stacks-capital/web exec vite --mode e2e --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
