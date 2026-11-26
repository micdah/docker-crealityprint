// First-run seeding: CP_PRINTER skips the wizard; without it only the defaults are seeded.
const { test, expect } = require('./lib/fixtures');
const { openSession } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

test.describe('first-run seed', () => {
  test('CP_PRINTER seeds the printer and presets and skips the wizard', async ({ page, startApp }, testInfo) => {
    const app = await startApp({ label: 'seed-k1c', env: { CP_PRINTER: 'Creality K1C' } });
    await app.waitForInit();
    await app.waitForMainWindow();
    // The app rewrites Creality.conf after start; check what it kept, not just what was seeded.
    await page.waitForTimeout(10000);

    const conf = await app.readAppFile('Creality.conf');
    expect(conf.models[0].model).toBe('Creality K1C');
    expect(conf.presets.machine).toBe('Creality K1C 0.4 nozzle');
    expect(conf.presets.process).toBe('0.20mm Standard @Creality K1C 0.4 nozzle');
    expect(conf.presets.filaments[0]).toBe('Hyper PLA @Creality K1C 0.4 nozzle');
    expect(conf.firstguide.finish).toBeTruthy();
    expect(conf.recent.last_opened_folder).toBe('/config/Desktop');
    expect(conf.app.last_export_path).toBe('/config/Desktop');

    const privacy = await app.readAppFile('privacyInfo.json');
    expect(privacy.list[0].check).toBe(false);

    await openSession(page, app.httpsUrl);
    await snap(page, testInfo, 'Seeded first start: Prepare view with Creality K1C, Hyper PLA, 0.20mm Standard; no wizard');
  });

  test('without CP_PRINTER only the folders and telemetry opt-out are seeded', async ({ page, startApp }, testInfo) => {
    // Both set: the seed must follow Selkies, which reads SELKIES_FILE_MANAGER_PATH first.
    const app = await startApp({
      label: 'seed-plain',
      env: { SELKIES_FILE_MANAGER_PATH: '/config/models', FILE_MANAGER_PATH: '/config/other' },
    });
    await app.waitForInit();
    await app.waitForAppProcess();
    await page.waitForTimeout(20000);

    const conf = await app.readAppFile('Creality.conf');
    expect(conf.models ?? []).toHaveLength(0);
    expect(conf.firstguide?.finish).toBeFalsy();
    expect(conf.recent.last_opened_folder).toBe('/config/models');
    expect(conf.app.last_export_path).toBe('/config/models');

    const privacy = await app.readAppFile('privacyInfo.json');
    expect(privacy.list[0].check).toBe(false);

    await openSession(page, app.httpsUrl);
    await snap(page, testInfo, 'Unseeded first start, 20 s after launch (no printer configured; expected: the setup wizard)');
  });

  test('an unknown CP_PRINTER falls back to the wizard instead of an empty printer', async ({ page, startApp }, testInfo) => {
    const app = await startApp({ label: 'seed-unknown', env: { CP_PRINTER: 'No Such Printer' } });
    await app.waitForInit();

    expect(await app.logs()).toContain("no printer profile named 'No Such Printer 0.4 nozzle'");
    const conf = await app.readAppFile('Creality.conf');
    expect(conf.models).toBeUndefined();
    expect(conf.recent.last_opened_folder).toBe('/config/Desktop');

    await app.waitForAppProcess();
    await openSession(page, app.httpsUrl);
    await snap(page, testInfo, 'Unknown CP_PRINTER, 15 s after launch (no printer seeded; expected: the setup wizard)', {
      settleMs: 15000,
    });
  });
});
