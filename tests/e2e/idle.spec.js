// Opt-in sleep when idle: the app is frozen while no browser is connected and wakes on connect.
//
// One container and one test on purpose: starting a container is the slow part, so all of the
// behaviour is checked in sequence, with a short idle timeout and polls that return early.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { AppContainer, poll, writeCubeStl } = require('./lib/app');
const { openSession, uploadViaApi } = require('./lib/selkies');
const { snap, note } = require('./lib/evidence');

const IDLE_SECONDS = 5;
// Room for slow CI runners; every poll returns as soon as the state is reached.
const STATE_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;

function isFrozen(states) {
  return states.length > 0 && states.every((state) => state === 'T');
}

function isAwake(states) {
  return states.length > 0 && states.every((state) => state !== 'T');
}

async function waitForTree(app, description, check) {
  await poll(description, async () => check(await app.appTreeStates()), {
    timeoutMs: STATE_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
  });
}

test.describe('sleep when idle', () => {
  let app;

  test.afterEach(async ({}, testInfo) => {
    if (app) {
      await app.remove(testInfo);
      app = null;
    }
  });

  test('the app sleeps without a browser, ignores uploads while asleep and wakes on connect', async ({ page }, testInfo) => {
    app = await AppContainer.start({
      label: 'idle',
      env: {
        IDLE_SLEEP: 'true',
        IDLE_SLEEP_AFTER: String(IDLE_SECONDS),
        AUTO_OPEN_UPLOADS: 'true',
        CP_PRINTER: 'Creality K1C',
      },
    });
    await app.waitForInit();

    // No browser has connected since boot. With a 5 s timeout the app may be frozen before its
    // main window is up; it carries on starting once it wakes.
    await app.waitForAppProcess();
    await waitForTree(app, 'the app tree to be frozen with no browser connected', isFrozen);
    await note(testInfo, 'Process states while asleep (T = stopped)', (await app.appTreeStates()).join(' '));

    // A file-API upload while asleep is left in the folder, and the app stays asleep.
    const cubeFile = writeCubeStl(testInfo.outputPath(), 'e2e sleep.stl', 30);
    expect(await uploadViaApi(app.httpsUrl, 'e2e sleep.stl', fs.readFileSync(cubeFile))).toBe(200);
    await poll(
      'the watcher to skip the upload',
      async () => (await app.logs()).includes('not opening /config/Desktop/e2e sleep.stl'),
      { timeoutMs: STATE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    expect(isFrozen(await app.appTreeStates())).toBe(true);

    // A browser connects: the app wakes at once and finishes starting.
    await openSession(page, app.httpsUrl);
    await waitForTree(app, 'the app tree to resume on connect', isAwake);
    expect(await app.logs()).toContain('[crealityprint-idle] awake: a browser connected');
    await app.waitForMainWindow();
    await snap(page, testInfo, 'After connecting: the app is awake and drawn, the upload made while it slept is not on the plate');
    expect(app.appLogIncludes('load_files start filename /config/Desktop/e2e sleep.stl')).toBe(false);

    // The last browser leaves: the app is frozen again after the timeout.
    await page.goto('about:blank');
    await waitForTree(app, 'the app tree to be frozen again after the browser left', isFrozen);
  });
});
