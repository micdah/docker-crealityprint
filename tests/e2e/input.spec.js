// Our Selkies patch (build/patches/selkies-park-idle-key-loops.patch, docs/research/base-image.md):
// Selkies' key loops park while nobody types, and still release a key whose key-up is lost.
const { test, expect } = require('./lib/fixtures');
const { poll } = require('./lib/app');
const { openSession } = require('./lib/selkies');
const { note } = require('./lib/evidence');

// Unpatched, the Selkies process wakes about 68 times a second with no client connected (its
// key loops alone about 60); patched about 8. With a client connected it is hundreds.
const IDLE_WAKEUPS_PER_SECOND_MAX = 25;
const SAMPLE_SECONDS = 5;
// Shift_L: a modifier, so the stale-key sweep is the only thing that releases it.
const KEYSYM_SHIFT_L = 65505;

// Context switches per second of the Selkies process over SAMPLE_SECONDS, summed per thread over
// the threads present at both ends (a thread that exits in between would take its count along).
async function selkiesWakeupsPerSecond(app) {
  const output = await app.exec(
    `pid="$(pgrep -o -x selkies)"
     per_thread() {
       for task in /proc/"$pid"/task/*; do
         echo "\${task##*/} $(awk '/ctxt_switches/ { n += $2 } END { print n }' "$task/status" 2> /dev/null)"
       done
     }
     before="$(per_thread)"; sleep ${SAMPLE_SECONDS}; after="$(per_thread)"
     awk 'NR == FNR { start[$1] = $2; next } ($1 in start) && $2 != "" { n += $2 - start[$1] } END { print int(n / ${SAMPLE_SECONDS}) }' \\
       <(echo "$before") <(echo "$after")`,
    { user: 'root' },
  );
  return Number.parseInt(output.trim(), 10);
}

// Sample until the rate is low: right after start-up or a client leaving Selkies is busier for
// a while. An unpatched Selkies never gets below the limit.
async function waitForIdleSelkies(app, description, timeoutMs) {
  const samples = [];
  await poll(
    description,
    async () => {
      const rate = await selkiesWakeupsPerSecond(app);
      samples.push(rate);
      return rate <= IDLE_WAKEUPS_PER_SECOND_MAX;
    },
    { timeoutMs, intervalMs: 0 },
  ).catch((error) => {
    throw new Error(`${error.message}; Selkies wakeups/s per ${SAMPLE_SECONDS}s sample: ${samples.join(', ')}`);
  });
  return samples;
}

// Send a raw client message on the page's Selkies WebSocket, bypassing the client's own key
// handling (which would send key-up and heartbeats).
async function sendRawClientMessage(page, message) {
  await poll('the Selkies WebSocket to be open', async () =>
    page.evaluate(() => window.selkiesTransport?.readyState === WebSocket.OPEN),
  { timeoutMs: 30000, intervalMs: 500 });
  await page.evaluate((text) => window.selkiesTransport.send(text), message);
}

test.describe('selkies input loops', () => {
  test('key loops stay parked while idle and still release a stuck key', async ({ page, startApp }, testInfo) => {
    const app = await startApp({ label: 'input', env: { CP_PRINTER: 'Creality K1C' } });
    await app.waitForInit();
    await app.waitForMainWindow();

    const idleBefore = await waitForIdleSelkies(app, 'Selkies to go idle before any client', 120000);

    // A key-down whose key-up and heartbeats never come, like a key-up lost to congestion:
    // it must wake the parked stale-key sweep, which releases it after its 2 s window.
    await openSession(page, app.httpsUrl);
    await sendRawClientMessage(page, `kd,${KEYSYM_SHIFT_L}`);
    const releaseLine = `Auto-releasing key ${KEYSYM_SHIFT_L} (heartbeat lost).`;
    await poll('Selkies to auto-release the stuck key', async () => (await app.logs()).includes(releaseLine), {
      timeoutMs: 20000,
      intervalMs: 500,
    });

    // Once the client is gone, the loops park again.
    await page.goto('about:blank');
    const idleAfter = await waitForIdleSelkies(app, 'Selkies to go idle after the client left', 120000);

    await note(
      testInfo,
      'Selkies wakeups with no client connected',
      `limit: ${IDLE_WAKEUPS_PER_SECOND_MAX}/s (unpatched: about 68/s)\n` +
        `before any client: ${idleBefore.join(', ')} per second (${SAMPLE_SECONDS}s samples)\n` +
        `stuck key: "${releaseLine}" logged\n` +
        `after the client left: ${idleAfter.join(', ')} per second\n`,
    );
    expect(idleAfter.at(-1)).toBeLessThanOrEqual(IDLE_WAKEUPS_PER_SECOND_MAX);
  });
});
