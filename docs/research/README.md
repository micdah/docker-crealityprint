# Research: Creality Print in a Selkies web container

What we know about running Creality Print in the browser on linuxserver's Selkies base image, and why this image is built the way it is. User-facing setup is in the [main README](../../README.md).

Each doc describes the image as it is now. When the image changes, update the topic doc in the same PR. Claims are tagged **[V]** verified (seen in source, or tested with this image or its research builds) or **[I]** inferred. Test host for the hands-on results: Docker 29 on x86_64 Arch Linux with an Intel UHD 630, and a real Creality K1C for the printer tests.

## Documents

| Doc | Covers |
|---|---|
| [decisions.md](decisions.md) | What the image does and why, what was rejected, risks to watch, open questions. **Start here.** |
| [base-image.md](base-image.md) | linuxserver's Selkies base image: services and start order, how the app is launched, displays, D-Bus, ports and HTTPS, presence hooks, Selkies' idle cost and the key-loop patch |
| [app.md](app.md) | Creality Print itself: releases and assets, how the image installs it, the AppImage, libraries, single-instance D-Bus, first run, cloud and updates, footprint |
| [gpu.md](gpu.md) | GPU acceleration: rendering vs encoding, measured cost, running without a GPU, Intel pitfalls, NVIDIA/AMD notes, long-session stability |
| [hidpi.md](hidpi.md) | Sharp UI on HiDPI screens (`CP_UI_SCALE`): why Selkies' UI Scaling blurs the app, the GTK scale and the pinned Selkies DPI, caveats and cost |
| [persistence.md](persistence.md) | Where state lives, what survives restart, re-create and upgrade, data-directory migration, ownership repair, first-run seed |
| [files.md](files.md) | Upload and download, the app's file dialogs, auto-open of uploads, drag-and-drop, clipboard, securing the file API |
| [printers.md](printers.md) | Adding printers by IP, discovery and firewalls, control, sending G-code, cameras, the start-print safety finding |
| [idle-quit.md](idle-quit.md) | The opt-in "close when idle" feature: design, the app-restarter guard, unsaved work, measurements, tests |
| [selkies-rust.md](selkies-rust.md) | The Rust rewrite of Selkies (the base's `dev` tag): what changes, the trial port, benchmarks, and why the image waits |

## Summary

- **It works.** Creality Print's x86_64 AppImage runs on `baseimage-selkies:debiantrixie` with one extra package, `libwebkit2gtk-4.1-0`, following docker-orcaslicer's recipe. amd64 only: there is no aarch64 AppImage.
- **GPU:** pass `/dev/dri` and nothing else. The app renders on the GPU and the stream is encoded with VA-API. Orbiting a large model drops from about 3 cores at 12–15 frames/s to about 0.6 cores at 55 frames/s, whatever the stream size. Never install `vainfo` (the build purges it). NVIDIA and AMD are untested.
- **HiDPI screens:** `CP_UI_SCALE=2` (or 3, 4) makes the app draw itself larger at the browser's full resolution, so it stays sharp; the image pins Selkies' DPI to 96 so Selkies doesn't stretch it on top.
- **Settings** live in `/config` and survive restarts, re-creates, upgrades within 7.3, and the app's own 7.0 → 7.3 migration. The image repairs ownership after a `PUID`/`PGID` change and can seed a printer on first run (`CP_PRINTER`).
- **Files** move through Selkies' Files panel (`/config/Desktop`); the app's own dialogs can't reach the user's device. Opt-in auto-open adds uploaded models to the open plate over the app's single-instance D-Bus call. Without `PASSWORD`, the file API is open to anyone who can reach the port.
- **Printers:** add them by IP on Docker's bridge network. Status, Send Only uploads and both camera types work; automatic discovery doesn't. Never start a print as a test.
- **Idle cost:** a build-time patch parks Selkies' two always-on key loops (about 60 wakeups/s less). Opt-in close when idle closes the app while no browser is connected, cutting the container from about 1.5 % to under 0.1 % of a core and from 1.4 GiB to 160 MiB, and starts it again on the next connection.
- **Rust Selkies:** upstream rewrote Selkies in Rust. A trial port works, but the image stays on today's base until Selkies 2.3.0 or until `debiantrixie` switches.
- **HTTPS is required** for the web client (`https://<host>:3001` or a TLS proxy).

Open questions and risks to watch are listed in [decisions.md](decisions.md).
