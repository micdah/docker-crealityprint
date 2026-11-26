// Opt-in upload watcher: uploaded models are handed to the running app, never a second app.
const fs = require('node:fs');
const { test, expect } = require('./lib/fixtures');
const { poll, writeCubeStl } = require('./lib/app');
const { openSession, uploadViaApi } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

test.describe('upload watcher', () => {
  test('an uploaded model is added to the running app', async ({ page, startApp }, testInfo) => {
    const app = await startApp({
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
    // Also the PR comment's app screenshot: the app is up and shows a loaded model.
    await snap(page, testInfo, 'After uploading "e2e watch.stl": the 40 mm cube is on the plate, same window', {
      appScreenshot: true,
    });

    // Non-model files are left alone.
    expect(await uploadViaApi(app.httpsUrl, 'notes.txt', 'just notes\n')).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // (Selkies itself logs every upload's name, so check for the watcher's own line.)
    expect(await app.logs()).not.toContain('added /config/Desktop/notes.txt');
  });

  // Also covers the defaults of IDLE_QUIT (off) and CP_UI_SCALE (Selkies' DPI left alone): it
  // reuses this default container instead of starting its own, and needs no waiting because
  // it checks what init installed.
  test('the watcher, close when idle and the Selkies DPI pin are off by default', async ({ startApp }) => {
    const app = await startApp({ label: 'watcher-off' });
    await app.waitForInit();
    const logs = await app.logs();
    expect(logs).not.toContain('[crealityprint-upload-watcher] watching');
    expect(logs).not.toContain('[crealityprint-idle]');
    expect(await app.idleFootprint()).toBe('');
    expect(logs).not.toContain('[crealityprint-init] UI scale');
    expect(await app.uiScaleFootprint()).toBe('');
  });
});
