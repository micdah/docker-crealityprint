// Visual evidence for reviewers: a named screenshot at each visible check a test makes.
//
// Each screenshot is attached to the Playwright report (shown inline in the HTML report,
// which CI publishes per PR) and also written as a numbered file under
// <artifacts>/screenshots/<spec>/ for quick browsing of the downloaded artifact.

const fs = require('node:fs');
const path = require('node:path');

const artifactsDir = process.env.E2E_ARTIFACTS_DIR || '/e2e/artifacts';
const screenshotCounters = new Map();

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function nextScreenshotPath(testInfo, label) {
  const specName = path.basename(testInfo.file, '.spec.js');
  const number = (screenshotCounters.get(specName) || 0) + 1;
  screenshotCounters.set(specName, number);
  const directory = path.join(artifactsDir, 'screenshots', specName);
  fs.mkdirSync(directory, { recursive: true });
  // A retry runs in a fresh worker (counter restarts), so mark its files apart.
  const retrySuffix = testInfo.retry > 0 ? `-retry${testInfo.retry}` : '';
  return path.join(directory, `${String(number).padStart(2, '0')}${retrySuffix}-${slugify(label)}.png`);
}

// Screenshot the page after letting the stream catch up, and record it under `label`.
async function snap(page, testInfo, label, { settleMs = 2000 } = {}) {
  await page.waitForTimeout(settleMs);
  const screenshotPath = nextScreenshotPath(testInfo, label);
  await page.screenshot({ path: screenshotPath });
  // Attach by path: the report then names the stored file after this .png, not after the
  // label (a label like "0.20mm Standard" would otherwise end up as the file extension).
  await testInfo.attach(label, { path: screenshotPath, contentType: 'image/png' });
}

// Record non-visual evidence (e.g. clipboard contents, glxinfo) next to the screenshots.
async function note(testInfo, label, text) {
  await testInfo.attach(label, { body: text, contentType: 'text/plain' });
}

module.exports = { snap, note };
