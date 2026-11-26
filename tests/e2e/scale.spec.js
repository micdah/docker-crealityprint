// CP_UI_SCALE: the launcher draws the app at a whole-number GTK scale, and init pins Selkies'
// DPI to 96 so the desktop keeps the browser's full device resolution; init logs the result.
const { test, expect } = require('./lib/fixtures');
const { poll } = require('./lib/app');
const { openSession, openSidebarSection } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

const DPI_FILE = '/run/s6/container_environment/SELKIES_SCALING_DPI';

test.describe('HiDPI UI scale', () => {
  // A fresh HiDPI client, as a new browser or device would connect: its Selkies client asks for
  // UI Scaling 200 % (it derives the DPI from devicePixelRatio), which init has to overrule.
  // 1600x900 CSS px is about the least room the app needs at 2x.
  test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });

  test('CP_UI_SCALE=2 draws the app at 2x on the full-resolution desktop', async ({ page, startApp }, testInfo) => {
    const app = await startApp({
      label: 'scale-2',
      env: { CP_UI_SCALE: '2', CP_PRINTER: 'Creality K1C' },
    });
    await app.waitForInit();
    expect(await app.logs()).toContain(
      '[crealityprint-init] UI scale 2: Selkies\' UI Scaling fixed at 100 % (SELKIES_SCALING_DPI=96)',
    );
    expect((await app.exec(`cat ${DPI_FILE}`, { user: 'root' })).trim()).toBe('96');

    await app.waitForMainWindow();
    const environment = await app.appEnvironment();
    expect(environment.GDK_SCALE).toBe('2');

    // The picture: at UI Scaling 200 % Xwayland would stay at 1600x900 and labwc would stretch
    // the 2x app another 2x. Pinned at 96, Xwayland gets the full 3200x1800 device pixels.
    await openSession(page, app.httpsUrl);
    await poll('Xwayland at 3200x1800', async () => (await app.xDisplaySize()) === '3200x1800', {
      timeoutMs: 30000,
    });
    await snap(page, testInfo, 'CP_UI_SCALE=2 on a fresh devicePixelRatio 2 client at 1600×900: Xwayland 3200×1800, the app at 2x, sharp', {
      settleMs: 5000,
    });

    // Selkies hides UI Scaling once the operator fixed the DPI; the rest of the section stays.
    // Both the select's id and its label are checked, so a renamed id in a base-image update
    // can't make this pass by matching nothing.
    await openSidebarSection(page, 'Screen Settings');
    await page.getByText('HiDPI (Pixel Perfect)').first().waitFor({ state: 'visible' });
    expect(await page.locator('#uiScalingSelect').count()).toBe(0);
    expect(await page.getByText('UI Scaling', { exact: true }).count()).toBe(0);
  });

  // /run survives `docker restart`, but s6 rebuilds its container_environment from the
  // container's environment on every start. So the 96 of the first start must not reach the
  // second one, where the init would take it for the user's own value and only keep it.
  test('after a restart the image sets the DPI again, not as the user\'s', async ({ startApp }) => {
    const app = await startApp({ label: 'scale-restart', env: { CP_UI_SCALE: '2' } });
    await app.waitForInit();
    await app.restart();
    await app.waitForInit();

    const logs = await app.logs();
    const fixedLines = logs.split('UI scale 2: Selkies\' UI Scaling fixed at 100 %').length - 1;
    expect(fixedLines).toBe(2);
    expect(logs).not.toContain('keeping your SELKIES_SCALING_DPI');
    expect((await app.exec(`cat ${DPI_FILE}`, { user: 'root' })).trim()).toBe('96');
  });

  test('a user SELKIES_SCALING_DPI is kept', async ({ startApp }) => {
    const app = await startApp({
      label: 'scale-user-dpi',
      env: { CP_UI_SCALE: '2', SELKIES_SCALING_DPI: '144' },
    });
    await app.waitForInit();
    expect(await app.logs()).toContain(
      '[crealityprint-init] UI scale 2: keeping your SELKIES_SCALING_DPI=144; the app is only sharp at 96',
    );
    expect((await app.exec(`cat ${DPI_FILE}`, { user: 'root' })).trim()).toBe('144');
  });

  // A user's own GDK_SCALE rides along, to prove the launcher leaves it alone when it doesn't
  // apply CP_UI_SCALE (rather than only that nothing set GDK_SCALE).
  test('an invalid CP_UI_SCALE is logged and ignored, and a user GDK_SCALE passes through', async ({ startApp }) => {
    const app = await startApp({ label: 'scale-bad', env: { CP_UI_SCALE: '1.5', GDK_SCALE: '3' } });
    await app.waitForInit();
    expect(await app.logs()).toContain('[crealityprint-init] ignoring CP_UI_SCALE=1.5');
    // Selkies' own DPI default is left alone.
    expect((await app.exec(`ls ${DPI_FILE} 2> /dev/null || true`, { user: 'root' })).trim()).toBe('');

    await app.waitForAppProcess();
    const environment = await app.appEnvironment();
    expect(environment.CP_UI_SCALE).toBe('1.5');
    expect(environment.GDK_SCALE).toBe('3');
  });
});
