# Research: Creality Print in a Selkies web container

Date: 2026-11-21. These are the research findings for building a `linuxserver/docker-orcaslicer`-style image that runs **Creality Print** in the browser on `linuxserver/docker-baseimage-selkies`. The findings combine desk research (source code, docs, issues) with hands-on tests on a local Docker host (x86_64, Intel UHD 630). Claims are tagged **verified** (seen in source or tested) or **inferred**.

**Starting the build? Read [10-implementation-brief.md](10-implementation-brief.md) first, then [09-roadblocks-and-risks.md](09-roadblocks-and-risks.md).**

## Executive summary

- **It works.** Creality Print **V7.3.1** (the official x86_64 AppImage, built on Ubuntu 24.04) runs in `ghcr.io/linuxserver/baseimage-selkies:debiantrixie`. orcaslicer's recipe (extract the AppImage, force `GDK_BACKEND=x11`, `chmod 755`, disable the system D-Bus) plus **one** extra package (`libwebkit2gtk-4.1-0`) was enough. The first-run wizard, STL import and slicing were all tested in the browser [verified, [07](07-hands-on-baseline.md)].
- **The base distro is settled.** The app needs webkit2gtk-**4.1**/libsoup-3, which Debian Trixie provides. This matches what orcaslicer uses [verified].
- **amd64 only.** Creality publishes no arm64 AppImage [verified].
- **No hard blockers.** The main risks are ownership after a PUID change, autostart that never refreshes, unstable release-asset naming, LAN discovery under bridge networking, and font/pango ABI drift. All of them have mitigations ([09](09-roadblocks-and-risks.md)).
- **Tested with a real Creality K1C** ([11](11-printer-tests.md)) on Docker's default bridge networking:
  - Adding the printer by IP gives live status, "Send Only" G-code upload and both camera types (MJPEG, and WebRTC after a firmware update).
  - The printer stays configured across container re-creation.
  - Automatic discovery (mDNS) does not work in bridge mode. On this host it also failed with host networking, because ufw drops the replies.
  - **Safety:** starting any print on a Creality OS printer runs its own heat/home routine, even for a dummy file, and can leave the heaters on. Never test printing through the container; use upload-only.

## Answers to the three focus questions

### 1. GPU acceleration ("like orcaslicer"): [04](04-gpu-acceleration.md)

- **Works out of the box. Just pass `--device /dev/dri:/dev/dri`** (compose `devices: [/dev/dri:/dev/dri]`, plus `shm_size: 1gb`). The base image's init scripts handle group mapping and node selection. No env vars are needed [verified on UHD 630].
- The GPU then does **two separate jobs**:
  - **Creality Print's OpenGL view** renders on the GPU (`Mesa Intel UHD Graphics 630`, OpenGL 4.6, iris driver).
  - **The Selkies stream** is encoded with zero-copy **VA-API H.264**.
- Without a GPU it falls back to llvmpipe + x264 and stays usable.
- Measured container CPU while orbiting the 3D view, in two separate test runs [verified]:

  | Stream resolution | With GPU | Without GPU | Source |
  |---|---|---|---|
  | 1600×900 (640k-triangle model) | ~0.65 cores | ~2.5 cores | [04 hands-on](04-gpu-acceleration.md) |
  | 3200×1800 (browser at devicePixelRatio 2) | ~0.6 cores | **~7 cores** | [12 §4](12-remaining-hands-on.md) |

  Without a GPU, the cost grows with the number of streamed pixels, because llvmpipe renders and x264 encodes every pixel on the CPU. With the GPU it stays flat. Most of the saving comes from the app's rendering, not the encoder.
- **Stable over time:** 29-minute sessions with and without the GPU showed flat `/dev/shm` and memory (about 1.8–1.9 GiB per container). So there's no sign of base issue #142, and `shm_size: 1gb` is plenty ([12 §4](12-remaining-hands-on.md)) [verified]. **Recommended setup: pass the GPU**, and plan about 2 GiB RAM per container.
- Gotchas:
  - Never install `vainfo` in the image: it triggers the base's i965 switch and gives a black stream.
  - `AUTO_GPU=false` doesn't turn the GPU off.
  - NVIDIA/AMD are untested. NVIDIA needs the container toolkit and driver ≥ 580, and Creality Print has open NVIDIA blank-view bugs.

### 2. Settings persistence across restart, update and re-create: [05](05-settings-persistence.md)

- **Mount one volume at `/config`** (the `abc` user's `$HOME`). Everything that matters lives there [verified]:
  - Settings, presets, login token, printer list: `/config/.config/Creality/Creality Print/7.3/` (`Creality.conf` is JSON).
  - WebKit storage: `/config/.local/share/CrealityPrint` and `/config/.cache/CrealityPrint`.
- `docker rm -f` + re-create kept the printer, a custom preset and preferences, with no wizard. Settings are written immediately [verified].
- **Image updates**:
  - Same data epoch (7.3.1 ↔ 7.3.2): the same folder is reused, and vendor profiles update [verified].
  - An epoch change (7.2.1's `7.0/` → 7.3.1's `7.3/`): the app migrated config and presets automatically and left the old folder untouched [verified].
  - A future epoch bump must be re-tested before release.
- **Must-do in our image**:
  - Recursively fix ownership when PUID/PGID changes. Without it the desktop doesn't start [verified].
  - Launch through a stable wrapper path, because autostart is copied into `/config` once and never refreshed [verified].
- **Pre-seeding works** [verified]:
  - A seeded `Creality.conf` with `models` + `presets` skips the wizard.
  - `privacyInfo.json` with `check:false` removes the telemetry opt-in dialog.
- Only the unsaved-project auto-backup lives outside `/config` (in `/tmp`).

### 3. Getting files in and out of the web app: [06](06-file-transfer.md)

- **Upload**: the Selkies sidebar → **Files → Upload Files** opens the *browser's* own file picker on the client device. Drag-and-drop onto the stream also works. Files land in **`/config/Desktop`** (`FILE_MANAGER_PATH`). Large files are chunked in 64 MiB slices. Tested with 150 MiB, sha256 matching [verified].
- **Download**: Files → **Download Files** lists that folder, with a Download button per file (folders download as zip) [verified for G-code and 3MF].
- **Can the app's "Open file" dialog reach the client device? No.** Creality Print's GTK dialog only sees the container's filesystem. Selkies has no remote file chooser or portal bridge (open upstream request selkies#516). The clipboard carries text both ways and images browser → app only; it never carries files [verified, [12 §2](12-remaining-hands-on.md)].
- **Recommended UX** [verified]:
  - Pre-set `recent.last_opened_folder` and `app.last_export_path` to `/config/Desktop`, so Import and Export open where uploads land.
  - Optionally mount a NAS folder under `/config/Desktop/...`.
  - Optionally ship an **upload watcher** (opt-in, e.g. `AUTO_OPEN_UPLOADS=true`), using the `ft-watcher2` design in [12 §1](12-remaining-hands-on.md):
    - It watches `/config/Desktop` for finished uploads.
    - It hands each one to the running Creality Print over the app's own single-instance D-Bus call (with `DISPLAY=:0`). If the app isn't running, it starts it with the file.
    - Result, verified: an uploaded or dropped **STL is added to the current plate about 1 s later**, and unsaved edits are kept (both never-saved and saved-then-modified projects). A **3MF** gets the app's own "Drop project file" and "save changes?" dialogs.
    - New models land at the bed centre and can overlap; press *Arrange*.
    - The first prototype (`ft-watcher`, described in [06 R7](06-file-transfer.md)) seemed to "replace the plate". It actually started a second app window because of a bug. Don't use it.
  - **Drag-and-drop** onto the stream uploads files and folders through the same API, and with the watcher they reach the plate (automated with CDP `Input.dispatchDragEvent`) [verified].
  - **Use HTTPS** (`https://<host>:3001` or a TLS proxy): plain `http://<lan-ip>:3000` gives a black page, and the clipboard needs a secure context [verified].
  - Or skip downloads entirely by sending G-code to the printer over the LAN.
- **Security**: `HARDEN_DESKTOP=true` does *not* disable transfers. Use `SELKIES_FILE_TRANSFERS=none` and/or `PASSWORD` (basic auth on the UI and file API) [verified].

### Rust Selkies: move now or wait? [16](16-selkies-rust.md)

- **Upstream rewrote Selkies in Rust for packaging and maintainability, not performance.** The Python 2.2.1 line is frozen. The Rust version will ship as 2.3.0, with no date announced. linuxserver's `dev` tag carries it today, on Ubuntu 26.04 with a redesigned base: no nginx, and its own session and window manager [V].
- **The port is small and works.** Six small changes, and 15 of 16 e2e tests pass. The AppImage bundles its own pango, so the Ubuntu base doesn't crash it [V].
- **Performance:** about even under load (−6 points with a GPU, from dropping labwc and nginx). **Worse at idle:** with the app closed it uses 0.48 % of a core against 0.09 %, because the Rust server keeps the always-on key timers that doc 14 parked [V].
- **HiDPI, found along the way (affects today's image):** a fresh HiDPI browser defaults to Selkies UI Scaling 200 % on both bases, so `CP_UI_SCALE=2` alone gives a 4x blurry app. It is sharp only after the user picks 100 % (stored per browser) or with `SELKIES_SCALING_DPI=96`. Fixed: the image now sets `SELKIES_SCALING_DPI=96` while `CP_UI_SCALE` is 2–4 ([15 §4](15-hidpi-scaling.md); found in [16 §6.6](16-selkies-rust.md), N7) [V].
- **Decision: prepare, but don't move yet.** Land now the three changes that already pay off on Python (an `IDLE_QUIT` guard, a Renovate group for the base image, a `vainfo` purge), keep the rest of the port for the move, and revisit at Selkies 2.3.0 or when `debiantrixie` switches. That switch fails the Renovate build at our patch step, so it can't slip in unnoticed.

## Documents

| # | File | Contents |
|---|---|---|
| 01 | [01-baseimage-selkies.md](01-baseimage-selkies.md) | Base image flavours, build, s6 service tree, app launch contract, env vars, ports/HTTPS, `/config` layout, limits |
| 02 | [02-docker-orcaslicer.md](02-docker-orcaslicer.md) | orcaslicer Dockerfile walkthrough, `root/` overlay, CI/version tracking, history of fixes, "copy vs adapt" |
| 03 | [03-creality-print.md](03-creality-print.md) | Creality Print releases/assets, version detection, lineage/licence (AGPL-3.0), deps, Linux bugs, config dir, networking/camera/cloud |
| 04 | [04-gpu-acceleration.md](04-gpu-acceleration.md) | **Focus 1**: GPU for app rendering vs stream encoding, Intel/AMD/NVIDIA, hands-on measurements |
| 05 | [05-settings-persistence.md](05-settings-persistence.md) | **Focus 2**: data paths, upgrade/migration, what the base overwrites, pre-seeding, hands-on tests T0–T6 |
| 06 | [06-file-transfer.md](06-file-transfer.md) | **Focus 3**: Selkies upload/download, env vars, "Open file" verdict, workflows, security (its watcher prototype R7 is superseded by 12 §1) |
| 07 | [07-hands-on-baseline.md](07-hands-on-baseline.md) | Getting it running: `ldd`, deps, the working throwaway Dockerfile, the wizard, config paths, resource numbers |
| 08 | [08-prior-art.md](08-prior-art.md) | Existing community Creality Print containers (none maintained), sibling lsio images, lessons |
| 09 | [09-roadblocks-and-risks.md](09-roadblocks-and-risks.md) | Consolidated risk register with severities and mitigations; contradictions resolved |
| 10 | [10-implementation-brief.md](10-implementation-brief.md) | Kickoff for the build: proposed Dockerfile changes, repo layout, compose, CI, acceptance checklist, open decisions |
| 11 | [11-printer-tests.md](11-printer-tests.md) | Real K1C tests: discovery (bridge/host), add-by-IP, upload, cameras, gstreamer, the heater safety finding, re-create persistence |
| 12 | [12-remaining-hands-on.md](12-remaining-hands-on.md) | Upload watcher with unsaved work (fixed design), clipboard, drag-and-drop, 29-min stability runs (CPU and GPU) |
| 13 | [13-idle-quit.md](13-idle-quit.md) | Opt-in "close when idle" (`IDLE_QUIT`): idle CPU baseline, Selkies presence hooks, close/restart design, unsaved-work recovery, watcher interaction, Selkies' own idle cost, tests, measurements |
| 14 | [14-selkies-idle.md](14-selkies-idle.md) | Selkies' idle key-loop wakeups, the build-time patch that parks them, how the build fails when it no longer applies, measurements |
| 15 | [15-hidpi-scaling.md](15-hidpi-scaling.md) | Sharp HiDPI UI (`CP_UI_SCALE`): why Selkies' UI Scaling blurs an Xwayland app, the `GDK_SCALE` spike (3D picking, WebKit pages, fractional variants), design; §4: Selkies' DPI follows the browser, so the image pins `SELKIES_SCALING_DPI=96`, and the CPU cost of full-resolution rendering |
| 16 | [16-selkies-rust.md](16-selkies-rust.md) | Rust Selkies (base `dev`): why upstream rewrote it, roadmap, stability, base contract diff, the hands-on port and its e2e results, Python vs Rust benchmarks, decision and migration plan |

## Open questions (need a decision or real hardware)

1. Prerelease policy: stable only (`releases/latest`), or also a `:beta` tag?
2. Ship Firefox (~250 MB) for third-party OAuth login and external links, or document email/QR login only?
3. Creality Cloud login inside the container, and whether a fixed `mac_address` is needed (skipped on purpose).
4. Auto-discovery with host networking on a host without a firewall, or with macvlan; K2-family printers.
5. NVIDIA/AMD GPU behaviour.
6. Manual checks: a real OS drag-and-drop, the Firefox clipboard, and a multi-hour idle run.

## Research environment notes

- Hands-on artefacts (throwaway Dockerfiles, test scripts, screenshots) are in the session scratchpad, which is temporary. The baseline Dockerfile and overlay are inlined in [07](07-hands-on-baseline.md), and the working watcher design (`ft-watcher2`) is described in [12 §1.5](12-remaining-hands-on.md), so nothing essential depends on the scratchpad.
- The host had no Playwright browser. Browser automation ran in `mcr.microsoft.com/playwright:v1.49.0-noble` with `--network host`.
