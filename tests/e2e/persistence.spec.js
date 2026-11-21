// Settings survive container re-creation, and a PUID change on an existing /config works.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { AppContainer, poll } = require('./lib/app');
const { uploadViaApi } = require('./lib/selkies');

const DATA_DIR_GLOB = '.config/Creality/Creality Print';

function findConfFile(configDir) {
  const root = path.join(configDir, DATA_DIR_GLOB);
  const versionDir = fs.readdirSync(root).find((entry) => /^\d/.test(entry));
  return path.join(root, versionDir, 'Creality.conf');
}

test.describe.serial('persistence', () => {
  let app;
  let configDir;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('settings survive docker rm and re-create', async ({}, testInfo) => {
    app = await AppContainer.start({ label: 'persist-a', env: { CP_PRINTER: 'Creality K1C' } });
    configDir = app.configDir;
    await app.waitForInit();
    await app.waitForMainWindow();
    await app.stop();
    await app.remove(testInfo);

    // Change a preference while no app is running, as if the user had changed it in the UI.
    const confFile = findConfFile(configDir);
    const conf = JSON.parse(fs.readFileSync(confFile, 'utf8'));
    conf.app.zoom_to_mouse = false;
    fs.writeFileSync(confFile, JSON.stringify(conf, null, 4));

    app = await AppContainer.start({ label: 'persist-b', configDir });
    await app.waitForInit();
    await app.waitForMainWindow();
    expect(await app.logs()).not.toContain('first run: seeding');
    await app.stop();

    const reloaded = JSON.parse(fs.readFileSync(confFile, 'utf8'));
    expect(String(reloaded.app.zoom_to_mouse)).toBe('false');
    expect(reloaded.models[0].model).toBe('Creality K1C');
    expect(reloaded.firstguide.finish).toBeTruthy();
  });

  test('a PUID/PGID change on an existing /config still starts the desktop and app', async () => {
    test.skip(!configDir, 'needs the config from the previous test');
    // The watcher also proves the app still has its session D-Bus (state in /config/.dbus).
    app = await AppContainer.start({
      label: 'persist-puid',
      configDir,
      puid: '4321',
      pgid: '4321',
      env: { AUTO_OPEN_UPLOADS: 'true' },
    });
    await app.waitForInit();

    expect(await app.logs()).toContain('re-owning the desktop and app state');
    const owner = (await app.exec('stat -c %u "/config/.config/Creality/Creality Print"', { user: 'root' })).trim();
    expect(owner).toBe('4321');

    await app.waitForMainWindow();
    await poll('the app still running', async () => (await app.appProcessCount()) === 1, { timeoutMs: 20000 });

    const cubeStl = 'solid c\n facet normal 0 0 0\n  outer loop\n   vertex 0 0 0\n   vertex 9 9 0\n   vertex 9 0 0\n  endloop\n endfacet\nendsolid c\n';
    expect(await uploadViaApi(app.httpsUrl, 'after-puid.stl', cubeStl)).toBe(200);
    await app.waitForAppLog('load_files start filename /config/Desktop/after-puid.stl');
    expect(await app.appProcessCount()).toBe(1);
  });
});
