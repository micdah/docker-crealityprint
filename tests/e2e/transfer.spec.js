// File transfer through the Selkies Files panel and its API, including the lock-down options.
const fs = require('node:fs');
const path = require('node:path');
const { request } = require('@playwright/test');
const { test, expect } = require('./lib/fixtures');
const { writeCubeStl, sha256 } = require('./lib/app');
const { openSession, openSidebar, uploadViaApi, uploadViaSidebar, downloadViaFilesDialog } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

const EMPTY_STL = 'solid empty\nendsolid empty\n';

test.describe('file transfer', () => {
  test('upload via the sidebar lands in /config/Desktop, and download returns it intact', async ({ page, startApp }, testInfo) => {
    const app = await startApp({ label: 'transfer' });
    await app.waitForInit();
    await openSession(page, app.httpsUrl);

    const localFile = writeCubeStl(testInfo.outputPath(), 'e2e-upload.stl');
    await uploadViaSidebar(page, localFile);
    const remoteSha = (await app.exec('sha256sum /config/Desktop/e2e-upload.stl')).split(' ')[0];
    expect(remoteSha).toBe(sha256(localFile));
    await snap(page, testInfo, 'Upload via the sidebar: "Successfully uploaded e2e-upload.stl"', { settleMs: 500 });

    // A file the app would have exported, placed in the folder on the host side.
    const exportedFile = path.join(app.configDir, 'Desktop', 'e2e-export.gcode');
    fs.writeFileSync(exportedFile, '; e2e test gcode - never printed\nM117 e2e\n');
    const download = await downloadViaFilesDialog(page, 'e2e-export.gcode', () =>
      snap(page, testInfo, 'Download Files dialog lists /config/Desktop (the export and the upload)', { settleMs: 500 }),
    );
    const downloadedPath = testInfo.outputPath('downloaded.gcode');
    await download.saveAs(downloadedPath);
    expect(sha256(downloadedPath)).toBe(sha256(exportedFile));
  });

  test('SELKIES_FILE_TRANSFERS=none blocks the file API', async ({ page, startApp }, testInfo) => {
    const app = await startApp({ label: 'transfer-none', env: { SELKIES_FILE_TRANSFERS: 'none' } });
    await app.waitForInit();
    expect(await uploadViaApi(app.httpsUrl, 'blocked.stl', EMPTY_STL)).toBe(403);
    const context = await request.newContext({ ignoreHTTPSErrors: true });
    const browse = await context.get(`${app.httpsUrl}/api/file-manager/browse?path=`);
    expect(browse.status()).toBe(403);
    await context.dispose();

    await openSession(page, app.httpsUrl);
    await openSidebar(page);
    await expect(page.locator('button.sidebar-section-header[title="Files"]')).toHaveCount(0);
    await snap(page, testInfo, 'SELKIES_FILE_TRANSFERS=none: the sidebar has no Files section (API answers 403)');
  });

  test('PASSWORD puts basic auth on the file API', async ({ page, browser, startApp }, testInfo) => {
    const app = await startApp({ label: 'transfer-auth', env: { PASSWORD: 'e2e-secret' } });
    await app.waitForInit();

    expect(await uploadViaApi(app.httpsUrl, 'anonymous.stl', EMPTY_STL)).toBe(401);
    // Send the credentials up front, as a browser does after the login prompt.
    const basicAuth = { Authorization: `Basic ${Buffer.from('abc:e2e-secret').toString('base64')}` };
    expect(await uploadViaApi(app.httpsUrl, 'authenticated.stl', EMPTY_STL, basicAuth)).toBe(200);

    const response = await page.goto(app.httpsUrl);
    expect(response.status()).toBe(401);
    await snap(page, testInfo, 'PASSWORD set, no credentials: 401 Authorization Required', { settleMs: 500 });

    const loggedIn = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: page.viewportSize(),
      httpCredentials: { username: 'abc', password: 'e2e-secret' },
    });
    const loggedInPage = await loggedIn.newPage();
    await openSession(loggedInPage, app.httpsUrl);
    await snap(loggedInPage, testInfo, 'PASSWORD set, logged in as abc: the session opens');
    await loggedIn.close();
  });
});
