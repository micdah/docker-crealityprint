// Closing the app must not leave an empty desktop: the base image's watchdog (RESTART_APP,
// on by default) starts it again. With RESTART_APP=false it stays closed until relaunched.
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { AppContainer, poll, writeCubeStl } = require('./lib/app');
const { openSession } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

// SIGTERM stands in for an exit or crash: the app ends and so does its autostart shell. (The
// window's X button goes through the app's close handler instead; that was checked by hand.)
// Waits for that PID to be gone, not for zero processes: the watchdog's relaunch can follow
// within a fraction of a second, too quickly for a count of zero to be seen reliably.
async function closeApp(app) {
  app.markerBaseline = app.countMainWindowMarkers();
  const pid = (await app.exec('pgrep -o -x CrealityPrint')).trim();
  expect(pid).toMatch(/^\d+$/);
  await app.exec(`kill ${pid}`);
  const pidIsGone = async () => (await app.exec(`if [ -d /proc/${pid} ]; then echo running; else echo gone; fi`)).trim() === 'gone';
  await poll('the app to exit', pidIsGone, { timeoutMs: 30000, intervalMs: 250 });
}

test.describe('app restart', () => {
  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('a closed app starts again by itself', async ({ page }, testInfo) => {
    app = await AppContainer.start({ label: 'restart', env: { CP_PRINTER: 'Creality K1C' } });
    await app.waitForInit();
    await app.waitForMainWindow();
    await openSession(page, app.httpsUrl);
    await snap(page, testInfo, 'Before closing: the app is running');

    await closeApp(app);
    await poll(
      'the watchdog to restart the app',
      async () => (await app.logs()).includes('has terminated. Restarting...'),
      { timeoutMs: 30000 },
    );
    await app.waitForMainWindow();
    // Restarted once, not once per watchdog poll.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(await app.appProcessCount()).toBe(1);
    await snap(page, testInfo, 'After closing: the app has started again without a page reload');

    // The new instance is reachable on the session bus, so crealityprint-open (and the upload
    // watcher) still reach it.
    writeCubeStl(path.join(app.configDir, 'Desktop'), 'e2e restart.stl', 30);
    await poll('crealityprint-open to reach the restarted app', async () => {
      await app.exec('crealityprint-open "/config/Desktop/e2e restart.stl"');
      return true;
    }, { timeoutMs: 60000 });
    await app.waitForAppLog('load_files start filename /config/Desktop/e2e restart.stl');
    await snap(page, testInfo, 'The restarted app still accepts files from crealityprint-open');
  });

  test('with RESTART_APP=false a closed app stays closed', async ({ page }, testInfo) => {
    app = await AppContainer.start({
      label: 'restart-off',
      env: { CP_PRINTER: 'Creality K1C', RESTART_APP: 'false' },
    });
    await app.waitForInit();
    await app.waitForMainWindow();

    await closeApp(app);
    await new Promise((resolve) => setTimeout(resolve, 15000));
    expect(await app.appProcessCount()).toBe(0);
    await openSession(page, app.httpsUrl);
    await snap(page, testInfo, 'RESTART_APP=false: after closing, the desktop stays empty');

    // The README's way back: right-click the desktop, "Creality Print".
    const menu = await app.exec('cat /config/.config/labwc/menu.xml');
    expect(menu).toContain('label="Creality Print"');
    expect(menu).toContain('<command>/usr/local/bin/crealityprint</command>');
  });
});
