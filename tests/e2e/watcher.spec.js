// Opt-in upload watcher: uploaded models are handed to the running app, never a second app.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { AppContainer, poll, writeCubeStl } = require('./lib/app');
const { openSession, uploadViaApi } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

test.describe('upload watcher', () => {
  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('an uploaded model is added to the running app', async ({ page }, testInfo) => {
    app = await AppContainer.start({
      label: 'watcher',
      env: { AUTO_OPEN_UPLOADS: 'true', CP_PRINTER: 'Creality K1C' },
    });
    await app.waitForInit();
    await app.waitForMainWindow();
    await openSession(page, app.httpsUrl);
    await snap(page, testInfo, 'Before the upload: empty K1C plate');

    const cubeFile = writeCubeStl(testInfo.outputPath(), 'e2e watch.stl', 40);
    expect(await uploadViaApi(app.httpsUrl, 'e2e watch.stl', fs.readFileSync(cubeFile))).toBe(200);
    await poll(
      'the watcher to forward the upload',
      async () => (await app.logs()).includes('added /config/Desktop/e2e watch.stl to the running app'),
      { timeoutMs: 30000 },
    );
    // The app itself must have loaded it (the D-Bus send succeeds even if the app ignores it).
    await app.waitForAppLog('load_files start filename /config/Desktop/e2e watch.stl');
    // Forwarded over D-Bus: still exactly one app process, no second window.
    expect(await app.appProcessCount()).toBe(1);
    // Also the PR comment's smoke screenshot: the app is up and shows a loaded model.
    await snap(page, testInfo, 'After uploading "e2e watch.stl": the 40 mm cube is on the plate, same window', {
      smoke: true,
    });

    // Non-model files are left alone.
    expect(await uploadViaApi(app.httpsUrl, 'notes.txt', 'just notes\n')).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // (Selkies itself logs every upload's name, so check for the watcher's own line.)
    expect(await app.logs()).not.toContain('added /config/Desktop/notes.txt');
  });

  test('the watcher is off by default', async () => {
    app = await AppContainer.start({ label: 'watcher-off' });
    await app.waitForInit();
    expect(await app.logs()).not.toContain('[crealityprint-upload-watcher] watching');
  });
});
