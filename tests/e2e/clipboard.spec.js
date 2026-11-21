// Text clipboard between the browser and the remote session (requires HTTPS).
const { test, expect } = require('@playwright/test');
const { AppContainer, poll } = require('./lib/app');
const { openSession, focusStream } = require('./lib/selkies');

const SESSION_ENV = { DISPLAY: ':0' };

test.describe('clipboard', () => {
  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('text goes browser to session and session to browser', async ({ page, context }) => {
    app = await AppContainer.start({ label: 'clipboard', env: { CP_PRINTER: 'Creality K1C' } });
    await app.waitForInit();
    await app.waitForMainWindow();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.httpsUrl });
    await openSession(page, app.httpsUrl);

    // Browser -> session: Selkies sends the local clipboard when it sees the paste keystroke.
    await page.evaluate(() => navigator.clipboard.writeText('crp-e2e-in'));
    await focusStream(page);
    await page.keyboard.press('Control+V');
    await poll(
      'the session clipboard to receive the text',
      async () => (await app.exec('xclip -o -selection clipboard', { env: SESSION_ENV })).trim() === 'crp-e2e-in',
      { timeoutMs: 30000 },
    );

    // Session -> browser: set the session clipboard; Selkies' clipboard monitor pushes it.
    await app.exec("printf 'crp-e2e-out' | xclip -selection clipboard -i >/dev/null 2>&1 &", { env: SESSION_ENV });
    await focusStream(page);
    await page.keyboard.press('Control+C');
    await poll(
      'the browser clipboard to receive the text',
      async () => (await page.evaluate(() => navigator.clipboard.readText())) === 'crp-e2e-out',
      { timeoutMs: 30000 },
    );
  });
});
