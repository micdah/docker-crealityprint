# 16 — Rust Selkies: what a port takes, why upstream rewrote it, and whether to move now

Date: 2026-11-22 · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, Intel UHD 630 · Our repo: master `2ef7ef4`

Selkies' `main` branch was rewritten in Rust, and linuxserver's base image `dev` tag already ships it. This doc answers four questions:
- What does it take to port this image to that base?
- Why did upstream rewrite Selkies?
- How stable is the rewrite today?
- Is it worth moving before the rewrite reaches the `debiantrixie` tag we build on?

It combines desk research (upstream code, issues, PRs, releases) with a hands-on port on the local Docker host, the full e2e suite on both bases, and benchmarks.

Legend: **[V]** = verified by running it or reading the source at the cited commit, **[I]** = inferred.

## Summary

- **The rewrite is not about performance.** The Selkies lead's stated reasons (selkies#422):
  - no Python interpreter;
  - one package for every Python version;
  - pixelflux and pcmflux linked directly in Rust;
  - a monorepo with one shared version;
  - a Rust ecosystem that is now mature enough.

  He wrote "I don't see a lot of performance issues with the Python components". His own measurements show a real gain only for WebRTC at high bitrates; for WebSockets, which is what we use, he says the gain is "close to nothing" [V, §2].
- **It is pre-release.** Rust has been on `main` for 14 days (PR #517, merged 2026-11-08).
  - Every build is a per-commit prerelease versioned `0.0.0.dev0`. Release notes for 2.3.0 are drafted, with no date.
  - The base's `dev` tag picks up the newest Selkies commit on every rebuild, about 3.4 times a week.
  - `dev` had one large contract break a week ago (`c4dede0`), followed by four repair commits.
  - None of linuxserver's 88 downstream images uses it on a default branch; only a stale `webtop@dev` branch does [V, §3–4].
- **The port is small, and it works.** Six changes to the image, all small (§6):
  1. drop our `svc-dbus` override;
  2. point two dependencies from `svc-de` to `svc-selkies`;
  3. purge `vainfo`;
  4. add a session-environment helper;
  5. fix ownership of `/config/.XDG` and `/config/ssl`;
  6. drop the Python patch layer.

  With these, 15 of 16 e2e tests pass. The smoke test and GPU rendering pass, and VA-API H.264 encoding is used. A `/config` from the Python image starts unchanged [V].
- **The pango risk did not happen.** The base moves from Debian trixie to Ubuntu 26.04 with pango 1.57, the version that crashed OrcaSlicer's AppImage. Creality Print's AppImage bundles its own pango 1.52.2 and puts it first on its library path, so Preferences, slicing and Preview all work. This corrects R7 in doc 09 for pango; GTK and WebKit still come from the distro [V, §6.4].
- **One real regression: idle wakeups come back, and more of them.** With nobody connected, the Rust server wakes about **100 times a second**; our patched Python server wakes 8 times. The whole container goes from about 49 to about 144 wakeups/s with the app running. The Rust input handler keeps the same always-on 100 ms and 20 ms timers that doc 14 parked, and a prebuilt Rust binary can't be patched the way we patch the Python package [V, §6.5, §7].
- **HiDPI is not a regression, but the shipped `CP_UI_SCALE` has a gap on both bases.** A fresh browser at devicePixelRatio 2 defaults to Selkies UI Scaling 200 %, so `CP_UI_SCALE=2` alone gives a 4x blurry app. It is sharp only after the user picks 100 % in the sidebar (stored per browser) or with `SELKIES_SCALING_DPI=96`. Both work the same on Python and Rust [V, §6.6]. Fixed independently of the port: the image now sets `SELKIES_SCALING_DPI=96` itself while `CP_UI_SCALE` is 2–4 ([15 §4](15-hidpi-scaling.md)).
- **Performance (§7): about even under load, clearly worse at idle.**
  - Orbiting the 3D view with the GPU, the Rust container uses about 6 points less CPU (49 % vs 55 % of a core). That comes from the processes Rust no longer runs (labwc and nginx); Selkies itself costs the same 9–10 %.
  - Frame rate and bitrate are identical: the app's renderer is the cap.
  - Input latency is equal or a few ms better.
  - At idle, the case this always-on server spends most of its time in, Rust is worse. With the app closed (`IDLE_QUIT`) it uses **0.48 % of a core against 0.09 %**, and 105 wakeups/s against 8.
  - Smaller wins: about 100 MiB less memory, an image 1.8 GB smaller, and a start about 0.5 s faster.
- **Recommendation: prepare, but don't move yet** (§8). Moving early buys small wins under load at the price of the idle regression and a moving pre-release base. The port is small and doesn't get harder by waiting.
  - Land now the three changes that already pay off on the Python base: an `IDLE_QUIT` guard, a separate Renovate group for the base image, and a `vainfo` purge. Keep the rest of the port for the move.
  - We don't file the idle-timer regression upstream; we watch for an upstream fix and accept the cost if there is none by the time we move.
  - Revisit when Selkies 2.3.0 is released, or when `debiantrixie` switches to Rust, whichever comes first. linuxserver has switched `master` within a day of each Selkies release so far, so the second will probably follow the first closely [I]. When `debiantrixie` switches, the Renovate base bump fails at our patch step, so the migration can't happen by accident.

---

## 1. Sources and pinned versions

| Key | What | Ref |
|---|---|---|
| Ours | this repo | master `2ef7ef4` (with #15 key-loop patch, #16 `CP_UI_SCALE`) |
| Base now | `linuxserver/docker-baseimage-selkies` `master` → tag `debiantrixie` | `a7d1dfd`, image `sha256:793fc362…` (Selkies 2.2.1, Python) |
| Base dev | same repo, `dev` → tag `dev` | `cc84899`; image `sha256:374f927a80586a02ec1e4290868780182d20189584148d73807fda87a11eb835`, `4d7ee28c-ls23`, built 2026-11-22 |
| Selkies Rust | `selkies-project/selkies` `main` | `e1099614` = prerelease `e109961`, the bundle inside the dev image (sha256 of `/opt/selkies/bin/selkies` matched to the release tarball) [V] |
| Selkies Python | same repo, `legacy` = tag `2.2.1` | `d6b9351` |
| Key upstream threads | [#422](https://github.com/selkies-project/selkies/issues/422) (Rust migration epic), [#517](https://github.com/selkies-project/selkies/pull/517) (Monorepo and Rust), [#545](https://github.com/selkies-project/selkies/issues/545) (parity vs 2.2.1), [#544](https://github.com/selkies-project/selkies/issues/544), [#560](https://github.com/selkies-project/selkies/issues/560), [#609](https://github.com/selkies-project/selkies/issues/609), [webtop#450](https://github.com/linuxserver/docker-webtop/issues/450) | |
| Commits | [base `a7d1dfd`](https://github.com/linuxserver/docker-baseimage-selkies/commit/a7d1dfd0cd98b6992786a4883382f1094d075534), [base `cc84899`](https://github.com/linuxserver/docker-baseimage-selkies/commit/cc8489995e2b15626faf641751248d4ca8881e59), [base `c4dede0`](https://github.com/linuxserver/docker-baseimage-selkies/commit/c4dede03ccd7213cdc8655c6842ad4a9ac591a6e), [Selkies `e1099614`](https://github.com/selkies-project/selkies/commit/e1099614ba503647a902cbe5a7520e052a0eeb5d), [Selkies `d6b9351`](https://github.com/selkies-project/selkies/commit/d6b9351421bd503ffa89bdee78e2bce758b1ffe5) | |

The research ran as separate tracks: motivation and roadmap, stability, base contract diff, coupling inventory, hands-on port, benchmarks, and a HiDPI follow-up. Their working notes, logs, screenshots and scripts lived in a temporary session folder and were **not kept**. File names such as `t5/shots/…` or `hidpi/report.md` below identify that evidence, but the files no longer exist. To reproduce:
- **the port:** the diff is in Appendix A;
- **the benchmarks:** the sampling method is in Appendix B;
- **the e2e runs:** the repo's own `tests/run-e2e.sh` and `tests/smoke.sh`.

## 2. Why Rust (motivation)

From the migration epic selkies#422, opened by the Selkies lead (`ehfd`) on 2026-09-28 and closed "migration is done" on 2026-11-11 [V]:

1. **No Python interpreter.** The goal is "a Rust-only executable with no Python interpreter dependency", with Python only as an optional wheel wrapper, the way ruff does it.
2. **Packaging.** The zero-copy ABI between pixelflux/pcmflux and Selkies blocked abi3 wheels, so every Python version needed its own wheel. Linking them in Rust removes that.
3. **The Rust ecosystem matured:** Axum/Tower, tokio and webrtc-rs. "The stability of dependencies in Rust was not the case even a few months ago."
4. **Performance is secondary,** and the epic says so plainly: "I don't see a lot of performance issues with the Python components because most load-bearing components live in pixelflux and pcmflux." His measurements (comment of 2026-11-01):
   - WebRTC send: about 75 µs of interpreter time per datagram, which matters at high bitrates.
   - WebSockets: "close to nothing", because it was already zero-copy.
   - GIL tail latency: suspected, not measured.
5. **Monorepo and one version:** pixelflux and pcmflux move in, and the separate tools become `selkies session`, `selkies resize` and `selkies gpu-probe`.
6. **The port was planned as AI-driven work.** That answered the "Rust is a contribution barrier" objection.

The linuxserver lead (`thelamer`) first argued against it: Python is readable, and he wanted "a massive performance reason". He then wrote the first Rust commits himself (`1bc196f`, `5f84cff`, 2026-11-01) [V].

**What it looks like now** [V, release-notes/2.3.0.md and the crates at `e1099614`]:
- One `selkies` binary on Axum, Tower and tokio, with its own WebRTC stack (`selkies-rtc`).
- pixelflux and pcmflux merged in as crates, and the web client compiled into the binary.
- The headless Wayland compositor lives in pixelflux. A new window manager, `selkies-wm`, places the windows and runs Xwayland, so no labwc or openbox runs.
- Everything ships as one glibc 2.17 bundle (patched Xvfb, Xwayland, PulseAudio, dbus and the interposers) that the wheel, distro packages, AppImage and images all repackage.

**Upstream's own performance claims** (#517 on an NVIDIA L4; #545 adds NVENC, x264 and VA-API on Intel and AMD; all Chrome or Firefox on X11):
- Rust is mostly ahead: lower CPU per frame (the track notes read #545 as 8–52 % and 18–52 %, so treat the lower bound as uncertain) and 26–38 % less RSS.
- WebRTC p90 latency is much tighter.
- Software x264 is worse: 35.6 % vs 22.8 % CPU, a deliberate quality setting. VP9 and AV1 over WebRTC lag behind.
- **Not yet validated upstream:** Wayland capture, DRI3 on non-NVIDIA GPUs, audio, input latency, and memory over a long session. VA-API on Intel was measured, but only on X11; our setup is Wayland capture, which upstream hasn't measured.

So the expectation that "Rust performs better" is plausible for the stream path, not established for our setup, and explicitly not the reason for the rewrite. §7 measures it.

## 3. Roadmap

- **The next release is 2.3.0, not 3.0.** `release-notes/2.3.0.md` exists on `main`; no date or milestone is announced anywhere [V].
- **The Python line is frozen.** `legacy` was recreated at 2.2.1 (`d6b9351`) on 2026-11-04 and has had no commits since. A 2.2 regression (iOS keyboard, #609) was fixed only on `main`, and linuxserver patched its Python `master` itself (`cc29015`). No deprecation or end-of-life policy is published [V]. Our own key-loop patch (doc 14) is in the same position: nobody will fix 2.2.1 for us.
- **When `debiantrixie` moves to Rust.** No date is announced [V]. linuxserver moved `master` to each Selkies stable release within about a day: 2.0.0, 2.1.0, 2.2.1 [V]. So expect `debiantrixie` to switch, with the whole `c4dede0` redesign, right after 2.3.0 ships [I]. Renovate would then offer it as a normal base-digest bump, and the build would fail at our patch step (doc 14 §4).
- **A trixie flavour is likely.** Upstream Selkies already publishes `ghcr.io/selkies-project/selkies/base:main-debiantrixie` (Rust) [V]. `debiantrixie` is linuxserver's default base tag, and the Rust bundle doesn't depend on the distro [I]. For us the distro matters less than expected (§6.4).
- **Direction for app images:** "webtop `latest` will be replaced with an Ubuntu based image running a Selkies desktop … with Selkies 2.3.0 we are releasing an in house window manager" (webtop#450) [V].

## 4. Stability today

| Area | Maturity | Evidence [V unless marked] |
|---|---|---|
| Release discipline | Low (pre-release) | 14 days on `main`; about 88 prereleases since 2026-11-08, all `0.0.0.dev0`; about 270 commits a week (peak 548), 91 % from two people. `:dev` floats to the newest Selkies commit on every rebuild and can't report which one. |
| Open bugs | Medium | 18 open, no crash or startup bugs, 9 performance or congestion issues. 41 closed in 18 days, mostly within 0–3 days; a file-descriptor leak on reconnect (#588) was fixed the same day. About 70 % of the reports come from the maintainers, so few users run it [I on exposure]. |
| Parity with 2.2.x | Medium | Ahead where measured. Gaps: #544 (frame-rate ceiling), #560 (VP9 latency), AV1 over WebRTC. Removed on purpose: striped H.264. Turbo is now off by default. Not measured: Wayland, long sessions, input latency. |
| Adopters | Low | 0 of 88 linuxserver images use it on a default branch; one stale branch, `webtop@dev`, does. No outside adopters found. |
| CI | High breadth, medium reliability | 19 workflows: unit, e2e, fuzz, CodeQL, BrowserStack. Push CI mostly green. Nightly e2e failed 18 of 20 nights, though the latest passed 320 of 324 cases. |
| Contract churn (base `dev`) | Low stability | `c4dede0` (11-14) removed nginx, `svc-de`, `svc-xorg`, `svc-dbus`, `svc-pulseaudio`, the menus and Docker. At least 4 repair commits followed, e.g. `efbe70f` re-adding 17+ libraries downstream apps need. Env-var shims are added; removed s6 services get none. |

Verdict: well engineered, but immature. The code quality and CI are good; release discipline and contract stability are not there yet [I].

## 5. What changed in the base (`master@a7d1dfd` → `dev@cc84899`)

Only what a downstream image like ours notices [V unless marked]:

| Area | `debiantrixie` (Python) | `dev` (Rust) |
|---|---|---|
| Distro | Debian 13 trixie | Ubuntu 26.04 resolute (pango 1.57.0, gtk 3.24.52, mesa 26.0.8, webkit2gtk-4.1 2.52.6) |
| Selkies | `/lsiopy` venv, pinned 2.2.1 wheels | `/opt/selkies` bundle, **not pinned**: newest `main` commit with a bundle at build time |
| HTTP(S) | nginx on 3000/3001 → Selkies on 127.0.0.1:8082 | Selkies serves 3000/3001 itself, no 8082; `/api/health` answers without auth |
| s6 longruns | nginx, pulseaudio, xorg, dbus, selkies, de, xsettingsd, watchdog, docker | `svc-selkies`, `svc-app-exit`, `svc-docker` |
| Session | labwc nested in pixelflux; labwc runs autostart and Xwayland `:0` | `selkies session`: its own session bus (`/config/.XDG/bus`) and system bus, pulse, `selkies-wm`, Xwayland `:0`, autostart |
| Autostart | `/defaults/autostart_wayland`, copied to `/config` if missing | same contract |
| Menu | copied to `/config` if missing | `/defaults/menu_wayland.xml` copied to `/etc/xdg/labwc/menu.xml` on every boot, plus a built-in "Relaunch" and a desktop-session switch |
| App restart / exit | `RESTART_APP` watchdog (polls) | `RESTART_APP` → `SELKIES_APP_RESTART` (the WM restarts the app at once); new `EXIT_ON_APP_CLOSE` stops the container |
| GPU | `init-video`; we never install `vainfo` (i965 → black stream, doc 04) | the base ships `vainfo` again, so the i965 probe runs |
| App stderr | in `docker logs` | `SELKIES_APP_LOGS=false` baked in |
| Unchanged | ports 3000/3001, `PASSWORD`, `SUBFOLDER`, cert path `/config/ssl`, `/api/upload`, `/api/files/`, `/api/file-manager/browse`, `FILE_MANAGER_PATH`, `SELKIES_FILE_TRANSFERS`, `SELKIES_AUDIO_ENABLED`, `SELKIES_RUN_AFTER_CONNECT`/`_DISCONNECT` (`sh -c`, 300 s), `PIXELFLUX_WAYLAND` (as an alias), `TITLE`, icon path, `/run/s6/container_environment`, `init-config` hook points |

## 6. The port, hands-on

### 6.1 Coupling inventory

Every place where this image touches Selkies or the base (Dockerfile, s6 units, scripts, tests, CI, README claims) was checked against Rust `main` and base `dev`. That is 68 rows: **36 same, 1 renamed, 24 changed, 5 missing, 2 unknown**. Most "changed" rows are test or doc wording. The ones that matter are below.

### 6.2 Required changes

Built from master `2ef7ef4` with `BASE_IMAGE=…:dev@sha256:374f927a…`. The unmodified image builds, but boot hangs at `s6-rc-compile: fatal: unable to read …/svc-dbus/type` [V].

| # | Change | Why | Effect on the Python base [I, not run there] |
|---|---|---|---|
| 1 | Delete `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` | the base no longer has `svc-dbus`, so our lone `run` file is a broken service definition. The session's own system bus replaces it | no: on Python it would bring back the system bus orcaslicer disables |
| 2 | `svc-crealityprint-{idle,upload-watcher}/dependencies.d/svc-de` → `svc-selkies` | `svc-de` is gone; `svc-selkies` now runs the session | changes start order: on Python `svc-de` (labwc + the app) comes *after* `svc-selkies`, so the watcher and idle daemon would start before the desktop. Kept for the switch |
| 3 | `apt-get purge vainfo` | the base ships it again, so `init-video` picks i965 on the UHD 630 and the stream is **black** (screenshot `t5/shots/run1-first.png`); purged, iHD is used and the picture is fine | no-op today (we never install `vainfo`), and a guard if the base ever adds it |
| 4 | New `root/usr/local/lib/crealityprint/session-env.sh`, sourced by `crealityprint` and `crealityprint-open` | only programs the WM starts inherit the session's bus address. The idle daemon, the upload watcher and `docker exec` would otherwise X11-autolaunch a second bus, so `crealityprint-open` never reaches the app. The helper imports `$XDG_RUNTIME_DIR/selkies-session-env.json` | no-op (the file doesn't exist there) |
| 5 | `init-crealityprint-config` re-owns `/config/.XDG` and `/config/ssl` | after a PUID change the Rust server, running as `abc`, loops on "cannot make a runtime directory" and never serves (on Python, nginx read the key as root) | harmless (a no-op unless PUID changed) |
| 6 | Drop the `patch-selkies.sh` layer | there is no Python selkies to patch; the step fails the build by design (doc 14 §4) | no: it's the Python base's fix |
| 7 | *Safety:* `IDLE_QUIT` refuses to start when `EXIT_ON_APP_CLOSE`, `SELKIES_APP_RESTART` or `RESTART_APP` is set | on Rust the WM would restart the app after every idle close, or stop the container | **a behaviour change, and a fix**: on Python, `RESTART_APP=true` runs the base's `svc-watchdog`, which relaunches the autostart within about 2 s of the idle daemon closing the app. That gives a close/relaunch cycle [V: `svc-watchdog/run` at `a7d1dfd`; the cycle itself I, untested]. `HARDEN_OPENBOX=true` also sets `RESTART_APP=true` unless the user set it (`init-selkies-config` L90–96, both bases) [V]. So the guard turns `IDLE_QUIT` off, with a log line, for those users on Python too |

Test harness only:
- the readiness probe tries `127.0.0.1:3000/api/health` first and falls back to 8082;
- `input.spec` measures `pgrep -n -x selkies`, because the oldest `selkies` process is now the `selkies session` supervisor and the server is its child.

No DOM selector changed [V].

### 6.3 Test results

| Test | Rust | Python (same day, same master) |
|---|---|---|
| gpu, clipboard, idle, seed ×3, transfer ×3, watcher ×2, persistence (rm/re-create) | pass | pass |
| persistence (PUID change) | pass, after change 5 | pass |
| scale ×2 | pass (it checks the env only; the picture depends on the UI Scaling choice, on both bases, §6.6) | pass (same caveat) |
| input (idle ≤ 25 wakeups/s + stuck key) | **fail** on the idle limit (§6.5); the stuck-key half passes alone and logs the same `Auto-releasing key 65505 (heartbeat lost).` | pass |
| smoke | pass | not re-run here (passes in CI on master) |
| **Total e2e** | **15/16** | **16/16** |

Also verified on Rust [V]:
- the GPU renderer is Mesa iris on the UHD 630, and Selkies logs `Encoder: VAAPI H264`;
- a `/config` created by the Python image starts fine: the autostart is kept and the old `rc.xml` is honoured;
- `SELKIES_FILE_TRANSFERS=none` still answers 403.

`HARDEN_DESKTOP=true` still leaves the file API open. That is the same behaviour as on Python ([06](06-file-transfer.md), "Bug found: `HARDEN_DESKTOP=true` does not turn file transfer off"), not a regression.

### 6.4 The distro (pango) risk

This is risk R7 in [09](09-roadblocks-and-risks.md), from orcaslicer#36. Ubuntu 26.04 has pango 1.57.0, which segfaulted OrcaSlicer's AppImage in `libpangoft2`.

The Creality Print 7.3.2 AppImage **bundles pango 1.52.2**: `usr/lib/libpango-1.0.so.0.5200.2`, `libpangoft2`, `libpangoxft`. Its `AppRun` puts `$DIR/usr/lib` first on `LD_LIBRARY_PATH`, so the system pango is never loaded [V]. GTK 3 and WebKitGTK are *not* bundled; they still come from the distro. R7 in doc 09 says the AppImage takes pango from the host, which is wrong for pango; for GTK and WebKit it holds.

On Rust's Ubuntu base, Preferences opens, a cube slices and Preview renders (`t5/shots/pango-*.png`) [V]. The move to Ubuntu is not a blocker for this app today. R7's mitigation still applies to GTK and WebKit drift: smoke-test Preferences, slice and Preview on every base bump. A trixie flavour would keep the distro the same as today.

### 6.5 Regression: idle wakeups

Context switches per second with **no browser connected** (method of doc 14 §5; sampled from the host, §7.1) [V]:

| | Rust | Python, patched |
|---|---|---|
| Selkies server | **~100/s** (98.6–102.6) | 7.5/s |
| `selkies session` supervisor | 2/s | — |
| Whole container, app running | 144/s | 49/s |
| Whole container, app closed (`IDLE_QUIT`) | 105/s | 8/s |

The first port run, which sampled by exec'ing into the container, got the same server rate. Its container totals were 167 against 58/s with the app running, and 82/s with the app closed; the exec adds switches of its own, and it didn't sum every process. The table uses the host-side figures.

Why [V, `crates/selkies/src/input/handler.rs` at `e1099614`]:
- The input handler starts two `tokio::time::interval` loops with the server, not on connect: `KEY_SWEEP_INTERVAL` 100 ms and `KEY_REPEAT_TICK` 20 ms (L305–307, L446–479).
- A gamepad heartbeat sweeper adds 100 ms (`gamepad/mod.rs` L60), and the compositor's idle frame 250 ms (`pixelflux/src/lib.rs` L1464).
- `MissedTickBehavior::Delay` doesn't skip on-time ticks, so every tick wakes a tokio worker thread even with nothing to do.
- This is the same design doc 14 parked in Python. Upstream has no issue or PR about idle wakeups [V: `gh search`].

Options:
- **An upstream fix (S–M for whoever writes it).** Port doc 14's design: a `tokio::sync::Notify` set after each `kd`/`kh`/`js` message, with both key loops and the gamepad sweeper parking while nothing is held. Doc 14 §3 is the design note, and `input.spec` is the test. **Decision (2026-11-22): we don't file or contribute this upstream ourselves**; we watch for it.
- **Build our own patched bundle (L, ongoing).** This needs the manylinux toolchain, the web client build, and a match to the exact commit `dev` bundles. Rejected.
- **Accept the cost.** It is small in absolute terms (§7), but it undoes #15. This is the plan if upstream hasn't fixed it by the time we move.

### 6.6 HiDPI (`CP_UI_SCALE`): same on both bases, with a gap in the shipped feature

The first port test (T5) reported this as a Rust regression. A side-by-side check on both images showed otherwise. Method: Playwright at deviceScaleFactor 2 with a 1600×900 viewport, a fresh container and a fresh browser context each time. Measured with `xdpyinfo` on `:0`, `wlr-randr` on Python, the Selkies log on Rust, and screenshots with 1:1 crops [V, `hidpi/report.md`, not kept].

- **A fresh DPR-2 client defaults to UI Scaling 200 %, on both bases.**
  - The web client picks its default DPI from `devicePixelRatio`: DPR 2 gives 192. The rule is in `stream-density.ts` L73–76 on Rust, and the same code is in the minified 2.2.1 `selkies-core.js`.
  - The sidebar then shows UI Scaling **200 %** with "HiDPI (Pixel Perfect)" on.
  - The output is 3200×1800 at **scale 2**, and Xwayland stays at 1600×900, so the app is a 1x bitmap stretched 2x.
- **With `CP_UI_SCALE=2` at that default, the app is drawn 2x and then stretched 2x again** (about 4x and blurry; `t5/shots/dsf2-scalea.png`), on both bases.
- **Two ways to get doc 15's full-resolution scale-1 desktop, both of which work on both bases:**
  - **The user** sets Screen Settings → UI Scaling → 100 % in the sidebar. That gives 3200×1800 at scale 1, and `CP_UI_SCALE=2` is then sharp (edge measure of a 1:1 text crop: about 3850 upscaled, about 5860 sharp). The choice is stored in the browser's `localStorage` per site, so every new browser or device starts at 200 % again.
  - **The operator** sets `-e SELKIES_SCALING_DPI=96`. Every client then gets 3200×1800 at scale 1, the UI Scaling select is hidden, and `CP_UI_SCALE=2` is sharp without any user action.
  - T5's "96 is rejected as invalid" was a misreading: the log warning is about the client's 192 not being allowed, after which the server uses 96.
- Turning "HiDPI (Pixel Perfect)" off doesn't help: the desktop becomes 1600×900 and the browser stretches it.
- **What this means:**
  - Not a port issue. The Rust port keeps `CP_UI_SCALE` working exactly as on Python: the env reaches the app, and the same two routes to a sharp picture exist.
  - It does expose a gap in the shipped feature (#16). The README says to "leave Selkies' UI Scaling at 100 %", implying that 100 % is the default, but on a HiDPI browser the default is 200 %. A user who only sets `CP_UI_SCALE=2` gets the 4x blurry result until they change the sidebar, and again in every new browser.
  - **Follow-up (separate from this port, in progress):** when `CP_UI_SCALE` is 2 or more, have the init also set `SELKIES_SCALING_DPI=96`, unless the user set it. The README and doc 15 §3 would change to match, and `scale.spec` should check the Xwayland size (`xdpyinfo` on `:0`), not only the app's environment. This was not tested as an image change [I].
  - **Update (2026-11-22): done on the Python base.** `init-crealityprint-config` now does exactly this, and `scale.spec` checks Xwayland at 3200×1800 for a fresh DPR-2 client. Design, measurements (including the CPU cost of full-resolution rendering) and tests: [15 §4](15-hidpi-scaling.md). Not yet re-checked on the Rust base (§8.3 step 4).
- Background, from the Rust source: pixelflux pins Xwayland clients to scale 1.0 (`wayland/xwm.rs` L305) and applies DPI only as the output scale (`display/dpi.rs` L30–32). That is the same model as labwc on Python, which is why both bases behave the same.

### 6.7 Smaller differences

- `SELKIES_APP_LOGS=false`: the app's stderr no longer reaches `docker logs`.
- The root menu adds "Relaunch" and a switch to a full desktop session. Consider `SELKIES_SESSION_SWITCH=false`.
- The app runs with `LC_ALL=C` and Selkies' `LD_PRELOAD` interposers; no visible effect [V], not compared in depth.
- `selkies session` enables a targeted XDG quarantine. `~/.config/Creality` stays in `/config`, but the GTK theme may follow the browser's colour scheme [I].
- Image size: **2.97 GB** on Rust against 4.78 GB on Python [V]. The base dropped Docker, nginx and the separate X/Wayland layers.

## 7. Performance: Python 2.2.1 (patched) vs Rust

### 7.1 Method

- **Images,** both built from master `2ef7ef4`: **P** = `crealityprint:t5-python` (`sha256:fc6d0b8f…`, the shipped design, with the key-loop patch) and **R** = `crealityprint:t5-rust` (`sha256:63ff1b4e…`, the §6.2 port).
- **Host:** 16 threads, 31 GiB, UHD 630; the host's usual containers ran in the background. Each start used a fresh `/config`.
- **Host-side sampler:** two snapshots per window, read from the host, so nothing is exec'd into the container during a window.
  - container CPU from the cgroup's `cpu.stat` `usage_usec`;
  - wakeups = voluntary + nonvoluntary context switches per thread from `/proc` (doc 14 §5);
  - `memory.current`/`memory.stat`, VmRSS, `/dev/shm`, and eth0 bytes.
- **Client:** headless Chromium (Playwright 1.65.1) on the same host, decoding H.264 in software. A hook counts decoded frames, the bytes handed to `VideoDecoder`, and presented frames (`requestVideoFrameCallback`).
- **Load:** a 639,200-triangle bumpy sphere (a regeneration of doc 04's model), orbited with the right button in a ±250 px sine sweep at about 60 Hz moves.
- **Repeats:** ≥ 2 runs per configuration. Load runs used one container at a time in the order P, R, P, R. Idle runs went side by side, and a solo window with the partner `docker pause`d showed no skew.

### 7.2 Results

| | Python (patched) | Rust | Verdict |
|---|---|---|---|
| Idle, app running: container CPU | 1.53 % (1.47–1.62) | 2.07 % (1.90–2.31) | R +0.5 % of a core (just outside ±0.2 noise) |
| Idle, app running: container wakeups/s | 49 | 144 | R ×3 |
| Idle, **app closed** (the `IDLE_QUIT` state): container CPU | **0.09 %** | **0.48 %** | R ×5 |
| Idle, app closed: wakeups/s | 8 | 105 | R ×13 |
| Idle, app closed: anon memory | 165 MiB | 64 MiB | R −100 MiB |
| Selkies server idle: wakeups/s, CPU, RSS | 7.5/s, 0.09 %, 178 MiB | 99–103/s, 0.44 %, 118 MiB | |
| Connected, static screen (GPU): container CPU | 4.4 % | 5.0 % | ≈ (R +0.5, small but repeatable) |
| Orbit, GPU, 1600×900: container CPU | 55.5 % | 49.2 % | **R −6 points** (repeats ±1) |
| Orbit, GPU, DPR 2 (3200×1800 stream): container CPU | 41.2 % | 37.6 % | R −4 points |
| Orbit, GPU: decoded fps / bitrate | 34–35 fps, 10.6 Mbit/s | 34–37 fps, 10.6 Mbit/s | = (the app's render rate is the cap) |
| Orbit, no GPU, 1600×900 | 311 %, 11.6 fps | 310 %, 12.8 fps | = |
| Orbit, no GPU, DPR 2 | 333 %, 7.7 fps | 382 %, 10.9 fps | R +0.5 core, +3 fps (its x264 path: Selkies 85 % vs 22 %) |
| Input latency, mouse → decoded frame (median, 2 runs) | 41 / 44 ms | 39 / 33 ms | R equal or slightly faster; distributions overlap |
| 15 min connected: memory growth | none after one-off steps | none after one-off steps | =; R about 90 MiB lower |
| Cold start: `/api/health` / first frame / main window | 2.3 / 3.1 / 4.9 s | 1.9 / 2.7 / 4.2 s | R 0.4–0.7 s faster |
| Image size (uncompressed / compressed) | 4.78 / 1.23 GB | 2.97 / 0.77 GB | R −38 % |

Where the numbers come from [V, per-process data]:
- **Idle.** The app costs the same on both bases: about 27 wakeups/s and 1.3 % CPU. The whole idle difference is Selkies.
  - On Rust, its `tokio-rt-worker` threads account for 89 of the server's ~100 wakeups/s (§6.5).
  - On Python the server is at 7.5/s, which matches doc 14.
  - Against **stock** Python 2.2.1 with the app closed (doc 14 §5: container 70.9/s, 0.48 %), Rust (105/s, 0.48 %) uses the same CPU with about 1.5× the wakeups. So it is a regression against our patched image, not against stock 2.2.1.
  - Patched Python with the app closed measured 0.09 % here, against 0.05 % in doc 14 §5. The wakeups match (8/s against 8.1/s); the CPU gap is unexplained (different sampling windows or host load) [I].
- **Load with a GPU.** Rust's 6-point lead is almost exactly Python's labwc (3.6 %) plus nginx (1.5 %), which Rust doesn't run: the Rust server is both compositor and web server. The Selkies processes themselves cost the same, 9–10 %. The totals here (0.49–0.57 cores) are in line with doc 04 (0.62–0.72 cores at 1600×900) and doc 12 (~0.6 cores at 3200×1800).
- **DPR 2.** On *both* bases a fresh DPR-2 client gets an output scale of 2: Xwayland stays at 1600×900, and the stream is 3200×1800 upscaled. So the app never rendered at 3200×1800 in these runs, and the no-GPU DPR-2 rows (3.3–3.8 cores) are not comparable to doc 12's ~7 cores. Doc 12 also used a fresh headless DPR-2 client on Selkies 2.2.1, which §6.6 shows defaults to scale 2, so the reason for its ~7 cores is **unexplained** [I]. Open item: re-measure the no-GPU case with `SELKIES_SCALING_DPI=96` (a real 3200×1800 app), the setup the `CP_UI_SCALE` follow-up would create. See §6.6. **Done on Python:** [15 §4](15-hidpi-scaling.md) measured ~4.3–7.3 cores without a GPU (vs ~2.6 at the stretched default).
- **No GPU, Rust.** The Rust stream sometimes carried far more than the client decoded (eth0 3.5–7× the decoded bytes in 3 of 4 windows, e.g. 41.7 vs 5.9 Mbit/s). A diagnostic run showed that the browser receives the bytes and the client's socket worker drops them before decoding. It is intermittent, never seen on Python or with the GPU, and probably the headless software-decoding client not keeping up [I]. Worth re-checking with a real browser on a real display before relying on Rust without a GPU.
- **Memory.** Each base has one-off steps (Selkies on connect; WebKit +96 MiB on Rust), then stays flat within a few MiB for 10+ minutes. `/dev/shm` stays flat. One 15-minute session per base, so multi-hour behaviour is untested.

### 7.3 What this says about "Rust performs better"

- **Under load: slightly better, but not because of Rust code.** The saving is the processes Rust doesn't run (labwc and nginx); Selkies itself costs the same. Frame rate and bitrate are capped by the app's renderer and are identical. Latency may be a few ms better, within the spread.
- **Idle: worse.** For a server that sits idle 24/7 and is used now and then (the reason for docs 13 and 14), idle is the case that matters most. There, Rust costs 5× the CPU and 13× the wakeups once the app is closed. It does use about 100 MiB less memory.
- **Small wins:** image −1.8 GB, start 0.5 s faster, memory −90 to −190 MiB.
- **Caveats:**
  - The bases differ in more than Selkies: Ubuntu 26.04 with Mesa 26.0.8 against Debian trixie with Mesa 25.0.x, and no labwc or nginx on Rust.
  - Rust is a moving `0.0.0.dev0` build.
  - The client runs on the same host.
  - Intel only; NVIDIA and AMD are untested.
- **Gaps against the plan:** the memory check ran 15 minutes per base, not the ~30 planned. The planned 3200×1800 load case turned out to be a scale-2 upscale on both bases, so a full-resolution app render was never measured (see the open item above).

## 8. Decision

### 8.1 Is it worth moving before `debiantrixie` does?

**No.** Weighing the four inputs:

| Input | Points to |
|---|---|
| Motivation (§2) | Rust exists for packaging and maintainability; nothing in it targets our use. Performance was explicitly not the goal. |
| Stability (§4) | Pre-release: no version, a floating `:dev`, a contract break a week ago, no production adopters. Moving now means tracking `dev` by digest and re-validating on every bump. |
| Port effort (§6) | Small. 6 changes, all S. The work doesn't get cheaper by doing it early, and `dev` is still changing what the port depends on (`c4dede0` plus repairs). |
| Measured gains (§7) | A few points under GPU load, memory, image size, start time. A regression at idle, which is this server's normal state, and it undoes #15. |

Moving early buys small wins at load, pays for them at idle, and adds churn risk. The port doesn't get harder by waiting. The forced moment is also well defined: when `debiantrixie` switches, the Renovate base-bump PR fails CI at the patch step (doc 14 §4). Master keeps building and publishing on the old pinned digest, so nothing breaks for users.

Waiting does have a cost once that happens, and it argues for a time limit:
- The old digest is then frozen and gets no more Debian security rebuilds from the base. Our weekly no-cache rebuild only refreshes the packages we add.
- `renovate.json` groups the base digest with *all* tooling (Actions, Playwright, …) in one weekly "tooling updates" PR, so that PR stays red and blocks unrelated updates until the port lands.

So: don't move before the switch, but do the port within a few weeks of it.

### 8.2 What to do instead: prepare, then move when a trigger fires

1. **Land now the changes that already pay off on the Python base.** These are being done separately; this doc only records why.
   - **The `IDLE_QUIT` guard** against `RESTART_APP` / `SELKIES_APP_RESTART` / `EXIT_ON_APP_CLOSE`.
     - On Python this fixes a likely existing bug: `RESTART_APP` (also set by `HARDEN_OPENBOX`) makes the base's watchdog relaunch the app right after an idle close (§6.2 row 7). Reproduce it first.
     - It lands with a README / doc 13 note and an e2e case with `RESTART_APP=true`.
   - **A separate Renovate group for the base image.** `renovate.json` currently bundles the base digest with all tooling in one weekly PR, so a failing base bump blocks everything else. That already happens whenever our patch stops applying (doc 14 §4), not only at the Rust switch.
   - **The `vainfo` purge:** a no-op today, and a guard against the black stream on Intel Gen9 if the base adds `vainfo` again, as `dev` did.
2. **Keep the rest of the port for the move.** These only matter on Rust:
   - `session-env.sh` (a no-op on Python);
   - re-owning `/config/.XDG` and `/config/ssl` (harmless on Python, but nothing to gain);
   - the e2e readiness probe (`/api/health`, then 8082) and `input.spec`'s `pgrep -n`;
   - the base-specific changes: change the base, delete `svc-dbus/run` and the patch layer, and rename the two `dependencies.d` files. The rename would change start order on Python (§6.2 row 2).

   **Upstream:** nothing is filed by us (§6.5). HiDPI needs nothing upstream anyway: `SELKIES_SCALING_DPI=96` already works on both bases, and the image-side fix is done separately ([15 §4](15-hidpi-scaling.md)).
3. **No CI job on `:dev` for now.**
   - `:dev` rebuilds about 3.4 times a week against whatever Selkies commit is newest. A job there would mostly report upstream churn.
   - The port diff can't share one Dockerfile and overlay with the Python build without a second variant to maintain.
   - Re-run this doc's port (Appendix A) and its e2e matrix by hand when a trigger fires.
4. **Triggers to revisit:**
   - Selkies **2.3.0** is released;
   - `debiantrixie` (or a new Rust trixie tag) switches to Rust; Renovate will show it as a failing base bump;
   - upstream parks the idle timers;
   - `:dev` goes about 2 weeks without a contract-changing commit;
   - a mainstream linuxserver app image (orcaslicer, chromium, webtop default) moves to it.

### 8.3 Migration plan when a trigger fires

1. Pin the new base by digest in `Dockerfile` (`BASE_IMAGE`). Prefer a trixie Rust tag if one exists, so the distro stays the same; otherwise the Ubuntu one works (§6.4). If the tag name changes, update the pin comment and check that Renovate's Docker manager still picks the tag up (its rule from 8.2 step 1).
2. Apply the changes listed in 8.2 step 2 (Appendix A has the exact diff).
3. Decide on `input.spec`'s idle limit: keep 25/s if upstream parked the timers; otherwise re-baseline it and mark the regression in the README's idle numbers.
4. Re-run `scale.spec` and a DPR-2 screenshot with `CP_UI_SCALE=2` (§6.6); the `SELKIES_SCALING_DPI=96` fix is already on the Python base ([15 §4](15-hidpi-scaling.md)), so expect Xwayland at 3200×1800 there too.
5. Update the README: the Selkies idle cost; that app logs no longer reach `docker logs` (or set `SELKIES_APP_LOGS=true`); the right-click menu's new "Relaunch"; and `SELKIES_SESSION_SWITCH=false` if we hide the desktop switch.
6. Run the full e2e suite, the smoke test and the R7 checks (Preferences, slice, Preview), plus the GPU check that the stream isn't black (`vainfo` absent).
7. Check the untested Rust-session interactions (N10, N11): after an idle close and reconnect, use the menu's "Relaunch" and confirm only one app instance runs; check `DISPLAY` and the session env on a host where the GPU probe falls back to X11.

## 9. New risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| N1 | `debiantrixie` switches to Rust (expected around Selkies 2.3.0, date unknown), with a breaking redesign | Medium | Contained: the digest pin plus the patch step make the Renovate PR fail instead of publishing a broken image. But the old digest is frozen from then on (no base security rebuilds), and the grouped tooling PR is blocked, so port within a few weeks (§8.1, §8.3). |
| N2 | Rust idle timers: about 100 wakeups/s and 0.4 % of a core more at idle; undoes #15 | Medium for this use case | Watch for an upstream fix (we don't file one, §6.5); otherwise accept it and document it. Don't build our own Selkies bundle. |
| N3 | `vainfo` is back in the base: i965 on Intel Gen9 gives a **black stream** | High on Intel Gen9, if missed | `apt-get purge vainfo` in our Dockerfile on the Rust base; the GPU e2e spec should check for a non-black frame. |
| N4 | `RESTART_APP`/`SELKIES_APP_RESTART`/`EXIT_ON_APP_CLOSE` undo or escalate `IDLE_QUIT` | Medium (user config) | The guard in 8.2, which logs a warning and keeps `IDLE_QUIT` off. It already applies on Python, where `RESTART_APP` (also set by `HARDEN_OPENBOX`) conflicts through the watchdog (§6.2 row 7). |
| N5 | PUID change leaves `/config/.XDG` and `/config/ssl` with the old owner: Selkies never serves | High (container unusable) | Re-own them in `init-crealityprint-config` (8.2). |
| N6 | `:dev` floats to the newest Selkies commit and reports `0.0.0-dev.0` | Medium | Pin by digest; record the bundle hash (§1). |
| N7 | (Not Rust-specific, found here) `CP_UI_SCALE=2` is 4x and blurry for any HiDPI browser that hasn't picked UI Scaling 100 %, because the default is 200 % on both bases | Medium (the feature looks broken out of the box) | Set `SELKIES_SCALING_DPI=96` when `CP_UI_SCALE` ≥ 2; update the README, doc 15 and `scale.spec` (§6.6). **Done on Python** ([15 §4](15-hidpi-scaling.md)); re-check on Rust with `scale.spec`. |
| N8 | Rust without a GPU sometimes sends far more than a slow client decodes (§7.2) | Low (seen with a headless client only) | Re-check with a real browser before supporting GPU-less installs on Rust. |
| N9 | GTK/WebKit drift on a new distro (refines doc 09 R7: pango is bundled by the AppImage, GTK and WebKit are not) | Medium | R7's smoke checks on every base bump. |
| N10 | An app the idle daemon restarts (`setsid`) runs outside the WM's `selkies-autostart.lock`, so the WM thinks it has ended and its "Relaunch" could start a second instance [I, untested] | Low–Medium | §8.3 step 7; if confirmed, start the app through the WM instead of `setsid`. |
| N11 | `selkies session` silently falls back to X11 (`DISPLAY=:1`) when a GPU is present but unusable (`SELKIES_WAYLAND_X11_FALLBACK`). Our scripts assume `:0` [I, untested] | Low | The session-env import covers the scripts it is used in; §8.3 step 7. |

## Appendix A — the prototype diff

The prototype as run in §6–7: the unified diff of the port against master `2ef7ef4`.
Base: `BASE_IMAGE=ghcr.io/linuxserver/baseimage-selkies:dev@sha256:374f927a80586a02ec1e4290868780182d20189584148d73807fda87a11eb835`.
The test-harness hunks (`E2E_CONTAINER_PREFIX`, `E2E_RUNNER_IMAGE`, `SMOKE_CONTAINER_PREFIX`) only let the run use its own container names and runner image; they are not part of the port.

```diff
diff -ruN --exclude node_modules --exclude .git a/Dockerfile proto/Dockerfile
--- a/Dockerfile	2026-11-22 16:35:48.612677478 +0100
+++ b/Dockerfile	2026-11-22 16:37:20.663999385 +0100
@@ -34,6 +34,8 @@
 # inotify-tools + jq: upload watcher and first-run seeding. mesa-utils: glxinfo for GPU diagnostics.
 # Deliberately NOT installed: the optional gstreamer set (camera works without it), vainfo (black
 # stream on Intel Gen9), firefox and variable UI fonts (crash the app). See docs/research/09.
+# The Rust Selkies base (dev, Ubuntu) ships vainfo, which re-arms init-video's i965 probe: on a
+# UHD 630 that selects i965 and the stream goes black (docs/research/04). Purged so iHD is used.
 # Package versions aren't pinned: they come from the digest-pinned base's Debian release.
 # hadolint ignore=DL3008
 RUN \
@@ -45,6 +47,8 @@
     jq \
     libwebkit2gtk-4.1-0 \
     mesa-utils && \
+  echo "**** remove vainfo ****" && \
+  apt-get purge -y vainfo && \
   echo "**** cleanup ****" && \
   apt-get autoclean && \
   rm -rf \
@@ -58,12 +62,8 @@
   bash /tmp/fetch-crealityprint.sh "${CREALITYPRINT_VERSION}" && \
   rm -rf /tmp/*
 
-# Patch the base image's Selkies so it doesn't poll its key loops while nobody types
-# (docs/research/14). Fails the build when a base update changes the patched code.
-COPY build/patch-selkies.sh build/patches/ /tmp/patch-selkies/
-RUN \
-  bash /tmp/patch-selkies/patch-selkies.sh /tmp/patch-selkies/selkies-*.patch && \
-  rm -rf /tmp/*
+# No Selkies patch layer here: build/patch-selkies.sh patches the Python selkies package
+# (docs/research/14), and the Rust Selkies base has no Python selkies to patch.
 
 COPY /root /
 
diff -ruN --exclude node_modules --exclude .git a/root/etc/s6-overlay/s6-rc.d/init-crealityprint-config/run proto/root/etc/s6-overlay/s6-rc.d/init-crealityprint-config/run
--- a/root/etc/s6-overlay/s6-rc.d/init-crealityprint-config/run	2026-11-22 16:35:48.613026176 +0100
+++ b/root/etc/s6-overlay/s6-rc.d/init-crealityprint-config/run	2026-11-22 16:37:20.664973009 +0100
@@ -22,6 +22,12 @@
   # X11 D-Bus autolaunch state (mode 0700). If abc can't read it, the app gets no session
   # bus and the upload watcher can't hand files to it.
   "${config_home}/.dbus"
+  # Rust Selkies base: the server itself runs as abc, empties its runtime dir at start and
+  # reads the HTTPS key (mode 0600). Left with the old uid after a PUID change, it loops on
+  # "cannot make a runtime directory" and never serves (on the Python base nginx read the key
+  # as root and init-selkies-config recreated ~/.XDG).
+  "${config_home}/.XDG"
+  "${config_home}/ssl"
 )
 
 # Print the first path (two levels deep) in the state dirs that abc doesn't own, if any.
diff -ruN --exclude node_modules --exclude .git a/root/etc/s6-overlay/s6-rc.d/init-crealityprint-idle/run proto/root/etc/s6-overlay/s6-rc.d/init-crealityprint-idle/run
--- a/root/etc/s6-overlay/s6-rc.d/init-crealityprint-idle/run	2026-11-22 16:03:26.892030944 +0100
+++ b/root/etc/s6-overlay/s6-rc.d/init-crealityprint-idle/run	2026-11-22 16:37:06.106622969 +0100
@@ -46,6 +46,25 @@
   chmod 0700 "$runtime_dir"
 }
 
+# Why: on the Rust Selkies base the session restarts its autostart app as soon as it exits
+# (SELKIES_APP_RESTART, which RESTART_APP turns on), or stops the container when it exits
+# (EXIT_ON_APP_CLOSE). Either would undo or escalate an idle close.
+is_true() {
+  local value="${1:-}"
+  value="${value%%|*}"
+  [ "${value,,}" = "true" ]
+}
+
+conflicting_setting() {
+  if is_true "${EXIT_ON_APP_CLOSE:-}"; then
+    echo "EXIT_ON_APP_CLOSE"
+  elif is_true "${SELKIES_APP_RESTART:-}"; then
+    echo "SELKIES_APP_RESTART"
+  elif is_true "${RESTART_APP:-}"; then
+    echo "RESTART_APP"
+  fi
+}
+
 install_hooks() {
   printf '%s' "$connect_hook" > "${env_dir}/SELKIES_RUN_AFTER_CONNECT"
   printf '%s' "$disconnect_hook" > "${env_dir}/SELKIES_RUN_AFTER_DISCONNECT"
@@ -66,6 +85,13 @@
     return
   fi
 
+  local conflict
+  conflict="$(conflicting_setting)"
+  if [ -n "$conflict" ]; then
+    log "${conflict} is set; IDLE_QUIT stays off, because the app would be restarted or the container stopped on every idle close"
+    return
+  fi
+
   create_runtime_dir
   install_hooks
 }
diff -ruN --exclude node_modules --exclude .git a/root/etc/s6-overlay/s6-rc.d/svc-dbus/run proto/root/etc/s6-overlay/s6-rc.d/svc-dbus/run
--- a/root/etc/s6-overlay/s6-rc.d/svc-dbus/run	2026-11-22 16:03:26.893030944 +0100
+++ b/root/etc/s6-overlay/s6-rc.d/svc-dbus/run	1970-01-01 01:00:00.000000000 +0100
@@ -1,7 +0,0 @@
-#!/usr/bin/with-contenv bash
-# shellcheck shell=bash
-# Disable the base image's *system* D-Bus, as docker-orcaslicer does: the app doesn't need it,
-# and its hostname1 activation attempts only produce permission errors in a container.
-# The *session* bus (single-instance forwarding) comes from X11 autolaunch and is unaffected.
-
-sleep infinity
diff -ruN --exclude node_modules --exclude .git a/root/usr/local/bin/crealityprint proto/root/usr/local/bin/crealityprint
--- a/root/usr/local/bin/crealityprint	2026-11-22 16:35:48.613026176 +0100
+++ b/root/usr/local/bin/crealityprint	2026-11-22 16:37:20.664934319 +0100
@@ -25,6 +25,12 @@
   export GDK_SCALE="$requested_scale"
 }
 
+# Started outside the Selkies session (idle daemon, upload watcher, docker exec): take the
+# session's environment, so the app joins its D-Bus (see the sourced file for why).
+# shellcheck source=/usr/local/lib/crealityprint/session-env.sh
+. /usr/local/lib/crealityprint/session-env.sh
+import_selkies_session_env
+
 apply_ui_scale
 
 exec /opt/crealityprint/AppRun "$@"
diff -ruN --exclude node_modules --exclude .git a/root/usr/local/bin/crealityprint-open proto/root/usr/local/bin/crealityprint-open
--- a/root/usr/local/bin/crealityprint-open	2026-11-22 16:03:26.894030944 +0100
+++ b/root/usr/local/bin/crealityprint-open	2026-11-22 16:37:06.106767559 +0100
@@ -13,6 +13,11 @@
 # The app runs on Xwayland :0; the session bus is found through X11 autolaunch on that
 # display. The container env says DISPLAY=:1 (X11 mode default), which would fail.
 export DISPLAY=:0
+# On the Rust Selkies base the session bus is not found through X11 autolaunch but given in the
+# session's environment file; take it from there (no-op on the Python base).
+# shellcheck source=/usr/local/lib/crealityprint/session-env.sh
+. /usr/local/lib/crealityprint/session-env.sh
+import_selkies_session_env
 
 readonly bus_name_prefix="io.github.crealityofficial.CrealityPrint.InstanceCheck.Object"
 readonly app_binary="/opt/crealityprint/bin/CrealityPrint"
diff -ruN --exclude node_modules --exclude .git a/root/usr/local/lib/crealityprint/session-env.sh proto/root/usr/local/lib/crealityprint/session-env.sh
--- a/root/usr/local/lib/crealityprint/session-env.sh	1970-01-01 01:00:00.000000000 +0100
+++ b/root/usr/local/lib/crealityprint/session-env.sh	2026-11-22 16:37:06.106835339 +0100
@@ -0,0 +1,39 @@
+# shellcheck shell=bash
+# Sourced by the launcher and crealityprint-open: join the Selkies desktop session's environment.
+#
+# Why: the Rust Selkies server (`selkies session`) runs its own session D-Bus, PulseAudio and
+# Xwayland, and only the programs its window manager starts (the autostart) inherit their
+# addresses. Programs started from s6 services (the idle daemon, the upload watcher) or
+# `docker exec` don't, so the app would X11-autolaunch a second bus that crealityprint-open never
+# sees. Selkies writes the session's environment to $XDG_RUNTIME_DIR/selkies-session-env.json
+# (the runtime dir is emptied at every start, so the file is never stale). On the Python base
+# there is no such file and nothing changes.
+
+# Variables that describe this process rather than the session; never copied.
+readonly session_env_skipped_keys='["PWD","SHLVL","HOME","OLDPWD","_"]'
+
+session_env_file() {
+  echo "${XDG_RUNTIME_DIR:-/config/.XDG}/selkies-session-env.json"
+}
+
+# True when this process already runs inside the Selkies session (started by its WM).
+in_selkies_session() {
+  [ -n "${SELKIES_SESSION_ID:-}" ]
+}
+
+import_selkies_session_env() {
+  local env_file
+  env_file="$(session_env_file)"
+  if in_selkies_session || [ ! -r "$env_file" ]; then
+    return 0
+  fi
+  local exports
+  if ! exports="$(jq -r --argjson skipped "$session_env_skipped_keys" '
+      to_entries[]
+      | select(.key as $key | $skipped | index($key) | not)
+      | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$"))
+      | "export \(.key)=\(.value | @sh)"' "$env_file" 2> /dev/null)"; then
+    return 0
+  fi
+  eval "$exports"
+}
diff -ruN --exclude node_modules --exclude .git a/tests/e2e/input.spec.js proto/tests/e2e/input.spec.js
--- a/tests/e2e/input.spec.js	2026-11-22 16:35:48.613026176 +0100
+++ b/tests/e2e/input.spec.js	2026-11-22 16:39:45.859276179 +0100
@@ -16,7 +16,9 @@
 // the threads present at both ends (a thread that exits in between would take its count along).
 async function selkiesWakeupsPerSecond(app) {
   const output = await app.exec(
-    `pid="$(pgrep -o -x selkies)"
+    // Newest "selkies": on the Rust base the oldest is the `selkies session` supervisor and the
+    // streaming server is its child; on the Python base there is only the server.
+    `pid="$(pgrep -n -x selkies)"
      per_thread() {
        for task in /proc/"$pid"/task/*; do
          echo "\${task##*/} $(awk '/ctxt_switches/ { n += $2 } END { print n }' "$task/status" 2> /dev/null)"
diff -ruN --exclude node_modules --exclude .git a/tests/e2e/lib/app.js proto/tests/e2e/lib/app.js
--- a/tests/e2e/lib/app.js	2026-11-22 16:35:48.613026176 +0100
+++ b/tests/e2e/lib/app.js	2026-11-22 16:37:06.106908042 +0100
@@ -16,6 +16,8 @@
 const runId = process.env.E2E_RUN_ID || 'local';
 const workDir = process.env.E2E_WORK_DIR;
 const appCpus = process.env.E2E_APP_CPUS || '';
+// Lets parallel checkouts tell their app containers apart in docker ps.
+const containerPrefix = process.env.E2E_CONTAINER_PREFIX || 'crealityprint-e2e';
 const hostUid = String(process.getuid());
 const hostGid = String(process.getgid());
 
@@ -65,7 +67,7 @@
 
   // Start a container. Options: label, env {}, configDir, devices [], puid/pgid.
   static async start({ label, env = {}, configDir, devices = [], puid = hostUid, pgid = hostGid }) {
-    const name = `crealityprint-e2e-${label}-${crypto.randomBytes(3).toString('hex')}`;
+    const name = `${containerPrefix}-${label}-${crypto.randomBytes(3).toString('hex')}`;
     const dir = configDir || newConfigDir(label);
     const args = [
       'run', '--detach',
@@ -118,17 +120,21 @@
     return docker(args);
   }
 
-  // Init done *and* Selkies serving: right after init, nginx answers /api/* with 404 until
-  // the Selkies server (127.0.0.1:8082 inside the container) is up.
+  // Init done *and* Selkies serving. Python Selkies (2.2.x): nginx answers /api/* with 404
+  // until the Selkies server (127.0.0.1:8082 inside the container) is up. Rust Selkies serves
+  // 3000/3001 itself and answers /api/health (without auth) once it is up.
   async waitForInit() {
     await poll('container init', async () => (await this.logs()).includes('[ls.io-init] done.'));
     await poll('the Selkies server', async () => {
-      const status = await docker(
-        ['exec', this.name, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
-          'http://127.0.0.1:8082/api/file-manager/browse?path='],
+      const httpStatus = async (url) => (await docker(
+        ['exec', this.name, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url],
         { allowFailure: true },
-      );
-      return status.trim() !== '' && status.trim() !== '000';
+      )).trim();
+      if ((await httpStatus('http://127.0.0.1:3000/api/health')) === '200') {
+        return true;
+      }
+      const legacyStatus = await httpStatus('http://127.0.0.1:8082/api/file-manager/browse?path=');
+      return legacyStatus !== '' && legacyStatus !== '000';
     }, { intervalMs: 500 });
   }
 
diff -ruN --exclude node_modules --exclude .git a/tests/run-e2e.sh proto/tests/run-e2e.sh
--- a/tests/run-e2e.sh	2026-11-22 16:03:26.896030944 +0100
+++ b/tests/run-e2e.sh	2026-11-22 16:37:06.106988591 +0100
@@ -16,7 +16,8 @@
 repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
 readonly repo_dir
 readonly e2e_dir="${repo_dir}/tests/e2e"
-readonly runner_image="crealityprint-e2e-runner:local"
+# E2E_RUNNER_IMAGE: lets a second checkout build its own runner tag instead of retagging this one.
+readonly runner_image="${E2E_RUNNER_IMAGE:-crealityprint-e2e-runner:local}"
 readonly artifacts_dir="${E2E_ARTIFACTS_DIR:-${repo_dir}/e2e-artifacts}"
 
 image=""
@@ -106,6 +107,7 @@
     --env E2E_WORK_DIR="$work_dir" \
     --env E2E_HAS_DRI="$(has_gpu)" \
     --env E2E_APP_CPUS="$app_cpus" \
+    --env E2E_CONTAINER_PREFIX \
     --env E2E_ARTIFACTS_DIR=/e2e/artifacts \
     --volume /var/run/docker.sock:/var/run/docker.sock \
     --volume "${e2e_dir}:/e2e/tests:ro" \
diff -ruN --exclude node_modules --exclude .git a/tests/smoke.sh proto/tests/smoke.sh
--- a/tests/smoke.sh	2026-11-22 16:03:26.897726785 +0100
+++ b/tests/smoke.sh	2026-11-22 16:37:06.107038838 +0100
@@ -9,7 +9,8 @@
 set -euo pipefail
 
 readonly image="${1:?usage: tests/smoke.sh <image>}"
-readonly container_name="crealityprint-smoke-$$"
+# SMOKE_CONTAINER_PREFIX: lets a parallel run name its container apart.
+readonly container_name="${SMOKE_CONTAINER_PREFIX:-crealityprint-smoke}-$$"
 config_dir="$(mktemp -d)"
 readonly config_dir
 

# Not shown by diff (empty files renamed):
#   root/etc/s6-overlay/s6-rc.d/svc-crealityprint-idle/dependencies.d/svc-de -> .../svc-selkies
#   root/etc/s6-overlay/s6-rc.d/svc-crealityprint-upload-watcher/dependencies.d/svc-de -> .../svc-selkies
```

## Appendix B — benchmark sampling method

The §7 numbers come from two snapshots per window, both read **on the host**, so nothing is exec'd into the container while a window runs. Exec'ing in adds context switches of its own, which is why the first port run's container totals were higher (§6.5).

```python
# CPU: the container cgroup's cumulative usage, in microseconds.
#   /sys/fs/cgroup/system.slice/docker-<full container id>.scope/cpu.stat  ->  "usage_usec N"
# cpu_percent = (usage_usec_end - usage_usec_start) / (window_seconds * 1e6) * 100   (% of one core)
#
# Wakeups: voluntary + nonvoluntary context switches of every thread of every process in the
# container (PIDs from the cgroup's cgroup.procs), summed over threads present at both snapshots:
#   /proc/<pid>/task/<tid>/status  ->  "voluntary_ctxt_switches", "nonvoluntary_ctxt_switches"
# wakeups_per_second = sum(delta switches) / window_seconds
#
# Memory: memory.current and memory.stat (anon / file / shmem) from the same cgroup; VmRSS
# from /proc/<pid>/status; /dev/shm usage via statvfs on /proc/<pid>/root/dev/shm.
```

- **Windows:** 60 s for CPU, about 75 s for wakeups (doc 14 §5).
- **Idle:** starts when the app's main window is up plus 3 minutes.
- **App closed:** SIGTERM to `CrealityPrint`, then a 30 s pause.
- **Order:** one container at a time for load runs, alternating Python and Rust.
- **Client:** headless Chromium (Playwright) on the same host, wrapping `VideoDecoder` to count decoded frames and bytes. Load: a 640k-triangle STL orbited with the right mouse button held.
