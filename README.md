# Creality Print in the browser

A Docker image that runs [Creality Print](https://github.com/CrealityOfficial/CrealityPrint), Creality's 3D-printer slicer, as a web app. It is built on linuxserver's [Selkies base image](https://github.com/linuxserver/docker-baseimage-selkies), the same approach as [linuxserver/docker-orcaslicer](https://github.com/linuxserver/docker-orcaslicer). Open a browser tab and you get the full desktop app, streamed from your server.

- **amd64 only.** Creality publishes no arm64 Linux build.
- The research behind every design choice is in [docs/research/](docs/research/README.md).

## Quick start

```yaml
# docker-compose.yml (see docker-compose.example.yml for every option)
services:
  crealityprint:
    image: ghcr.io/micdah/docker-crealityprint:latest
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Copenhagen
      - CP_PRINTER=Creality K1C        # optional: skip the setup wizard
    volumes:
      - ./config:/config
    ports:
      - 3001:3001
    devices:
      - /dev/dri:/dev/dri              # optional: Intel/AMD GPU
    shm_size: "1gb"
    restart: unless-stopped
```

Then open **`https://<host>:3001`** and accept the self-signed certificate, or put the container behind your own TLS reverse proxy.

> **HTTPS is required.** The browser only enables the video decoder and the clipboard on a secure page. Over plain `http://` on a LAN address you get a black page. (The plain-HTTP port 3000 is only meant for a reverse proxy in front of the container.)

## GPU acceleration (recommended)

Pass the GPU with `--device /dev/dri:/dev/dri` (compose: `devices: [/dev/dri:/dev/dri]`). No environment variables are needed. The GPU then does two jobs:
- it renders Creality Print's 3D view in OpenGL;
- it encodes the video stream to the browser in hardware (VA-API).

Container CPU use while rotating a model, measured on an Intel UHD 630:

| Browser stream | With GPU | Without GPU |
|---|---|---|
| 1600×900 | ~0.65 cores | ~2.5 cores |
| 3200×1800 (HiDPI laptop) | ~0.6 cores | ~7 cores |

Without a GPU everything still works, using software rendering. The cost then grows with the size of the browser window. Plan for about 2 GiB RAM per container.

NVIDIA and AMD GPUs are untested. NVIDIA needs the NVIDIA container toolkit and host driver 580+ (see [docs/research/04](docs/research/04-gpu-acceleration.md)). Don't add `vainfo` to a derived image: on some Intel GPUs it switches the video driver and the stream goes black.

## Your settings are kept

Everything lives in the `/config` volume:
- settings, printers, presets, Creality Cloud login (`/config/.config/Creality/Creality Print/<version>/`);
- the app's web storage;
- the files you upload.

Restarting, re-creating or upgrading the container keeps them all. When Creality moves to a new settings folder (as with 7.0 → 7.3), the app migrates your settings itself. Changing `PUID`/`PGID` on an existing `/config` is handled: the image re-owns the app and desktop state at startup. (The upload folder is only re-owned at its top level, so a NAS share mounted inside it is never touched.)

Back up by copying the `config` folder while the container is stopped. The only state outside `/config` is the app's crash-recovery copy of an *unsaved* project (in `/tmp`), so save your projects.

### First run

On a fresh `/config` the image always:
- declines Creality's "User Experience Improvement Program" (telemetry) prompt;
- points the app's Import/Export dialogs at the upload folder.

Set `CP_PRINTER` (plus optional `CP_NOZZLE` and `CP_REGION`) to skip the setup wizard. The printer is then added with its default process and filament presets. The name must match the app's printer list, e.g. `Creality K1C`, `Creality K1 Max`, `Creality K2 Plus`. An unknown name logs a warning and you get the normal wizard.

## Getting files in and out

The app runs on the server, so its "Open file" dialog **cannot** see your laptop's files. Use the Selkies sidebar instead. Open it with the handle on the left edge of the page, then go to **Files**:

- **Upload Files** opens your browser's file picker. You can also **drag files onto the page**. Uploads land in **`/config/Desktop`**, which is where Creality Print's Import dialog opens.
- **Download Files** lists that folder, with a download button per file. Export G-code or 3MF into `/config/Desktop` to fetch it.
- **NAS / file server:** mount a share below the upload folder, e.g. `-v /mnt/nas/3d:/config/Desktop/nas`. It then shows up in both the Files panel and the app.
- **Auto-open uploads:** with `AUTO_OPEN_UPLOADS=true`, every uploaded or dropped model is added to the open plate about a second later.
  - Unsaved work is kept, and 3MF projects aren't auto-opened by default.
  - New models land at the bed centre, so press **Arrange** afterwards.
  - `AUTO_OPEN_PATTERN` (a regex) changes which files are opened.
- **Clipboard:** text copies both ways (Ctrl+C / Ctrl+V on the page); allow the browser's clipboard prompt.

**Lock it down.** Without a password, anyone who can reach the port can use the app and read or write `/config/Desktop`.
- Set `PASSWORD` (user `abc`, or `CUSTOM_USER`), or put the container behind an authenticating proxy.
- `SELKIES_FILE_TRANSFERS=none` turns browser upload and download off completely. Note that `HARDEN_DESKTOP=true` only hides the Files panel; transfers still work.

## Printers

Tested with a Creality K1C over Docker's default (bridge) network:
- add the printer **by IP address** (the dialog takes an IP, not a hostname);
- live status, sending G-code, and the camera (MJPEG and WebRTC) all work;
- give the printer a fixed IP (DHCP reservation), because it is stored by IP.

**Automatic discovery** uses mDNS, which Docker's bridge network doesn't forward. With `network_mode: host` it can work, but a host firewall (ufw/firewalld) still drops the printer's replies. In that case allow them, e.g. `ufw allow proto udp from 192.168.1.0/24 port 5353`. This setup is unverified.

> **Careful when testing.** Starting *any* print on a Creality OS printer (K1/K2 series) makes the printer run its own heat-and-home routine, even for a file with no heating commands. A file without end G-code can leave the heaters on. To check the connection, use **Send Only** (upload without printing).

**Creality Cloud:** log in with email/password or the QR code. Google/Apple login would open a browser *inside* the container, and no browser is installed.

## Sharp UI on HiDPI screens (optional)

On a HiDPI screen (a 4K monitor or a "Retina" laptop) the app looks tiny at Selkies' default size. Selkies' own **UI Scaling** setting makes it bigger, but **blurry**, because it stretches the finished picture.

Set `CP_UI_SCALE=2` instead, and leave Selkies' UI Scaling at **100 %**:
- Creality Print then draws itself at twice the size, at your screen's full resolution, so text, icons and the 3D view stay sharp.
- On a screen at 300 %, use `3`. Only whole numbers from 1 to 4 work; for in-between sizes see below.
- Don't combine it with Selkies' UI Scaling: both together make the UI four times as big, and the stretching brings the blur back. If you raised it earlier, set it back to 100 % in the sidebar (**Screen Settings**). Keep **HiDPI (Pixel Perfect)** on there (the default), so the stream uses your screen's full resolution.
- The setting is per container. Every browser gets the same scale, so on a normal (non-HiDPI) monitor the UI also looks twice as big.
- At 2x the app has as much room as your browser window measures in CSS pixels (a 4K screen at 200 % is 1920×1080). Below about 1600×900 its panels get cramped and overlap, so use a large or full-screen window. Selkies' own scaling has the same limit.
- It applies when the app starts. After changing it, re-create the container (e.g. `docker compose up -d`); a plain restart keeps the old value.
- The container log confirms it with a line starting `[crealityprint-init] UI scale`.
- Text a bit too large at 2? Add `GDK_DPI_SCALE=0.85` (text only, icons stay 2x).

Why Selkies' scaling blurs this app, and what was tested, is in [docs/research/14](docs/research/14-hidpi-scaling.md).

## Close when idle (optional)

If the server runs all the time but you only open the app now and then, you can let the container close the app while nobody is connected. Even with no browser tab open, the running app keeps using CPU (the container sits at about 2–3 % of one core), keeps waking the CPU so it can't stay in its deepest power-saving states, and holds over 1 GiB of memory.

Turn it on with `IDLE_QUIT=true`. Once no browser tab has been connected for `IDLE_QUIT_AFTER` seconds (default `1800`, 30 minutes), Creality Print is closed:
- **Closed:** Creality Print and its child processes (the WebKit helpers). There is no "save changes?" prompt.
- **Still running:** Selkies and the desktop (Xwayland, labwc), so the next browser tab can connect.
- **Coming back:** when a browser tab connects, the app starts again by itself. It takes a few seconds and opens with an empty plate.
- **Unsaved work:** the app keeps its own backup of an unsaved project. On the next start it asks "Previously unsaved items have been detected. Do you want to restore them?"; choose **Yes** to get your plate back. The backup lives in the container's `/tmp`, so it survives a restart of the container but not a re-create. Save your project to keep it for sure.
- The timer also starts when the container starts, because nobody is connected then.
- Only an app closed by the timer comes back by itself. If you close the app yourself, start it again from the desktop's right-click menu.
- "Connected" means a Selkies session is open: a browser tab you forgot in the background keeps the app running.

When the app is closed:
- Anything it was still doing stops: a slice, or sending G-code to a printer. A print already running on the printer carries on.
- Printer connections drop, and connect again when the app starts. That includes the printer camera (WebRTC, e.g. K1 series).
- With `AUTO_OPEN_UPLOADS=true`, a file uploaded through the file API with no tab open (e.g. with `curl`) isn't opened, and doesn't start the app. It stays in `/config/Desktop`, so import it after you reconnect. Uploads from the browser sidebar always have a tab open, so they are opened as usual.

| No browser connected | App running | App closed |
|---|---|---|
| Whole container, CPU | ~3 % of a core | ~1 % of a core |
| Context switches (≈ CPU wakeups) | ~114/s | ~70/s |
| Memory | ~1.4 GiB | ~160 MiB |

Selkies keeps running while the app is closed (about 0.7 % of a core). The log shows each step on lines starting with `[crealityprint-idle]`. If you already use `SELKIES_RUN_AFTER_CONNECT` or `SELKIES_RUN_AFTER_DISCONNECT`, the feature stays off and logs a warning, because it needs those two hooks. Details are in [docs/research/13](docs/research/13-idle-quit.md).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PUID` / `PGID` | `911` | User/group that owns `/config` (use your own `id -u` / `id -g`) |
| `TZ` | `Etc/UTC` | Time zone |
| `CP_PRINTER` | – | First run only: add this printer and skip the wizard |
| `CP_NOZZLE` | `0.4` | Nozzle for `CP_PRINTER` |
| `CP_REGION` | `Europe` | Creality Cloud region for `CP_PRINTER` (`Europe`, `North America`, `Asia-Pacific`, …) |
| `AUTO_OPEN_UPLOADS` | `false` | Add uploaded models to the open plate |
| `AUTO_OPEN_PATTERN` | meshes (`stl obj step stp amf ply oltp`) | Regex of file names to auto-open (case-insensitive) |
| `CP_UI_SCALE` | – | `2` (or `3`, `4`) draws the app at that scale, sharp on HiDPI screens; keep Selkies' UI Scaling at 100 % (see [Sharp UI on HiDPI screens](#sharp-ui-on-hidpi-screens-optional)) |
| `IDLE_QUIT` | `false` | `true` closes the app while no browser is connected, and starts it again when one connects (see [Close when idle](#close-when-idle-optional)) |
| `IDLE_QUIT_AFTER` | `1800` | Seconds with no browser connected before the app is closed |
| `PASSWORD`, `CUSTOM_USER` | – | Basic-auth login for the UI and file API |
| `SELKIES_FILE_TRANSFERS` | `upload,download` | `none` disables browser file transfer |
| `SELKIES_AUDIO_ENABLED` | `false` (image default) | Sound from the app to the browser. Off because Creality Print needs none, and streaming it costs about 3 % of a core while a browser is connected. `true` turns it back on (and with it the microphone) |
| `FILE_MANAGER_PATH` | `/config/Desktop` | Upload/download folder (also where the app's Import/Export dialogs open on first run) |

The rest of the Selkies/linuxserver options (`CUSTOM_PORT`, `CUSTOM_HTTPS_PORT`, `SELKIES_*`, …) work as described in the [Selkies base image docs](https://docs.linuxserver.io/images/docker-baseimage-selkies/).

## Versions and updates

- `:latest` is the newest Creality Print release on GitHub with a plain `vX.Y.Z` tag. That **includes releases GitHub flags as prerelease**, because creality.com offers those as the current download.
- Every build is also tagged `:<version>` (e.g. `:7.3.2`) and `:<version>-r<build>`. Pin one of those to control upgrades. Rolling back within the same settings folder (e.g. 7.3.x) keeps your settings.
- New Creality Print releases and Selkies base-image updates arrive as reviewed Renovate PRs. In addition, `latest` is rebuilt weekly without the build cache, so the Debian packages the image adds (e.g. WebKit) pick up security fixes.

## Development

```bash
docker build -t crealityprint:dev .
tests/smoke.sh crealityprint:dev                    # ~1 minute
tests/run-e2e.sh crealityprint:dev                  # full Playwright suite (GPU spec needs /dev/dri)
tests/run-e2e.sh crealityprint:dev --spec watcher   # one spec
tests/run-e2e.sh crealityprint:dev --app-cpus 4 --workers 1   # mimic a CI runner
```

The e2e specs start their own containers via the Docker socket and never touch a printer. Each visible check takes a named screenshot of what it verified, e.g. "After uploading e2e watch.stl: the 40 mm cube is on the plate". They are shown inline in the HTML report (`e2e-artifacts/report/index.html`) and saved as numbered files in `e2e-artifacts/screenshots/<spec>/`.

**CI** (`.github/workflows/build.yml`) runs on every PR:
- lint and one image build, in parallel;
- then the smoke test and one e2e job per spec, in parallel;
- on `master`, it publishes the exact tested image to GHCR.

PRs can be reviewed without checking them out:
- Each run's job summary lists the test results.
- A `report` job merges the per-spec reports into one HTML report with every screenshot inline. It publishes the report to GitHub Pages (`https://<owner>.github.io/<repo>/pr-<number>/`). A `comment` job then links it in a sticky PR comment that is updated on every run and names the commit it describes, also when no report could be published. The comment also embeds the watcher spec's screenshot of the app with a model loaded on the plate, as a quick smoke check that the app started and renders; open the full report only when that looks wrong. Pushes to `master` publish to `…/master/`.
- A PR's report is removed when it closes. A weekly cleanup also prunes reports of closed PRs and squashes the `gh-pages` history to one commit, so it doesn't grow. Fork PRs don't get a published report.
- The artifacts also hold the raw report, screenshots and logs.

One-time setup: after the first run has created the `gh-pages` branch, enable Pages under Settings → Pages with source "Deploy from a branch" and branch `gh-pages` / root. Make **`ci-ok`** the required status check in the `master` branch protection.

After the first publish, the GHCR package is private: make it public in the package settings if others should pull it.

**Updates** come as [Renovate](https://github.com/apps/renovate) PRs. Install the free Renovate GitHub App on the repository. It proposes:
- new Creality Print releases;
- base-image digest bumps;
- Playwright and GitHub Actions updates.

## License

The image's own files are provided as-is. Creality Print is © Creality and licensed under [AGPL-3.0](https://github.com/CrealityOfficial/CrealityPrint/blob/master/LICENSE.txt). The image ships the unmodified official AppImage, and the exact upstream release is recorded in the image label `crealityprint.upstream`.
