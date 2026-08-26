import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: "npm run build:e2e && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { CLOUDFRAME_E2E_BUILD: "1" }
  },
  projects: [
    {
      name: "tv-1920",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
      testMatch: /(?:enrollment|browse-viewer)\.spec\.ts/
    },
    {
      name: "admin-mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /enrollment\.spec\.ts/
    },
    {
      name: "admin-wide",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } },
      testMatch: /enrollment\.spec\.ts/
    }
  ]
});
