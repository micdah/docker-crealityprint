// Helpers for driving the Selkies web client (Selkies 2.2.x frontend).

const path = require('node:path');

async function expectEventually(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${description}`);
}

// Open the session and wait until the stream element is on the page.
async function openSession(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas, video').first().waitFor({ state: 'attached', timeout: 60000 });
  // Give the stream a moment to connect and resize the remote desktop to the viewport.
  await page.waitForTimeout(5000);
}

// The closed sidebar stays in the DOM but is moved off-screen, so "visible" isn't enough.
async function isInViewport(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  return Boolean(box) && box.x >= 0 && box.x + box.width <= viewport.width;
}

async function openFilesSection(page) {
  const filesHeader = page.locator('button.sidebar-section-header[title="Files"]');
  if (!(await isInViewport(page, filesHeader))) {
    await page.locator('.toggle-handle').click();
    await expectEventually(() => isInViewport(page, filesHeader), 'the sidebar to open');
  }
  if ((await filesHeader.getAttribute('aria-expanded')) !== 'true') {
    await filesHeader.click();
  }
}

// Upload through the sidebar's "Upload Files" button (opens the browser's file chooser).
async function uploadViaSidebar(page, filePath) {
  await openFilesSection(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('button[title="Upload Files"]').click(),
  ]);
  await chooser.setFiles(filePath);
  const fileName = path.basename(filePath);
  await page.getByText(`Successfully uploaded ${fileName}`).first().waitFor({ timeout: 120000 });
}

// Download one file through the sidebar's "Download Files" dialog; returns the Download.
async function downloadViaFilesDialog(page, fileName) {
  await openFilesSection(page);
  await page.locator('button[title="Download Files"]').click();
  // Rows are plain divs: take the closest ancestor of the file name that holds a button.
  const dialog = page.getByRole('dialog');
  const nameCell = dialog.getByText(fileName, { exact: true });
  await nameCell.waitFor({ state: 'visible', timeout: 30000 });
  const row = nameCell.locator('xpath=ancestor::*[descendant::button][1]');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: /download/i }).click(),
  ]);
  return download;
}

// Click the middle of the stream so keyboard input goes to the remote desktop.
async function focusStream(page) {
  const viewport = page.viewportSize();
  await page.mouse.click(Math.round(viewport.width / 2), Math.round(viewport.height / 2));
}

// Upload through the Selkies file API (the same staging + rename as the UI); returns the status.
async function uploadViaApi(baseUrl, fileName, body, extraHeaders = {}) {
  const { request } = require('@playwright/test');
  const context = await request.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: extraHeaders });
  const response = await context.post(`${baseUrl}/api/upload`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Path': fileName },
    data: Buffer.from(body),
  });
  const status = response.status();
  await context.dispose();
  return status;
}

module.exports = { uploadViaApi, openSession, openFilesSection, uploadViaSidebar, downloadViaFilesDialog, focusStream };
