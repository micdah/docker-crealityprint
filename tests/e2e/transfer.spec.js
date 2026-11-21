// File transfer through the Selkies Files panel and its API, including the lock-down options.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, request } = require('@playwright/test');
const { AppContainer, writeCubeStl, sha256 } = require('./lib/app');
const { openSession, uploadViaSidebar, downloadViaFilesDialog } = require('./lib/selkies');

async function uploadStatus(context, baseUrl, fileName) {
  const response = await context.post(`${baseUrl}/api/upload`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Path': fileName },
    data: Buffer.from('solid empty\nendsolid empty\n'),
  });
  return response.status();
}

test.describe('file transfer', () => {
  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('upload via the sidebar lands in /config/Desktop, and download returns it intact', async ({ page }, testInfo) => {
    app = await AppContainer.start({ label: 'transfer' });
    await app.waitForInit();
    await openSession(page, app.httpsUrl);

    const localFile = writeCubeStl(testInfo.outputPath(), 'e2e-upload.stl');
    await uploadViaSidebar(page, localFile);
    const remoteSha = (await app.exec('sha256sum /config/Desktop/e2e-upload.stl')).split(' ')[0];
    expect(remoteSha).toBe(sha256(localFile));

    // A file the app would have exported, placed in the folder on the host side.
    const exportedFile = path.join(app.configDir, 'Desktop', 'e2e-export.gcode');
    fs.writeFileSync(exportedFile, '; e2e test gcode - never printed\nM117 e2e\n');
    const download = await downloadViaFilesDialog(page, 'e2e-export.gcode');
    const downloadedPath = testInfo.outputPath('downloaded.gcode');
    await download.saveAs(downloadedPath);
    expect(sha256(downloadedPath)).toBe(sha256(exportedFile));
  });

  test('SELKIES_FILE_TRANSFERS=none blocks the file API', async () => {
    app = await AppContainer.start({ label: 'transfer-none', env: { SELKIES_FILE_TRANSFERS: 'none' } });
    await app.waitForInit();
    const context = await request.newContext({ ignoreHTTPSErrors: true });
    expect(await uploadStatus(context, app.httpsUrl, 'blocked.stl')).toBe(403);
    const browse = await context.get(`${app.httpsUrl}/api/file-manager/browse?path=`);
    expect(browse.status()).toBe(403);
    await context.dispose();
  });

  test('PASSWORD puts basic auth on the file API', async () => {
    app = await AppContainer.start({ label: 'transfer-auth', env: { PASSWORD: 'e2e-secret' } });
    await app.waitForInit();

    const anonymous = await request.newContext({ ignoreHTTPSErrors: true });
    expect(await uploadStatus(anonymous, app.httpsUrl, 'anonymous.stl')).toBe(401);
    await anonymous.dispose();

    // Send the credentials up front, as a browser does after the login prompt.
    const authenticated = await request.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Authorization: `Basic ${Buffer.from('abc:e2e-secret').toString('base64')}` },
    });
    expect(await uploadStatus(authenticated, app.httpsUrl, 'authenticated.stl')).toBe(200);
    await authenticated.dispose();
  });
});
