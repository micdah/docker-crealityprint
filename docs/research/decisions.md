# Decisions and risks

What the image does and why, what was rejected, and what to keep an eye on. The evidence is in the topic docs: [base-image.md](base-image.md), [app.md](app.md), [gpu.md](gpu.md), [persistence.md](persistence.md), [files.md](files.md), [printers.md](printers.md) and [idle-quit.md](idle-quit.md).

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.

## Base image

- `ghcr.io/linuxserver/baseimage-selkies:debiantrixie`, pinned by digest in the `Dockerfile`. Renovate proposes digest bumps as PRs, and each one runs the full CI.
  - The Creality Print AppImage is built on Ubuntu 24.04 and links webkit2gtk-4.1 and libsoup-3, which Debian trixie provides [V].
  - Pinned because LinuxServer changes the base image without release notes.
  - Rejected: `ubunturesolute`. Its pango 1.57 crashed AppImages built against an older pango: docker-orcaslicer moved to trixie for this (docker-orcaslicer #36), and Creality Print #567 showed the same crash [V, issues]. Creality Print 7.3.2 now bundles its own pango 1.52.2 and puts it first on its library path, and it ran on Ubuntu 26.04 in the Rust Selkies port (see [selkies-rust.md](selkies-rust.md)) [V]. So pango is no longer a reason against an Ubuntu base; GTK and WebKit still come from the host. `ubuntunoble` is deprecated upstream.
- Wayland mode (`PIXELFLUX_WAYLAND=true`), as in docker-orcaslicer. The launcher puts the app on Xwayland `:0` with `GDK_BACKEND=x11` [I: copied from docker-orcaslicer and not A/B-tested here; Creality Print's native Wayland mode has open upstream bugs]. The helper scripts depend on this: they reach the app on `DISPLAY=:0`.
- amd64 only. Creality publishes no aarch64 AppImage [V].

## Installing the app

- The build downloads the release named in `ARG CREALITYPRINT_VERSION` (`/releases/tags/<tag>`), never `releases/latest`. docker-orcaslicer computes a version but downloads `releases/latest`, so its pin does nothing [V].
- Only assets named `^CrealityPrint-V[0-9.]+-x86_64-Release\.AppImage$` qualify. With several matches (v7.3.0 had three), the highest build number wins. No match fails the build. The sha256 is checked against the GitHub asset digest.
  - Creality's asset names have changed several times (e.g. `CrealityPrint_Ubuntu2404-V…`), so failing loudly beats picking the wrong file. The few community images that exist broke exactly here: they took the first AppImage of the latest release, or matched an old naming scheme [V].
- The AppImage is extracted with `--appimage-extract` (there is no FUSE in a container) to `/opt/crealityprint`, and its directories are made 0755, because they extract as 0700 [V]. Nothing else in it is changed.
- The build fails when `ldd` reports a library the image doesn't provide.

## Packages

| Installed | Why |
|---|---|
| `libwebkit2gtk-4.1-0` | The only library `ldd` reports missing on the base, together with its JavaScriptCore and libsoup-3 dependencies [V] |
| `inotify-tools`, `jq` | Upload watcher and first-run seed |
| `mesa-utils` | `glxinfo` for GPU diagnostics |

Not installed, on purpose:

- **The optional gstreamer plugins** (`-gl`, `-libav`, `-plugins-bad`, `-tools`, `-x`). Both camera paths (MJPEG and WebRTC) work without them, and they cost about 250 MB [V, K1C]. `-plugins-base` and `-plugins-good` come in anyway as webkit dependencies.
- **`vainfo`.** It re-arms the base's i965 probe, which picks the i965 VA driver on Intel Gen9 (UHD 630) and gives a black stream [V]. The build purges it in case a base update ships it (the Rust Selkies base does), and the smoke test fails if it is present.
- **Firefox** (about 250 MB). It is only needed for Google/Apple login to Creality Cloud, which opens a browser inside the container. Email/password and QR-code login run in the app's own web view [V source; not tested with a real account].
- **Variable UI fonts** (`fonts-adwaita`, Cantarell VF). The app's static FreeType crashes on variable fonts (Creality Print #607, #621, #637) [V, issues]. The base currently has none; its sans-serif is Noto Sans [V].
- **`libwx-perl`, `libmspack0` and locale generation**, which docker-orcaslicer has. Not needed: `libmspack` is bundled, and `AppRun` forces `LC_ALL=C` [V].

## Sharp UI on HiDPI screens

- **Opt-in `CP_UI_SCALE`** (whole numbers 1–4) becomes `GDK_SCALE` in the launcher, so the app draws itself larger at the browser's full resolution. Init then pins `SELKIES_SCALING_DPI=96` unless the user set it, so Selkies' UI Scaling stays at 100 % for every browser. The scale is per container (see [hidpi.md](hidpi.md)) [V].
- Rejected:
  - **Selkies' own UI Scaling:** labwc applies it as an output scale and stretches the Xwayland app as a bitmap, which blurs it (and on top of `CP_UI_SCALE` makes it 4x).
  - **Asking users to pick 100 % in the sidebar:** the choice is stored per browser, so every new browser starts at 200 % again.
  - **Turning off "HiDPI (Pixel Perfect)":** the browser then stretches the stream.
  - **Fractional scales** (`GDK_DPI_SCALE` alone, or 2x with smaller text): text only, or still a 2x layout; GTK3 has no fractional widget scale.
  - **A scale per browser that follows Selkies' slider:** needs a hook into Selkies internals and an app restart on every change.

## Services and defaults

- **System D-Bus off** (`svc-dbus` runs `sleep infinity`), as in docker-orcaslicer, which turned it off after `hostname1` activation failed with permission errors (docker-orcaslicer #24). Creality Print runs fine without it [V]; whether it would hit the same errors is untested [I]. The app's session bus comes from X11 autolaunch on `:0`, and that is enough for single-instance forwarding [V].
- **`SELKIES_AUDIO_ENABLED=false`.** The app needs no sound. In a connected session, pulseaudio alone took about 300 wakeups/s and 2.1 % of a core [V]; with pcmflux, audio is estimated at about 400/s and 3 % [I: per-process attribution, no on/off comparison yet, see Open questions]. Users can set it back to `true`.

- **Selkies' idle key loops are patched at build time** (`build/patches/`, see [base-image.md](base-image.md)). Two always-on loops woke the container about 60 times a second with nobody typing; the patch parks them until a client message arrives, and the build fails if the patch no longer applies exactly [V].
  - Rejected: a setting (none exists); waiting for upstream (the Python server is frozen, and the Rust rewrite keeps the same timers); replacing the two methods from outside, e.g. via `sitecustomize.py` (an upstream change would be silently overwritten instead of failing the build); slowing the loops down (stuck-key release and key repeat would get slower).
  - Not filed upstream: the Rust rewrite keeps the same timers (see the Rust Selkies section below).

## Launch and first run

- **One stable launcher**, `/usr/local/bin/crealityprint`, called by the autostart and both desktop menus. The base copies autostart and menus into `/config` once and never refreshes them, so the command they run must never change. Launch-time settings go in the launcher [V].
- **First-run seeding only on a fresh volume**, i.e. when no `Creality Print/<version>/` directory exists yet. A seeded config would stop the app from migrating an older data directory itself [V, source].
  - Always: decline the telemetry prompt (`privacyInfo.json` with `check: false`), and point Import/Export at the upload folder.
  - With `CP_PRINTER`: also add that printer with its vendor's default process and filament presets, which skips the setup wizard. A seed without `models` and `presets` leaves an unusable empty printer [V]. An unknown printer name logs a warning and leaves the wizard on.
  - Later starts never touch `Creality.conf`.
- **Ownership repair at start.** If anything in `/config/{.config,.local,.cache,.Creality,.dbus}` (two levels deep) isn't owned by `abc`'s uid and gid, those trees are re-owned recursively. Without this the desktop doesn't start after a PUID change [V]. The upload folder itself is re-owned non-recursively, so a NAS share mounted below it is never touched.

## Files

- **The upload folder** is Selkies' own: `SELKIES_FILE_MANAGER_PATH`, else `FILE_MANAGER_PATH`, default `/config/Desktop`. The seed and the watcher use the same folder.
- **Auto-open** (`AUTO_OPEN_UPLOADS=true`, opt-in) hands each finished upload to the running app through its single-instance D-Bus method. It never starts a second app next to a running one, and never edits `Creality.conf` at runtime. By default it opens meshes only; a 3MF would replace the project (the app asks first).
  - Rejected: setting `single_instance` in `Creality.conf` and starting a second process with the file. The app reads the flag only at start, and a prototype that did this opened a second window on top of the user's plate [V].
- **To lock down transfers,** use `SELKIES_FILE_TRANSFERS=none` and/or `PASSWORD`. `HARDEN_DESKTOP=true` only hides the Files panel [V].

## Printers

- **Default: Docker's bridge network, with the printer added by IP.** Status, Send Only uploads and both camera types work through NAT [V, K1C]. Automatic discovery (mDNS) doesn't cross the bridge network [V]. With host networking it fails on a host whose stateful firewall (ufw, firewalld) drops the printer's replies [V]; a firewall rule or macvlan should fix that [I, unverified].
- **Never start a print as a test.** Creality OS printers run their own heat-and-home routine for any file and can leave the heaters on [V, K1C]. CI never talks to a printer.

## Close when idle

- Opt-in `IDLE_QUIT=true` closes the app and its WebKit helpers (SIGTERM) after `IDLE_QUIT_AFTER` seconds without a browser. It starts the app again when a browser connects, but only if the timer closed it.
- It stays off next to the base's app restarter (`RESTART_APP`, which `HARDEN_OPENBOX` also turns on, and the Rust base's `SELKIES_APP_RESTART` and `EXIT_ON_APP_CLOSE`): a restarter undoes every idle close [V].
- Rejected:
  - **Freezing the app** (SIGSTOP/SIGCONT). The K1 WebRTC camera never recovered after a freeze, and the memory stays allocated [V].
  - **The base's `RESTART_APP` watchdog.** It polls with `pgrep` once a second, forever, and it would restart an app the idle timer had just closed.

## Rust Selkies: prepare, don't move yet

- **Stay on today's Python `debiantrixie` base.** Upstream rewrote Selkies in Rust (the base's `dev` tag, on Ubuntu 26.04 with a redesigned session). A trial port works, but `dev` is a floating pre-release whose contract still changes, and its server brings back the always-on key timers that the image patches out (see [selkies-rust.md](selkies-rust.md)) [V].
- The changes that already pay off today are in: the `IDLE_QUIT` restarter guard, the separate base-image Renovate PR and the `vainfo` purge. The rest of the port waits.
- **Revisit** at Selkies 2.3.0 or when `debiantrixie` switches to the Rust server, whichever comes first. The switch fails the base-image PR at the patch step, so it can't slip in unnoticed. Port within a few weeks of it, because the old digest then gets no base security rebuilds.
- The idle-timer regression isn't filed upstream; watch for a fix, and accept the cost if none comes.
- Rejected: moving to `dev` now; building our own patched Rust bundle; a CI job against `:dev`.

## Versions and CI

- **Track every plain `vX.Y.Z` release, including the ones GitHub flags as prerelease,** because creality.com offers those as the current download (7.3.2 was one) [V]. Suffixed tags (`-Beta`, …) are excluded. Each release arrives as its own Renovate PR. The base-image digest gets its own weekly PR, so a bump that fails the build (e.g. at the patch step) doesn't hold up the other tooling updates, which come in one weekly PR.
  - Rejected: `releases/latest` (stable only), which would lag behind creality.com; and a separate `:beta` tag.
- **Image tags:** `:latest`, `:<version>` and `:<version>-r<run>`. `latest` is rebuilt weekly without the build cache, so the Debian packages pick up security fixes.
- **CI publishes the exact image it tested.**

## Risks to watch

| Risk | Sign | What to do |
|---|---|---|
| A new data directory (7.4, 8.0, …) | Creality's migration rules are hard-coded for 7.3 [V, source] | Before releasing such an image, test that a 7.3 `/config` migrates |
| A release whose data directory isn't its `<major>.<minor>` | The init seeds `<major>.<minor>` of the release, but Creality sets the data directory separately (7.0–7.2 all used `7.0`). The seed would land in an unused directory and the wizard would run [I] | The seed e2e test fails (it finds two data directories) |
| ABI drift in a base bump (pango, glib) | Crashes, e.g. in Preferences | CI runs e2e on every Renovate PR; also open Preferences, slice and open Preview by hand (not in CI) |
| Asset naming changes | The build fails at asset selection | Adjust the regex in `build/fetch-crealityprint.sh` |
| A base bump changes Selkies' DPI handling (the operator lock, the default-DPI rule, the output-scale model) | `CP_UI_SCALE` turns blurry again | `scale.spec.js` checks the Xwayland size and that UI Scaling is hidden |
| A base bump changes Selkies' patched file | The base-image PR fails at the patch step | Re-read the two loops and `on_message`, regenerate the patch ([base-image.md](base-image.md)) |
| A variable UI font in the base | The app crashes at start | CI smoke and e2e tests fail |
| `debiantrixie` switches to the Rust Selkies | The base-image PR fails at the patch step | Port the image: the known breakages (the `svc-dbus` override, services that depend on the removed `svc-de`, ownership of `/config/.XDG` and `ssl` after a `PUID` change), the idle-timer regression and Mesa 26's #604 risk are listed with a checklist in [selkies-rust.md](selkies-rust.md) [V] |
| Intel GPU hang after slicing on Mesa 26 (Creality Print #604) | The base moves to Mesa 26 (now 25.0.7) | `INTEL_DEBUG=noccs` |
| Creality Cloud may identify the device by MAC address [I] | Re-login after a re-create (new MAC) | Optional fixed `mac_address:`, untested |
| Unsaved-project backup lives in `/tmp` | Lost on re-create; often not offered after a `docker restart`, because the restarted app gets the same PID and takes the backup for its own [V] | Documented in the README: save projects |
| After restoring unsaved work, the app redraws continuously (about 11 cores without a GPU) until the first click in the 3D view [V] | High CPU after a restore | The README tells users to click once into the view |
| The app's update check can't be turned off | — | Harmless: on Linux it only opens a download link [V, source] |

## Open questions

- **CPU saved by `SELKIES_AUDIO_ENABLED=false` while a browser is connected**, measured as an on/off comparison rather than from a profile.
- **Creality Cloud login** (email/QR), and whether the MAC address matters. Untested.
- **Automatic discovery** with host networking on a host without a stateful firewall, and with macvlan. K2-family printers are untested too.
- **NVIDIA and AMD GPUs.**
- **Manual checks:** a real OS drag-and-drop, and the clipboard in Firefox.
- **HiDPI at 2x:** the 3D view starts zoomed far out; the slice preview's legend and layer slider and the dialogs from #589/#654 are unchecked; the no-GPU CPU cost was taken from `docker stats` snapshots and should be re-measured from the cgroup with repeats (see [hidpi.md](hidpi.md)).
- **A multi-hour session without a GPU:** does the one-off +240 MB WebKit memory step repeat? See [gpu.md](gpu.md).
