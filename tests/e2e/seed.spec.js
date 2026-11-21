// First-run seeding: CP_PRINTER skips the wizard; without it only the defaults are seeded.
const { test, expect } = require('@playwright/test');
const { AppContainer } = require('./lib/app');
const { openSession } = require('./lib/selkies');

test.describe('first-run seed', () => {
  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('CP_PRINTER seeds the printer and presets and skips the wizard', async ({ page }, testInfo) => {
    app = await AppContainer.start({ label: 'seed-k1c', env: { CP_PRINTER: 'Creality K1C' } });
    await app.waitForInit();
    await app.waitForMainWindow();
    await page.waitForTimeout(10000);

    const conf = await app.readAppFile('Creality.conf');
    expect(conf.models[0].model).toBe('Creality K1C');
    expect(conf.presets.machine).toBe('Creality K1C 0.4 nozzle');
    expect(conf.presets.process).toBe('0.20mm Standard @Creality K1C 0.4 nozzle');
    expect(conf.firstguide.finish).toBeTruthy();
    expect(conf.recent.last_opened_folder).toBe('/config/Desktop');
    expect(conf.app.last_export_path).toBe('/config/Desktop');

    const privacy = await app.readAppFile('privacyInfo.json');
    expect(privacy.list[0].check).toBe(false);

    await openSession(page, app.httpsUrl);
    await testInfo.attach('seeded-main-window', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('without CP_PRINTER only the folders and telemetry opt-out are seeded', async ({ page }, testInfo) => {
    app = await AppContainer.start({ label: 'seed-plain' });
    await app.waitForInit();
    await app.waitForAppProcess();
    await page.waitForTimeout(20000);

    const conf = await app.readAppFile('Creality.conf');
    expect(conf.models ?? []).toHaveLength(0);
    expect(conf.firstguide?.finish).toBeFalsy();
    expect(conf.recent.last_opened_folder).toBe('/config/Desktop');

    const privacy = await app.readAppFile('privacyInfo.json');
    expect(privacy.list[0].check).toBe(false);

    await openSession(page, app.httpsUrl);
    await testInfo.attach('first-run-wizard', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('an unknown CP_PRINTER falls back to the wizard instead of an empty printer', async () => {
    app = await AppContainer.start({ label: 'seed-unknown', env: { CP_PRINTER: 'No Such Printer' } });
    await app.waitForInit();

    expect(await app.logs()).toContain("no printer profile named 'No Such Printer 0.4 nozzle'");
    const conf = await app.readAppFile('Creality.conf');
    expect(conf.models).toBeUndefined();
    expect(conf.recent.last_opened_folder).toBe('/config/Desktop');
  });
});
