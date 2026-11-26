// Opt-in close when idle: the app is closed while no browser is connected and starts again on
// connect, but only when the idle timer closed it.
//
// The close/start behaviour gets one container and one test on purpose: starting a container is
// the slow part, so it is all checked in sequence, with a short idle timeout and polls that
// return early. The restart and restarter-guard groups below add containers that only boot.
const fs = require('node:fs');
const { test, expect } = require('./lib/fixtures');
const { poll, writeCubeStl } = require('./lib/app');
const { openSession, uploadViaApi } = require('./lib/selkies');
const { snap } = require('./lib/evidence');

const IDLE_SECONDS = 5;
// Room for slow CI runners; every poll returns as soon as the state is reached.
const STATE_TIMEOUT_MS = 30000;
// The daemon never closes an app younger than 60 s, so a close can take that long.
const CLOSE_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 500;
const CLOSED_LOG = '[crealityprint-idle] closed Creality Print';
const STARTED_LOG = '[crealityprint-idle] starting Creality Print again: a browser connected';

function countOccurrences(text, part) {
  return text.split(part).length - 1;
}

async function waitForLogCount(app, description, part, count, timeoutMs = STATE_TIMEOUT_MS) {
  await poll(description, async () => countOccurrences(await app.logs(), part) >= count, {
    timeoutMs,
    intervalMs: POLL_INTERVAL_MS,
  });
}

// The browser presence the daemon works from: "present" or "absent".
async function waitForClientsState(app, state) {
  await poll(`the idle daemon to record "${state}"`, async () => {
    const stored = await app.exec('cat /run/crealityprint-idle/clients', { user: 'root' });
    return stored.split(' ')[0].trim() === state;
  }, { timeoutMs: STATE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS });
}

async function waitForNoAppProcesses(app, description) {
  await poll(description, async () => (await app.appTreeProcessCount()) === 0, {
    timeoutMs: STATE_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
  });
}

// Connect and wait until the idle daemon has started the app and its main window is up.
async function connectAndWaitForApp(app, page, startedCount) {
  app.resetMainWindowBaseline();
  await openSession(page, app.httpsUrl);
  await waitForLogCount(app, 'the app to be started on connect', STARTED_LOG, startedCount);
  await app.waitForMainWindow();
}

test.describe('close when idle', () => {
  test('the app closes without a browser, ignores uploads while closed and starts again on connect', async ({ page, startApp }, testInfo) => {
    const app = await startApp({
      label: 'idle',
      env: {
        IDLE_QUIT: 'true',
        IDLE_QUIT_AFTER: String(IDLE_SECONDS),
        AUTO_OPEN_UPLOADS: 'true',
        CP_PRINTER: 'Creality K1C',
      },
    });
    await app.waitForInit();

    // No browser has connected since boot: once it has had its first minute to start (the
    // start-up guard, longer than the 5 s idle time), the app and all its helpers are closed.
    await app.waitForAppProcess();
    await waitForLogCount(app, 'the app to be closed with no browser connected', CLOSED_LOG, 1, CLOSE_TIMEOUT_MS);
    expect(await app.logs()).toMatch(/\[crealityprint-idle\] Creality Print has only run for \d+s; closing it in \d+s/);
    await waitForNoAppProcesses(app, 'every app process to exit');

    // A file-API upload while closed is left in the folder, and the app stays closed.
    const cubeFile = writeCubeStl(testInfo.outputPath(), 'e2e idle.stl', 30);
    expect(await uploadViaApi(app.httpsUrl, 'e2e idle.stl', fs.readFileSync(cubeFile))).toBe(200);
    await poll(
      'the watcher to skip the upload',
      async () => (await app.logs()).includes('closed while idle (IDLE_QUIT); not opening /config/Desktop/e2e idle.stl'),
      { timeoutMs: STATE_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    expect(await app.appProcessCount()).toBe(0);

    // A browser connects: the app starts again, once, and is reachable on the session bus.
    await connectAndWaitForApp(app, page, 1);
    expect(await app.appProcessCount()).toBe(1);
    expect(app.appLogIncludes('load_files start filename /config/Desktop/e2e idle.stl')).toBe(false);
    await snap(page, testInfo, 'After connecting: the app has started again, without the upload made while it was closed');
    await app.exec('crealityprint-open "/config/Desktop/e2e idle.stl"');
    await app.waitForAppLog('load_files start filename /config/Desktop/e2e idle.stl');

    // The last browser leaves: the app is closed again after the timeout, and comes back on
    // the next connect.
    await page.goto('about:blank');
    await waitForLogCount(app, 'the app to be closed again after the browser left', CLOSED_LOG, 2, CLOSE_TIMEOUT_MS);
    await waitForNoAppProcesses(app, 'every app process to exit again');
    await connectAndWaitForApp(app, page, 2);
    expect(await app.appProcessCount()).toBe(1);

    // An app the user closed stays closed: leaving and coming back doesn't start it.
    await app.exec('pkill -x CrealityPrint');
    await waitForNoAppProcesses(app, 'the app closed by the user to exit');
    await page.goto('about:blank');
    await waitForClientsState(app, 'absent');
    await openSession(page, app.httpsUrl);
    await waitForClientsState(app, 'present');
    expect(await app.appProcessCount()).toBe(0);
    expect(countOccurrences(await app.logs(), STARTED_LOG)).toBe(2);
    await snap(page, testInfo, 'After the user closed the app: reconnecting leaves the desktop empty');
  });
});

// The base image's app restarter (RESTART_APP=true, which HARDEN_OPENBOX=true also turns on)
// starts the app again right after an idle close, so init keeps the feature off and says why.
// Init only: no app, no browser.
test.describe('close when idle stays off next to an app restarter', () => {
  const cases = [
    { setting: 'RESTART_APP=true', env: { RESTART_APP: 'true' }, hint: false },
    { setting: 'HARDEN_OPENBOX=true', env: { HARDEN_OPENBOX: 'true' }, hint: true },
  ];
  for (const { setting, env, hint } of cases) {
    test(`with ${setting}, IDLE_QUIT logs why and installs nothing`, async ({ startApp }) => {
      const app = await startApp({
        label: 'idle-restarter',
        env: { IDLE_QUIT: 'true', IDLE_QUIT_AFTER: String(IDLE_SECONDS), ...env },
      });
      await app.waitForInit();
      const logs = await app.logs();
      expect(logs).toContain('[crealityprint-idle] RESTART_APP is on; IDLE_QUIT stays off');
      expect(logs.includes('HARDEN_OPENBOX=true turns RESTART_APP on')).toBe(hint);
      // No FIFO means svc-crealityprint-idle only sleeps: the feature is off.
      expect(await app.idleFootprint()).toBe('');
    });
  }
});

// /run survives `docker restart`, so the previous start's runtime dir is still there when init
// runs again. Init must start it over: a leftover quit marker would make the upload watcher skip
// every upload. The hooks need no cleanup: s6 rebuilds its container environment on every start.
// Init only: the idle timeout is long, so the app is never closed.
test.describe('close when idle after a docker restart', () => {
  test('the runtime dir starts over and the hooks are installed again', async ({ startApp }) => {
    const app = await startApp({
      label: 'idle-restart',
      env: { IDLE_QUIT: 'true', IDLE_QUIT_AFTER: '3600' },
    });
    await app.waitForInit();
    // What an idle close leaves behind (crealityprint-idle's quit marker).
    await app.exec('touch /run/crealityprint-idle/quit-for-idle');

    await app.restart();
    await app.waitForInit();

    const logs = await app.logs();
    expect(countOccurrences(logs, '[crealityprint-idle] on: ')).toBe(2);
    expect(logs).not.toContain('IDLE_QUIT stays off');
    expect(await app.idleFootprint()).toBe(
      'SELKIES_RUN_AFTER_CONNECT\nSELKIES_RUN_AFTER_DISCONNECT\n/run/crealityprint-idle',
    );
    const runtimeFiles = await app.exec('ls /run/crealityprint-idle', { user: 'root' });
    expect(runtimeFiles.trim().split('\n')).toEqual(['clients', 'events']);
    const fifoCheck = await app.exec('test -p /run/crealityprint-idle/events && echo fifo', { user: 'root' });
    expect(fifoCheck.trim()).toBe('fifo');
  });
});
