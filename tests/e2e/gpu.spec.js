// GPU acceleration with /dev/dri. Runs only on hosts with a GPU (not on hosted CI runners).
const { test, expect } = require('@playwright/test');
const { AppContainer, poll } = require('./lib/app');
const { openSession } = require('./lib/selkies');

test.describe('gpu', () => {
  test.skip(process.env.E2E_HAS_DRI !== 'true', 'no /dev/dri on this host');

  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('the app renders on the GPU and the stream is hardware encoded', async ({ page }, testInfo) => {
    app = await AppContainer.start({
      label: 'gpu',
      env: { CP_PRINTER: 'Creality K1C' },
      devices: ['/dev/dri:/dev/dri'],
    });
    await app.waitForInit();
    await app.waitForMainWindow();

    // The app is an X11 client on Xwayland :0; what glxinfo reports there is what it gets.
    const glxinfo = await app.exec('glxinfo -B', { env: { DISPLAY: ':0' } });
    await testInfo.attach('glxinfo', { body: glxinfo, contentType: 'text/plain' });
    const renderer = glxinfo.split('\n').find((line) => line.includes('OpenGL renderer string')) || '';
    expect(renderer).not.toContain('llvmpipe');

    // The encoder starts when a client connects.
    await openSession(page, app.httpsUrl);
    await poll('a hardware (VA-API/NVENC) encoder', async () => /vaapi|nvenc/i.test(await app.logs()), {
      timeoutMs: 60000,
    });
  });
});
