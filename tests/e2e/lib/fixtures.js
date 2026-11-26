// Playwright's `test` plus a `startApp` fixture. Every app container a test starts through it is
// removed when the test ends, whatever the outcome, with its logs attached to the report.
const base = require('@playwright/test');
const { AppContainer } = require('./app');

const test = base.test.extend({
  startApp: async ({}, use, testInfo) => {
    const started = [];
    await use(async (options) => {
      const app = await AppContainer.start(options);
      started.push(app);
      return app;
    });
    for (const app of started) {
      await app.remove(testInfo);
    }
  },
});

module.exports = { test, expect: base.expect };
