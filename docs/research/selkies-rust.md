# Rust Selkies (the base's `dev` tag)

Selkies' `main` branch is a Rust rewrite, and linuxserver's base image already ships it under the `dev` tag. This image stays on the Python `debiantrixie` for now. This doc covers what the Rust base is, how its contract differs from today's, what a port takes, how it performs, and when to move. Today's base is described in [base-image.md](base-image.md); the decision is recorded in [decisions.md](decisions.md).

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.

Verified against: base `dev` `4d7ee28c-ls23` (digest `sha256:374f927a…`, Ubuntu 26.04, Selkies prerelease `e109961`, Mesa 26.0.8) and base `debiantrixie` at `a7d1dfd` (Selkies 2.2.1 with this image's key-loop patch, Mesa 25.0.7), Creality Print 7.3.2, Docker 29 on x86_64 Arch Linux with an Intel UHD 630; upstream status as of 2026-11-26.

## Summary

- **The rewrite is not about performance.** Upstream wanted no Python interpreter, one package for every Python version, pixelflux and pcmflux linked directly, and a monorepo with one version. For WebSockets, which this image uses, the Selkies lead expects the gain to be "close to nothing" [V, selkies#422].
- **It is pre-release.** No version yet (2.3.0 is drafted, with no date), `dev` floats to the newest Selkies commit, and `debiantrixie` is still Python [V].
- **The port is small, and it works.** Three preparatory changes are already on master; the rest (five image changes, the base pin and two test tweaks) is kept for the move. With all of it, 15 of 16 e2e tests pass, GPU rendering and VA-API encoding work, a `/config` from today's image starts unchanged, and Ubuntu 26.04's pango doesn't crash the app [V].
- **About even under load, worse at idle.** Orbiting with a GPU costs about 6 points of a core less, because labwc and nginx no longer run. With the app closed, the container uses 0.48 % of a core and 105 wakeups/s, against 0.09 % and 8 today: the Rust server keeps the always-on key timers that this image patches out of Python, and a prebuilt binary can't be patched the same way [V].
- **Decision: prepare, but don't move yet.** Revisit at Selkies 2.3.0 or when `debiantrixie` switches, whichever comes first. The switch can't slip in: the Renovate base-image PR fails at the build's Selkies patch step [V].

## What it is

- One `selkies` binary on Axum, Tower and tokio, with its own WebRTC stack. pixelflux and pcmflux are crates in the same repo, and the web client is compiled into the binary [V, release notes and crates at `e1099614`].
- The headless Wayland compositor stays in pixelflux. A new window manager, `selkies-wm`, places the windows and runs Xwayland, so neither labwc nor openbox runs [V].
- Everything ships as one glibc 2.17 bundle in `/opt/selkies` (patched Xvfb, Xwayland, PulseAudio, dbus, the interposers), which the wheel, the distro packages and the images repackage [V].
- `selkies session` supervises the whole desktop: its own session bus (`/config/.XDG/bus`) and system bus, PulseAudio, `selkies-wm`, Xwayland `:0` and the autostart. The streaming server is its child [V].
- **Upstream's own benchmarks** (an NVIDIA L4, plus NVENC, x264 and VA-API on Intel and AMD, all on X11): lower CPU per frame, 26–38 % less RSS, and a much tighter WebRTC p90 latency. Software x264 is heavier (35.6 % vs 22.8 % CPU, a deliberate quality setting), and VP9 and AV1 over WebRTC lag behind. **Not validated upstream:** Wayland capture (this image's mode), DRI3 on non-NVIDIA GPUs, audio, input latency and long-session memory [V, selkies#517, #545].

## Status and roadmap

- **Pre-release.** Rust has been on `main` since 2026-11-08 (selkies#517). Every build is a per-commit prerelease versioned `0.0.0.dev0`: about 88 in the first two weeks, from about 270 commits a week, 91 % of them by two people [V].
- **The next release is 2.3.0.** Its release notes are drafted on `main`; no date or milestone is announced. Not released as of 2026-11-26 [V].
- **The Python line is frozen.** `legacy` was reset to 2.2.1 and has had no commits since. A 2.2 regression (iOS keyboard, selkies#609) was fixed only on `main`, and linuxserver patched its own Python base for it (`cc29015`). No end-of-life policy is published [V]. Nobody will fix 2.2.1 for this image either, which is why the key-loop patch is ours to keep ([base-image.md](base-image.md)).
- **When `debiantrixie` switches.** No date is announced. linuxserver moved its `master` to 2.0.0, 2.1.0 and 2.2.1 within about a day of each release [V], so expect `debiantrixie` to switch, with the whole base redesign, right after 2.3.0 [I]. As of 2026-11-26 base `master` is still `a7d1dfd`, on Python [V].
- **A trixie flavour is likely.** Upstream already publishes `ghcr.io/selkies-project/selkies/base:main-debiantrixie` on Rust [V], and the bundle doesn't depend on the distro [I].
- **Maturity** [V]: 18 open bugs, none of them crash or startup bugs, 9 about performance or congestion; 41 closed in 18 days, mostly within 0–3 days; about 70 % of reports come from the maintainers. CI is broad (19 workflows), but the nightly e2e run failed 18 of 20 nights. None of linuxserver's 88 images uses `dev` on a default branch. The base's `dev` broke its contract once (`c4dede0` removed nginx, `svc-de`, `svc-xorg`, `svc-dbus`, `svc-pulseaudio`, the menus and Docker), followed by at least four repair commits. Verdict: well engineered, but immature [I].

## How the base contract changes

What a downstream image like this one notices [V: both base images' s6 trees, init scripts and packages]:

| | `debiantrixie` (today) | `dev` (Rust) |
|---|---|---|
| Distro | Debian 13, Mesa 25.0.7 | Ubuntu 26.04: pango 1.57.0, GTK 3.24.52, Mesa 26.0.8 |
| Selkies | 2.2.1 wheels in `/lsiopy`, pinned | Bundle in `/opt/selkies`, **not pinned**: the newest `main` commit when the base was built |
| HTTP(S) | nginx on 3000/3001, proxying to Selkies on `127.0.0.1:8082` | `selkies session --port=3000 --https-port=3001` serves both itself; no 8082; `/api/health` answers without auth |
| s6 longruns | `svc-nginx`, `-pulseaudio`, `-xorg`, `-dbus`, `-selkies`, `-de`, `-xsettingsd`, `-watchdog`, `-docker`, `-cron` | `svc-selkies`, `svc-app-exit`, `svc-docker`, `svc-cron` |
| Session bus outside the desktop | Found through X11 autolaunch on `:0` | Only programs the WM starts inherit it. The session's environment is written to `$XDG_RUNTIME_DIR/selkies-session-env.json` |
| Autostart | `/defaults/autostart_wayland`, copied to `/config` if missing | Same |
| Menus | Copied to `/config` once | `/defaults/menu_wayland.xml` copied to `/etc/xdg/labwc/menu.xml` on every boot; unmodified first-run copies in `/config` are removed. The WM adds "Relaunch" and a switch to a full desktop session |
| App restart | `RESTART_APP=true`: `svc-watchdog` polls `pgrep` every second and reruns the autostart | `RESTART_APP=true` sets `SELKIES_APP_RESTART`, and the WM restarts the app at once. New `EXIT_ON_APP_CLOSE=true` stops the container when the app exits, and wins over `RESTART_APP` (baseimage-selkies #198) |
| `vainfo` | Not shipped | Shipped, so `init-video`'s i965 probe runs ([gpu.md](gpu.md)) |
| App output | Never reaches `docker logs` (labwc's output goes to `/dev/null`) | `SELKIES_APP_LOGS=false` is baked in; `true` should send it to `docker logs` [I] |
| Docker-in-Docker | Docker CE installed | Not installed; `svc-docker` downloads static binaries on the first privileged start |

- **Unchanged:** ports 3000/3001, `PASSWORD`, `SUBFOLDER`, the cert in `/config/ssl`, the file API (`/api/upload`, `/api/files/`, `/api/file-manager/browse`), `FILE_MANAGER_PATH`, `SELKIES_FILE_TRANSFERS`, `SELKIES_AUDIO_ENABLED`, the presence hooks (`sh -c`, 300 s limit), `PIXELFLUX_WAYLAND` (now an alias), `TITLE`, the icon path, `/run/s6/container_environment`, the `init-config` hook points, and `DISPLAY=:1` in the image environment [V].
- `HARDEN_OPENBOX` and `HARDEN_DESKTOP` also set `SELKIES_SESSION_SWITCH=false` on `dev` [V, source].
- `selkies session` sets up a targeted XDG quarantine. `~/.config/Creality` stays in `/config`, but the GTK theme may follow the browser's colour scheme [I].

## What the port needs

**Already on master,** because each pays off on today's base too [V, code]:

| Change | Where | Why |
|---|---|---|
| `apt-get purge -y vainfo`, and `check_no_vainfo` in the smoke test | `Dockerfile`, `tests/smoke.sh` | A no-op today. On `dev`, vainfo made `init-video` pick i965 on the UHD 630 and the stream was black; purged, iHD was used and the picture was fine [V] |
| `IDLE_QUIT` stays off, with a log line, when `EXIT_ON_APP_CLOSE`, `SELKIES_APP_RESTART` or `RESTART_APP` is true | `init-crealityprint-idle` | On Rust the WM would restart the app after every idle close, or stop the container. Today `RESTART_APP` (which `HARDEN_OPENBOX=true` also turns on) makes `svc-watchdog` relaunch the app after every idle close ([idle-quit.md](idle-quit.md)) |
| The base image gets its own Renovate group (label `base-image-update`) | `renovate.json` | A base bump that fails the build on purpose, at the patch step or at this switch, no longer holds up the weekly tooling PR |

**Kept for the move.** These only matter on Rust, and 2, 3 and 6 would be wrong on today's base:

1. **Pin the Rust base** by digest in `BASE_IMAGE`.
2. **Delete `root/etc/s6-overlay/s6-rc.d/svc-dbus/run`.** With no base `svc-dbus` to supply a `type` file, the lone `run` is a broken service definition, and boot hangs at `s6-rc-compile: fatal: unable to read …/svc-dbus/type` [V]. The session runs its own system bus. Today, deleting it would bring the system bus back.
3. **Rename `dependencies.d/svc-de` to `svc-selkies`** in `svc-crealityprint-idle` and `svc-crealityprint-upload-watcher`: `svc-de` is gone, and `svc-selkies` runs the session. Today this would start both before the desktop.
4. **A session-environment helper**, `root/usr/local/lib/crealityprint/session-env.sh`, sourced by `crealityprint` and `crealityprint-open`. Unless `SELKIES_SESSION_ID` is set (already inside the session), it exports every entry of `$XDG_RUNTIME_DIR/selkies-session-env.json` except `PWD`, `SHLVL`, `HOME`, `OLDPWD` and `_`, using `jq`. Without it, an app started by the idle daemon, the upload watcher or `docker exec` X11-autolaunches a second bus, and `crealityprint-open` never reaches it [V]. A no-op today (no such file).
5. **Re-own `/config/.XDG` and `/config/ssl`** in `init-crealityprint-config`'s ownership repair. The Rust server runs as `abc`, empties its runtime dir at start and reads the HTTPS key (mode 0600). After a `PUID` change it loops on "cannot make a runtime directory" and never serves [V]. Today nginx reads the key as root.
6. **Drop the Selkies patch layer** (the `Dockerfile` step, `build/patch-selkies.sh`, `build/patches/`). The base has `python3` but no Python `selkies` package, so the step fails the build by design [V]. Today it is the key-loop fix.
7. **Tests:** the readiness probe in `tests/e2e/lib/app.js` tries `http://127.0.0.1:3000/api/health` first and falls back to 8082; `input.spec.js` measures `pgrep -n -x selkies`, because the oldest `selkies` process is now the session supervisor. No DOM selector changed [V].

## Results of the port

On the same host and day, from the same commit, with changes 1–7 [V]:

- **e2e: 15 of 16 on Rust, 16 of 16 on Python.** gpu, clipboard, idle, seed ×3, transfer ×3, watcher ×2, persistence ×2 (the `PUID` case needs change 5) and scale ×2 pass. `input` fails its idle limit (at most 25 Selkies wakeups/s; see below); its stuck-key half passes and logs the same `Auto-releasing key 65505 (heartbeat lost).` The smoke test passes.
- **GPU:** Mesa iris renders on the UHD 630, and Selkies logs `Encoder: VAAPI H264`.
- **Existing volumes:** a `/config` created by today's image starts unchanged; the autostart is kept and the old `rc.xml` honoured.
- **File API:** `SELKIES_FILE_TRANSFERS=none` still answers 403. `HARDEN_DESKTOP=true` still leaves the API open, as today ([files.md](files.md)).
- **The distro is not a blocker.** The AppImage bundles pango 1.52.2 and puts its own `usr/lib` ahead of the system's, so Ubuntu 26.04's pango 1.57.0 is never loaded: Preferences opens, a cube slices and Preview renders. GTK 3 and WebKitGTK still come from the distro, so that check stays on every base change ([app.md](app.md)).
- **HiDPI behaves the same on both bases.** pixelflux pins Xwayland clients to scale 1 and applies the DPI as the output scale, as labwc does. A fresh DPR-2 browser defaults to UI Scaling 200 % on both, and `SELKIES_SCALING_DPI=96` gives a sharp full-resolution desktop on both. The image's `CP_UI_SCALE` DPI pin ([hidpi.md](hidpi.md)) came after the port and hasn't been run on Rust.

## Idle regression

Context switches per second with no browser connected, sampled from the host [V]:

| | Rust | Python, patched (today) |
|---|---|---|
| Selkies server | ~100 (98.6–102.6) | 7.5 |
| `selkies session` supervisor | 2 | — |
| Whole container, app running | 144 | 49 |
| Whole container, app closed (`IDLE_QUIT`) | 105 | 8 |

- **Why** [V, `crates/selkies/src/input/handler.rs` at `e1099614`]: the input handler starts two `tokio::time::interval` loops with the server, not with a client: a 100 ms key sweep and a 20 ms key-repeat tick, the same design the image patches out of Python ([base-image.md](base-image.md)). A gamepad heartbeat sweeper adds 100 ms, and the compositor's idle frame 250 ms. With `MissedTickBehavior::Delay` every tick wakes a tokio worker even with nothing to do; the workers account for 89 of the server's ~100 wakeups/s.
- **Against stock Python 2.2.1** (container with the app closed: 70.9/s, 0.48 %), Rust uses the same CPU with about 1.5× the wakeups. It is a regression against this image, not against an unpatched base.
- Upstream has no issue or PR about idle wakeups [V].
- **Options:** an upstream fix (a `tokio::sync::Notify` set after each key or gamepad message, with the loops parked while nothing is held; the Python patch is the design and `input.spec` the test); building our own patched bundle (rejected: the manylinux toolchain, the web client build, and matching the exact commit `dev` bundles); or accepting the cost.
- **Chosen:** we don't file or contribute the fix ourselves. We watch for one, and accept the cost if there is none when we move.

## Benchmarks: Python 2.2.1 (patched) vs Rust

**Conditions** [V]: both images built from the same commit, Python with the key-loop patch. i9-9900K host (16 threads, 31 GiB), UHD 630, the host's usual containers running alongside, a fresh `/config` per start. Two snapshots per window, read on the host so nothing is exec'd into the container: CPU from the cgroup's `cpu.stat` over 60 s, wakeups as voluntary plus nonvoluntary context switches of every thread over about 75 s, memory from the cgroup. Idle windows start 3 minutes after the main window; "app closed" is SIGTERM plus a 30 s pause. Load: a 639,200-triangle sphere orbited with a **right-drag** (a ±250 px sine sweep, moves at about 60 Hz). Client: headless Chromium from Playwright on the same host, decoding in software [V]; the notes say H.264, but [gpu.md](gpu.md) found Playwright's bundled Chromium has no H.264 decoder, so the codec is unconfirmed [I]. At least two runs each; load runs one container at a time (Python, Rust, Python, Rust), idle runs side by side (a solo check showed no skew).

| | Python (patched) | Rust | Difference |
|---|---|---|---|
| Idle, app running: container CPU / wakeups/s | 1.53 % (1.47–1.62) / 49 | 2.07 % (1.90–2.31) / 144 | Rust +0.5 points, ×3 wakeups |
| Idle, app closed: container CPU / wakeups/s | **0.09 % / 8** | **0.48 % / 105** | Rust ×5 CPU, ×13 wakeups |
| Idle, app closed: anonymous memory | 165 MiB | 64 MiB | Rust −100 MiB |
| Selkies server idle: wakeups/s, CPU, RSS | 7.5, 0.09 %, 178 MiB | 99–103, 0.44 %, 118 MiB | |
| Connected, static screen, GPU: container CPU | 4.4 % | 5.0 % | ≈ (small but repeatable) |
| Orbit, GPU, 1600×900: container CPU | 55.5 % | 49.2 % | **Rust −6 points** (repeats ±1) |
| Orbit, GPU, DPR 2 (3200×1800 stream, app at 1600×900 stretched): container CPU | 41.2 % | 37.6 % | Rust −4 points |
| Orbit, GPU: decoded frames/s, bitrate | 34–35, 10.6 Mbit/s | 34–37, 10.6 Mbit/s | = (the app's renderer is the cap) |
| Orbit, no GPU, 1600×900: container CPU, frames/s | 311 %, 11.6 | 310 %, 12.8 | = |
| Orbit, no GPU, DPR 2 (stretched) | 333 %, 7.7 | 382 %, 10.9 | Rust +0.5 core, +3 frames/s (Selkies' x264: 85 % vs 22 %) |
| Input latency, mouse to decoded frame (median, 2 runs) | 41 / 44 ms | 39 / 33 ms | Equal or slightly faster; the spreads overlap |
| 15 min connected: memory | Flat after one-off steps | Flat after one-off steps, ~90 MiB lower | = |
| Cold start: `/api/health` / first frame / main window | 2.3 / 3.1 / 4.9 s | 1.9 / 2.7 / 4.2 s | Rust 0.4–0.7 s faster |
| Image size, uncompressed / compressed | 4.78 / 1.23 GB | 2.97 / 0.77 GB | Rust −38 % |

- **Under load, the gain is not Rust code.** Rust's 6 points are almost exactly Python's labwc (3.6 %) plus nginx (1.5 %); the Selkies processes cost 9–10 % on both. Python's 0.56 cores are in the range of [gpu.md](gpu.md)'s right-drag figures for today's base (0.62–0.72 cores at 1600×900).
- **Idle is the case that matters** for a server that sits idle most of the day, and there Rust is worse. The app costs the same on both bases (about 27 wakeups/s and 1.3 % of a core); the whole difference is Selkies.
- **No GPU on Rust:** in 3 of 4 windows the stream carried 3.5–7× what the client decoded (e.g. 41.7 vs 5.9 Mbit/s); the client's socket worker dropped the rest before decoding. Never seen on Python or with a GPU, and probably the headless software-decoding client falling behind [I]. Re-check with a real browser before relying on Rust without a GPU.
- **Not measured:** an app rendering at full 3200×1800 (with `CP_UI_SCALE`'s DPI pin; the DPR-2 rows are a stretched 1600×900 app on both bases), memory beyond 15 minutes, and NVIDIA or AMD. The bases also differ in more than Selkies (distro, Mesa, no labwc or nginx), and Rust was a moving `0.0.0.dev0` build.

## Decision: prepare, but don't move yet

| Input | Points to |
|---|---|
| Motivation | Packaging and maintainability; nothing targets this image's use, and performance was explicitly not the goal |
| Stability | Pre-release: no version, a floating `dev`, a recent contract break, no production adopters. Moving now means re-validating on every `dev` bump |
| Port effort | Small, and it doesn't get cheaper by doing it early while `dev` still changes what it depends on |
| Measured gains | A few points under GPU load, memory, image size and start time; a regression at idle, this server's normal state, which undoes the key-loop patch |

- **The forced moment is well defined.** When `debiantrixie` switches, the Renovate base-image PR fails CI at the patch step and nothing is published; master keeps building on the old digest, so nothing breaks for users [V].
- **Waiting has a cost after that:** the old digest gets no more base security rebuilds, and the weekly uncached rebuild only refreshes the packages this image installs [I]. So don't move before the switch, but port within a few weeks of it.
- **No CI job on `dev`.** It rebuilds about 3.4 times a week against whatever Selkies commit is newest, so a job would mostly report upstream churn, and the port can't share one `Dockerfile` and overlay with the Python build without a second variant to maintain.
- **Revisit when** Selkies 2.3.0 is released; `debiantrixie` (or a new Rust trixie tag) switches, which shows as a failing base-image PR; upstream parks the idle timers; `dev` goes about two weeks without a contract change; or a mainstream linuxserver app image (orcaslicer, chromium, the webtop default) moves to it.

## Migration checklist

- [ ] Pin the Rust base by digest; prefer a trixie Rust tag, so the distro stays the same. If the tag name changes, check that Renovate's base-image rule still matches.
- [ ] Apply changes 1–7 from "What the port needs".
- [ ] `input.spec`'s idle limit: keep 25/s if upstream parked the timers; otherwise re-baseline it and update the idle numbers in the README, [base-image.md](base-image.md) and [idle-quit.md](idle-quit.md).
- [ ] Re-run `scale.spec`: with `CP_UI_SCALE=2` and a fresh DPR-2 client, Xwayland should be 3200×1800 ([hidpi.md](hidpi.md)).
- [ ] Full e2e and smoke; by hand, Preferences, a slice and Preview (GTK and WebKit drift); with a GPU, a stream that isn't black.
- [ ] Mesa 26: slice with the GPU on Intel and watch for the GPU hang of Creality Print #604; `INTEL_DEBUG=noccs` is the known fix ([gpu.md](gpu.md)) [I: not tested in the port].
- [ ] After an idle close and reconnect, use the menu's "Relaunch" and confirm only one app runs. The idle daemon starts the app with `setsid`, outside the WM's `selkies-autostart.lock`, so the WM may think the app has ended [I].
- [ ] On a host whose GPU is present but unusable, `selkies session` falls back to X11 (`SELKIES_WAYLAND_X11_FALLBACK`, `DISPLAY=:1`); check that the helpers, which assume `:0`, still reach the app [I].
- [ ] Without a GPU, check the stream with a real browser (see the overshoot above).
- [ ] README: the Selkies idle cost, the menu's "Relaunch", whether to set `SELKIES_SESSION_SWITCH=false`, and whether `SELKIES_APP_LOGS=true` is worth setting. Update this doc, [base-image.md](base-image.md) and [decisions.md](decisions.md).
