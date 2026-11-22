// CP_UI_SCALE: the launcher draws the app at a whole-number GTK scale; init logs the result.
const { test, expect } = require('@playwright/test');
const { AppContainer } = require('./lib/app');
const { openSession } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

test.describe('HiDPI UI scale', () => {
  // A HiDPI client with Selkies left at 100 %, the setup CP_UI_SCALE is meant for: the remote
  // desktop gets the device resolution (2560x1440) and the app draws itself at 2x on it.
  test.use({ deviceScaleFactor: 2 });

  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('CP_UI_SCALE=2 starts the app with GDK_SCALE=2', async ({ page }, testInfo) => {
    app = await AppContainer.start({
      label: 'scale-2',
      env: { CP_UI_SCALE: '2', CP_PRINTER: 'Creality K1C' },
    });
    await app.waitForInit();
    expect(await app.logs()).toContain('[crealityprint-init] UI scale 2');

    await app.waitForMainWindow();
    const environment = await app.appEnvironment();
    expect(environment.GDK_SCALE).toBe('2');

    await openSession(page, app.httpsUrl);
    // The page is only 1280x720 CSS px (to keep the stream cheap without a GPU), which is all
    // the room a 2x app gets, so its layout is cramped; the check is that it is 2x and sharp.
    await snap(page, testInfo, 'CP_UI_SCALE=2 on a devicePixelRatio 2 client, Selkies at 100 %: the app at 2x, sharp (cramped in a 1280×720 page)', {
      settleMs: 5000,
    });
  });

  // A user's own GDK_SCALE rides along, to prove the launcher leaves it alone when it doesn't
  // apply CP_UI_SCALE (rather than only that nothing set GDK_SCALE).
  test('an invalid CP_UI_SCALE is logged and ignored, and a user GDK_SCALE passes through', async () => {
    app = await AppContainer.start({ label: 'scale-bad', env: { CP_UI_SCALE: '1.5', GDK_SCALE: '3' } });
    await app.waitForInit();
    expect(await app.logs()).toContain('[crealityprint-init] ignoring CP_UI_SCALE=1.5');

    await app.waitForAppProcess();
    const environment = await app.appEnvironment();
    expect(environment.CP_UI_SCALE).toBe('1.5');
    expect(environment.GDK_SCALE).toBe('3');
  });
});
