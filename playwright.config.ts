import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  timeout: 100_000,
  use: {
    baseURL: 'http://127.0.0.1:4321',
    browserName: 'chromium',
    actionTimeout: 8000,
    navigationTimeout: 12000,
    launchOptions: process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {}
  }
})
