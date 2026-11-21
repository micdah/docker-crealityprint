// Playwright config for the e2e suite. Run through tests/run-e2e.sh, which provides the env.
const { defineConfig } = require('@playwright/test');

const artifactsDir = process.env.E2E_ARTIFACTS_DIR || '/e2e/artifacts';
const isCI = Boolean(process.env.CI);

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.js',
  // App containers take a while to start, and CPU rendering on CI runners is slow.
  timeout: 8 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  retries: isCI ? 1 : 0,
  // Each spec file owns its containers, so files may run in parallel; tests inside a file
  // run in order because some build on each other's state.
  fullyParallel: false,
  outputDir: `${artifactsDir}/test-results`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${artifactsDir}/report`, open: 'never' }],
    ['json', { outputFile: `${artifactsDir}/results.json` }],
  ],
  use: {
    // Small stream: without a GPU the CPU cost grows with the number of streamed pixels.
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
