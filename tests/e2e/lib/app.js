// Helpers to run and inspect Creality Print app containers from the specs.
//
// Every container gets the run's label (so tests/run-e2e.sh can clean up leftovers), a
// Docker-assigned port on 127.0.0.1 (so parallel specs never clash), and a /config bind
// mount under the shared work dir (same path on the host and in the runner).

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const image = process.env.E2E_IMAGE;
const runId = process.env.E2E_RUN_ID || 'local';
const workDir = process.env.E2E_WORK_DIR;
const appCpus = process.env.E2E_APP_CPUS || '';
const hostUid = String(process.getuid());
const hostGid = String(process.getgid());

const APP_CONFIG_ROOT = '/config/.config/Creality/Creality Print';

async function docker(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (allowFailure) {
      return error.stdout || '';
    }
    throw new Error(`docker ${args.join(' ')} failed: ${error.stderr || error.message}`);
  }
}

async function poll(description, check, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function newConfigDir(label) {
  const dir = path.join(workDir, `${label}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class AppContainer {
  constructor(name, configDir) {
    this.name = name;
    this.configDir = configDir;
    this.httpsUrl = null;
  }

  // Start a container. Options: label, env {}, configDir, devices [], puid/pgid.
  static async start({ label, env = {}, configDir, devices = [], puid = hostUid, pgid = hostGid }) {
    const name = `crealityprint-e2e-${label}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = configDir || newConfigDir(label);
    const args = [
      'run', '--detach',
      '--name', name,
      '--label', `crealityprint-e2e=${runId}`,
      '--shm-size', '1gb',
      '--publish', '127.0.0.1::3001',
      '--env', `PUID=${puid}`,
      '--env', `PGID=${pgid}`,
      '--env', 'TZ=Etc/UTC',
      '--volume', `${dir}:/config`,
    ];
    if (appCpus) {
      args.push('--cpus', appCpus);
    }
    for (const device of devices) {
      args.push('--device', device);
    }
    for (const [key, value] of Object.entries(env)) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(image);

    const app = new AppContainer(name, dir);
    app.markerBaseline = app.countMainWindowMarkers();
    await docker(args);
    const portLine = (await docker(['port', name, '3001/tcp'])).trim().split('\n')[0];
    app.httpsUrl = `https://${portLine}`;
    return app;
  }

  // Container stdout and stderr together (the init scripts write to both).
  async logs() {
    try {
      const { stdout, stderr } = await execFileAsync('docker', ['logs', this.name], {
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout + stderr;
    } catch (error) {
      return (error.stdout || '') + (error.stderr || '');
    }
  }

  async exec(command, { user = 'abc', env = {} } = {}) {
    const args = ['exec', '--user', user];
    for (const [key, value] of Object.entries(env)) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(this.name, 'bash', '-c', command);
    return docker(args);
  }

  // Init done *and* Selkies serving: right after init, nginx answers /api/* with 404 until
  // the Selkies server (127.0.0.1:8082 inside the container) is up.
  async waitForInit() {
    await poll('container init', async () => (await this.logs()).includes('[ls.io-init] done.'));
    await poll('the Selkies server', async () => {
      const status = await docker(
        ['exec', this.name, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
          'http://127.0.0.1:8082/api/file-manager/browse?path='],
        { allowFailure: true },
      );
      return status.trim() !== '' && status.trim() !== '000';
    }, { intervalMs: 500 });
  }

  // What init-crealityprint-idle installed: the SELKIES_RUN_AFTER_* hooks and the runtime dir,
  // one per line. Empty when close-when-idle is off.
  async idleFootprint() {
    const output = await this.exec(
      'ls /run/s6/container_environment | grep SELKIES_RUN_AFTER || true; ls -d /run/crealityprint-idle 2> /dev/null || true',
      { user: 'root' },
    );
    return output.trim();
  }

  async appProcessCount() {
    const output = await docker(['exec', this.name, 'pgrep', '-c', '-x', 'CrealityPrint'], { allowFailure: true });
    return Number.parseInt(output.trim() || '0', 10);
  }

  // The running app's environment as { NAME: value }: what the launcher actually exported.
  async appEnvironment() {
    const output = await this.exec('tr "\\0" "\\n" < "/proc/$(pgrep -o -x CrealityPrint)/environ"');
    const environment = {};
    for (const line of output.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) {
        environment[line.slice(0, separator)] = line.slice(separator + 1);
      }
    }
    return environment;
  }

  async waitForAppProcess() {
    await poll('the CrealityPrint process', async () => (await this.appProcessCount()) > 0);
  }

  // How often the app has logged its printer-manager web view, which it does once the main
  // window is up. Read from the host side so it also works before the container starts.
  countMainWindowMarkers() {
    const appRoot = path.join(this.configDir, '.config/Creality/Creality Print');
    let count = 0;
    if (!fs.existsSync(appRoot)) {
      return count;
    }
    for (const versionDir of fs.readdirSync(appRoot)) {
      const logDir = path.join(appRoot, versionDir, 'log');
      if (!fs.existsSync(logDir)) {
        continue;
      }
      for (const logFile of fs.readdirSync(logDir)) {
        const content = fs.readFileSync(path.join(logDir, logFile), 'utf8');
        count += content.split('PrinterMgrView').length - 1;
      }
    }
    return count;
  }

  // Wait for a *new* marker: a reused /config already holds markers from earlier runs.
  async waitForMainWindow() {
    await this.waitForAppProcess();
    await poll('the app main window', async () => this.countMainWindowMarkers() > this.markerBaseline, {
      timeoutMs: 300000,
    });
  }

  // Whether the app's own log (not docker logs) contains text: proof the app itself acted.
  appLogIncludes(text) {
    const appRoot = path.join(this.configDir, '.config/Creality/Creality Print');
    if (!fs.existsSync(appRoot)) {
      return false;
    }
    for (const versionDir of fs.readdirSync(appRoot)) {
      const logDir = path.join(appRoot, versionDir, 'log');
      if (!fs.existsSync(logDir)) {
        continue;
      }
      for (const logFile of fs.readdirSync(logDir)) {
        if (fs.readFileSync(path.join(logDir, logFile), 'utf8').includes(text)) {
          return true;
        }
      }
    }
    return false;
  }

  async waitForAppLog(text, timeoutMs = 30000) {
    await poll(`the app log to contain "${text}"`, async () => this.appLogIncludes(text), { timeoutMs });
  }

  // How many app processes exist: CrealityPrint itself plus its WebKit helpers. Matched as a
  // prefix: the kernel cuts process names to 15 characters ("WebKitNetworkPr").
  async appTreeProcessCount() {
    const output = await docker(
      ['exec', this.name, 'pgrep', '-c', '^(CrealityPrint|WebKit)'],
      { allowFailure: true },
    );
    return Number.parseInt(output.trim() || '0', 10);
  }

  async readAppFile(fileName) {
    const output = await this.exec(`cat "${APP_CONFIG_ROOT}"/[0-9]*/"${fileName}"`);
    return JSON.parse(output);
  }

  async stop() {
    await docker(['stop', '--time', '30', this.name], { allowFailure: true });
  }

  // Attach logs to the test report, then remove the container.
  async remove(testInfo) {
    if (testInfo) {
      await this.attachDiagnostics(testInfo);
    }
    await docker(['rm', '--force', '--volumes', this.name], { allowFailure: true });
  }

  async attachDiagnostics(testInfo) {
    const containerLogs = await this.logs().catch(() => '');
    await testInfo.attach(`${this.name}-docker.log`, { body: containerLogs, contentType: 'text/plain' });
    const appLogs = await this.exec(
      `tail -n 400 "${APP_CONFIG_ROOT}"/*/log/*.log* 2>/dev/null || true`,
    ).catch(() => '');
    if (appLogs) {
      await testInfo.attach(`${this.name}-app.log`, { body: appLogs, contentType: 'text/plain' });
    }
  }
}

// A 20 mm cube as ASCII STL, written into dir; returns the path.
function writeCubeStl(dir, fileName, size = 20) {
  const s = size;
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const lines = ['solid cube'];
  for (const face of faces) {
    lines.push(' facet normal 0 0 0', '  outer loop');
    for (const index of face) {
      lines.push(`   vertex ${v[index].join(' ')}`);
    }
    lines.push('  endloop', ' endfacet');
  }
  lines.push('endsolid cube', '');
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = { AppContainer, newConfigDir, poll, writeCubeStl, sha256, docker, hostUid, hostGid, workDir };
