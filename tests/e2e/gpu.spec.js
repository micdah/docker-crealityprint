// GPU acceleration with /dev/dri. Runs only on hosts with a GPU (not on hosted CI runners).
const { test, expect } = require('./lib/fixtures');
const { poll } = require('./lib/app');
const { openSession } = require('./lib/selkies');
const { snap, note } = require('./lib/evidence');

test.describe('gpu', () => {
  test.skip(process.env.E2E_HAS_DRI !== 'true', 'no /dev/dri on this host');

  test('the app renders on the GPU and the stream is hardware encoded', async ({ page, startApp }, testInfo) => {
    const app = await startApp({
      label: 'gpu',
      env: { CP_PRINTER: 'Creality K1C' },
      devices: ['/dev/dri:/dev/dri'],
    });
    await app.waitForInit();
    await app.waitForMainWindow();

    // The app is an X11 client on Xwayland :0; what glxinfo reports there is what it gets.
    const glxinfo = await app.exec('glxinfo -B', { env: { DISPLAY: ':0' } });
    await note(testInfo, 'glxinfo -B on the app display', glxinfo);
    const renderer = glxinfo.split('\n').find((line) => line.includes('OpenGL renderer string')) || '';
    expect(renderer).not.toBe('');
    expect(renderer).not.toContain('llvmpipe');

    // The encoder starts when a client connects. Match pixelflux's success line: it also logs a
    // harmless "No hardware encoder … (nvenc)" line on hosts without NVIDIA.
    await openSession(page, app.httpsUrl);
    await poll('a hardware (VA-API/NVENC) encoder', async () => /\] Encoder: (VAAPI|NVENC)\b/.test(await app.logs()), {
      timeoutMs: 60000,
    });
    await snap(page, testInfo, `GPU: 3D view rendered by "${renderer.replace('OpenGL renderer string:', '').trim()}", stream hardware encoded`);
  });
});
