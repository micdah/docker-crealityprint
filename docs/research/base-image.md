# The Selkies base image

How linuxserver's `baseimage-selkies` works, and how this image hooks into it. The reasons behind each choice are in [decisions.md](decisions.md).

- The image is built `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie`, pinned by digest. The base brings the whole web desktop: nginx with HTTPS, the Selkies streaming server, the labwc compositor with Xwayland, PulseAudio, s6-overlay and the LinuxServer `PUID`/`PGID` handling.
- The app is started by labwc's autostart, which the base copies into `/config` once and never refreshes. So the autostart and the menus only call the stable launcher `/usr/local/bin/crealityprint`.
- In Wayland mode the app runs on Xwayland `:0`, while the container environment says `DISPLAY=:1`. Anything outside the desktop that talks to the app, or to its session D-Bus, must set `DISPLAY=:0`.
- The browser must load the page from a secure origin (HTTPS, or `localhost`). Otherwise the video decoder and the clipboard are missing and the page stays black.
- Selkies reports when the first browser connects and when the last one leaves (`SELKIES_RUN_AFTER_CONNECT` / `_DISCONNECT`). Unpatched, it wakes the CPU about 68 times a second with no browser connected, from two key-handling loops no setting reaches; the image patches them to park while nobody types.

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.

Verified against: selkies 2.2.1, pixelflux 2.2.3, pcmflux 2.2.1, base image `debiantrixie` (digest pinned in the `Dockerfile`; Debian 13, labwc 0.9.7, Mesa 25.0.7).

## Flavours and tags

- The base has **no `latest` tag**. Downstream images pin a distro tag [V]. It is published as `ghcr.io/linuxserver/baseimage-selkies:<tag>`, and on Docker Hub as `lsiobase/selkies:<tag>`. Immutable release tags look like `debiantrixie-f7632021-ls153` (`<tag>-<id>-ls<build>`).
- Current flavours: `debiantrixie` (the `master` branch, Debian 13), `ubunturesolute` (Ubuntu 26.04), `alpine324`, `arch`, `fedora44` and `kali`. `ubuntunoble`, `el9`, `alpine323`, `fedora42` and `fedora43` are deprecated. `dev` is an integration branch (see [selkies-rust.md](selkies-rust.md)) [V].
- This image uses `debiantrixie`, like docker-orcaslicer. The AppImage is built on Ubuntu 24.04 and takes webkit2gtk-4.1 and libsoup-3 from the host, and trixie provides both [V]. Why not the other flavours, and why the digest pin: [decisions.md](decisions.md).
- amd64 only. The base also builds `arm64v8-<tag>`, but Creality publishes no aarch64 AppImage [V].
- Size: the base is about 3.7 GB on disk (934 MB compressed). This image adds about 1 GB, mostly WebKit and the extracted AppImage [V].

## What the base provides

- **Desktop stacks** [V, base Dockerfile]:
  - Wayland: a patched labwc 0.9.7 (an IPC socket and a second-screen socket), Xwayland, `foot`, `wl-clipboard`.
  - X11: a patched XLibre Xvfb (glamor, DRI3, 4 CRTCs), Openbox, `xterm`, `xdotool`, `xclip`.
  - Neither the X server nor the compositor is stock.
- **Selkies** in a Python venv at `/lsiopy`, with pixelflux (capture, encode, and the Wayland compositor) and pcmflux (audio). nginx serves the web client from `/usr/share/selkies/web`.
- **Also installed:** PulseAudio, `dbus-x11`, CUPS (a virtual "Selkies" printer that sends PDFs to the browser), Mesa DRI/VA/Vulkan with the Intel VA drivers, Noto fonts (no variable UI font), `locales-all`, `sudo`, Docker CE for Docker-in-Docker, Node.js 22 and proot-apps.
- **`/config`** is the home of user `abc` and the only volume. Everything outside it is lost when the container is re-created. What the base creates and rewrites there on each boot, and what `PUID`/`PGID` changes do to it: [persistence.md](persistence.md).
- **User `abc`** has passwordless sudo, and the right-click menu offers a terminal. Without `PASSWORD`, anyone who can reach the port has a root-capable desktop. How to lock it down: [files.md](files.md).
- **Input interposers.** Unless `NO_GAMEPAD` / `NO_WEBCAM` is set, init writes a global `LD_PRELOAD` with the gamepad interposer, a fake libudev and the V4L2 webcam interposer. Every desktop process, the app included, inherits it [V source, I for the app]. No problem has been seen from it.
- **Keyboard.** Selkies injects keys by scancode through the compositor seat. `startwm_wayland.sh` hard-codes `XKB_DEFAULT_LAYOUT=us` [V source]. Non-US browser layouts are untested [I].
- **Host CPU.** x86_64 needs AVX2. Proxmox's default VM CPU types hide it (docker-orcaslicer #35, baseimage-selkies #147) [V, issues].
- The base does **not** include WebKitGTK. This image adds `libwebkit2gtk-4.1-0` (see [decisions.md](decisions.md)).

## s6 services and start order

The base adds its own units to LinuxServer's standard s6-overlay v3 chain. This image adds four units and overrides one [V, the image's `/etc/s6-overlay/s6-rc.d`].

| Step | Units | What they do |
|---|---|---|
| 1 | LinuxServer init → `init-os-end` | Migrations, `PUID`/`PGID` (`lsiown` fixes only the top level of `/config`), device permissions |
| 2 | `init-selkies` → `init-nginx` → `init-selkies-config` → `init-video` → `init-selkies-end` | `init-nginx`: on first run, the self-signed cert `/config/ssl/cert.{pem,key}` (10 years). On every boot, the nginx config (ports, `SUBFOLDER`, basic auth) and `mkdir` of `FILE_MANAGER_PATH` (it ignores `SELKIES_FILE_MANAGER_PATH`; Selkies creates its own folder if missing). `init-selkies-config`: the launch contract (next section), hardening flags and interposers; it writes derived variables to `/run/s6/container_environment/`. `init-video`: GPU groups and node selection ([gpu.md](gpu.md)) |
| 3 | `init-config` → **`init-crealityprint-config`**, **`init-crealityprint-idle`** → `init-config-end` | Ours, as root. Config: ownership repair, first-run seeding ([persistence.md](persistence.md)) and the `CP_UI_SCALE` DPI pin ([hidpi.md](hidpi.md)). Idle: installs the presence hooks when `IDLE_QUIT=true` and no app restarter is on ([idle-quit.md](idle-quit.md)). Both depend on `init-config` and are listed in `init-config-end/dependencies.d`, so they finish before any service starts |
| 4 | `init-mods` … `init-custom-files` → `init-services` | Docker mods, `/custom-cont-init.d` |
| 5 | `svc-nginx`, `svc-pulseaudio`, `svc-xorg`, `svc-docker`, `svc-watchdog`, `svc-cron` | `svc-xorg` sleeps in Wayland mode. `svc-docker` sleeps unless the container is privileged. `svc-watchdog` sleeps unless `RESTART_APP=true` |
| 6 | **`svc-dbus`** (overridden), `svc-xsettingsd` | Ours runs `sleep infinity` (see "D-Bus"). `svc-xsettingsd` runs in X11 mode only |
| 7 | `svc-selkies` | Sets up the PulseAudio null sinks once, then runs `selkies` as `abc` on `127.0.0.1:8082`. In Wayland mode this process is also the display server: pixelflux runs a headless compositor on `$XDG_RUNTIME_DIR/wayland-1` |
| 8 | `svc-de` | Waits for `wayland-1`, then runs `/defaults/startwm_wayland.sh` as `abc`, which starts labwc |
| 9 | **`svc-crealityprint-upload-watcher`**, **`svc-crealityprint-idle`** | Ours, both depend on `svc-de`. Each runs `sleep infinity` unless its opt-in is on (`AUTO_OPEN_UPLOADS`, `IDLE_QUIT`); see [files.md](files.md) and [idle-quit.md](idle-quit.md). `svc-de` counts as up once labwc is launched, not once the app is, so both must cope with no app yet |

- **Overriding a base service:** ship only its `run` file. The base's `type` and `dependencies.d` still apply. This is how `svc-dbus` is turned off [V].
- **Setting a variable for every service at runtime:** write it to `/run/s6/container_environment/<VAR>`. Every `with-contenv` service sees it. The base's init does this for derived variables, `init-crealityprint-idle` for the Selkies hooks, and `init-crealityprint-config` for `SELKIES_SCALING_DPI` [V]. s6 rebuilds the dir from the container's environment on every start, also after `docker restart`, so nothing written there carries over [V].

## How the app is launched

**The chain in Wayland mode** [V, process tree and source]:

```
svc-de → startwm_wayland.sh (as abc) → labwc → Xwayland :0
                                              → sh ~/.config/labwc/autostart
                                                → /usr/local/bin/crealityprint   (exports GDK_BACKEND=x11)
                                                  → /opt/crealityprint/AppRun     (exports LC_ALL=C, LD_LIBRARY_PATH)
                                                    → bin/CrealityPrint
```

- labwc nests as a client of pixelflux's `wayland-1`, serves `wayland-0` to apps, and runs Xwayland on `:0`.
- The app's environment: `HOME=/config`, `XDG_RUNTIME_DIR=/config/.XDG`, `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, `GDK_BACKEND=x11`, `LC_ALL=C`, `XDG_CURRENT_DESKTOP=labwc:wlroots`, plus the `SELKIES_*` variables. It runs as `abc` [V].
- **No s6 service owns the app.** If it exits, it stays closed. It can be started again from the right-click desktop menu, which has a terminal (`foot`, or `xterm` in X11 mode) and "Creality Print" [V].
- **The app's output never reaches `docker logs`.** `startwm_wayland.sh` sends labwc's stdout and stderr to `/dev/null`, and the app inherits them [V source]. The app's own log is described in [app.md](app.md).
- The base's labwc config maximizes every window and gives it server-side decorations. `NO_FULL` turns off the maximizing, `NO_DECOR` the decorations [V source].
- Start-up without a GPU, fresh `/config` (research build): web UI up after 1.3 s, app process after 3.0 s, main window after 4.2 s [V].

**The launch contract**, from `init-selkies-config` [V source; per-file results in [persistence.md](persistence.md)]:

| File in the image | Becomes | When |
|---|---|---|
| `/defaults/autostart_wayland` (`/defaults/autostart` in X11 mode) | `/config/.config/labwc/autostart` (or `.../openbox/autostart`) | Copied only if missing, so never updated. Its owner and mode are reset every boot (`abc`, 0644; `root:abc`, 0550 with `RESTART_APP=true`) |
| `/defaults/menu_wayland.xml` (`menu.xml`) | `.../labwc/menu.xml`, plus `menu.xml.bak` | Copied only if missing. On the first boot `menu.xml.bak` is made from it, and on every boot `menu.xml` is restored from `menu.xml.bak` (so `DISABLE_TERMINALS` can be switched off again). The image's menu never reaches an existing volume, and only edits to `menu.xml.bak` survive |
| `/defaults/labwc.xml` | `.../labwc/rc.xml` | Regenerated every boot, then edited for `NO_DECOR`, `NO_FULL` and the hardening flags. Edits are lost |
| — | `/config/.XDG` (`XDG_RUNTIME_DIR`) | Deleted and recreated every boot. It holds `wayland-0`, `wayland-1`, the labwc socket, the interposer sockets and the CUPS socket |
| `/defaults/startwm_wayland.sh`, `startwm.sh` | — | Run directly from `/defaults` every boot (a downstream image could override them to own the whole session) |
| `/usr/share/selkies/www/icon.png` | favicon and PWA icon | Copied every boot. The build puts the Creality Print icon there (`build/fetch-crealityprint.sh`; the smoke test checks it) |

**How this image hooks in:**

- `root/defaults/autostart` and `autostart_wayland` contain one line, `/usr/local/bin/crealityprint`, and both menus start the same path. That path must never change. Every launch-time setting goes into the launcher, which reaches existing volumes with the next image [V].
- The launcher exports `GDK_BACKEND=x11` and `exec`s `AppRun`, so the app is an X11 client of Xwayland, not a native Wayland client. This is copied from docker-orcaslicer and was not A/B-tested here [I] (see [decisions.md](decisions.md)).
- `LC_ALL` has no effect on the app, because `AppRun` forces `LC_ALL=C`. The app's language comes from its own config [V].

**X11 mode** (`PIXELFLUX_WAYLAND=false`): Xvfb on `:1`, then `dbus-launch --exit-with-session openbox-session`, then `~/.config/openbox/autostart`. The app starts and renders there, also with a GPU [V, research build]. But the helper scripts (`crealityprint-open`, the upload watcher, the idle restart) hard-code `DISPLAY=:0`, so they won't reach it [I, from the code]. Wayland mode is the supported mode.

## Displays: `:1` in the environment, `:0` for the app

- The base bakes `DISPLAY=:1` into the image environment. That is Xvfb's display in X11 mode. In Wayland mode nothing listens on `:1` [V].
- The app runs on Xwayland `:0` [V]. Everything outside labwc's process tree sees `:1`: s6 services, `docker exec`, and Selkies with its hook commands.
- So every helper that talks to the app sets `DISPLAY=:0` itself: `crealityprint-open`, `crealityprint-upload-watcher`, and `crealityprint-idle` when it starts the app. With `:1`, `dbus-send --session` fails with "failed to connect to X11 display" [V].

## D-Bus

- **System bus: off.** The base's `svc-dbus` runs `dbus-daemon --system` as `messagebus`. This image replaces its `run` with `sleep infinity`, as docker-orcaslicer does. In docker-orcaslicer the app's `org.freedesktop.hostname1` activation failed with "Permission denied" (docker-orcaslicer #24), and Creality Print shares that code base [I]. Nothing visible breaks without the system bus [V].
- **Session bus: X11 autolaunch on `:0`.** In Wayland mode, `startwm_wayland.sh` starts no session bus (it uses `dbus-run-session` only with `PELORUS=true`) [V source]. The app has no `DBUS_SESSION_BUS_ADDRESS`. GLib/GTK falls back to X11 autolaunch (`dbus-launch --autolaunch`, from `dbus-x11`), which starts a `dbus-daemon --session` and makes its address findable through display `:0` [V].
  - This is enough for the app's single-instance D-Bus interface. The upload watcher uses it ([files.md](files.md)).
  - The bus outlives the app. An app started again (for example by the idle timer) registers on the same bus [V].
  - Autolaunch keeps state in `/config/.dbus` (mode 0700), which is why the ownership repair includes it ([persistence.md](persistence.md)).
- X11 mode gets its session bus from `dbus-launch` in `startwm.sh` [V source].

## Ports, HTTPS and reverse proxies

| Port | Served by | Use |
|---|---|---|
| 3000 (`CUSTOM_PORT`) | nginx, HTTP | Only behind a TLS-terminating reverse proxy |
| **3001** (`CUSTOM_HTTPS_PORT`) | nginx, HTTPS, self-signed cert | What users open. The only port the README publishes |
| 8082 (`CUSTOM_WS_PORT`) | Selkies (WebSocket stream, file API, uploads) | Localhost only, proxied by nginx under `<SUBFOLDER>api` |

- **The cert** `/config/ssl/cert.pem` and `cert.key` is created on the first run and kept. Replace it with your own if you like [V source].
- **Why HTTPS is required.** The client decodes video with WebCodecs (`VideoDecoder`) and uses the async clipboard API. Browsers offer both only in a secure context. Over plain `http://<lan-ip>:3000` the page reports "This application requires a secure connection (HTTPS)" and stays black [V]. `http://localhost:3000` counts as secure, but only in a browser on the same machine [V]. The Gamepad API, microphone and webcam (`getUserMedia`) and pointer lock need a secure context too [V, upstream docs].
- **Reverse proxy** [V, upstream docs; not tested with this image]:
  - Proxy the whole site as one location to port 3000. A proxy that talks to 3001 instead must skip certificate verification.
  - Pass the WebSocket `Upgrade` and `Connection` headers.
  - Set read and send timeouts of about 3600 s.
  - Set `proxy_buffering off`, and `client_max_body_size 0` for uploads.
  - The proxy must still serve HTTPS to the browser.
  - For a path prefix, set `SUBFOLDER=/path/` on the container, with both slashes.
  - `PASSWORD` and `SUBFOLDER` are put into the nginx config with plain `sed`, so unusual characters can break it.
  - In WebRTC mode, media bypasses the proxy over UDP. The default mode is WebSockets.
- **`shm_size: 1gb`** is the base's standard advice (browsers, WebKit and the audio lock use `/dev/shm`). 29-minute sessions with and without a GPU kept `/dev/shm` flat [V].
- **No `seccomp=unconfined` and no `--privileged`.** The app and its WebKit processes run under Docker's default seccomp profile [V]. Whether WebKit's bubblewrap sandbox is active or silently off was not checked [I]. `--privileged` is only for Docker-in-Docker [V].
- Upstream calls Podman and host networking "may work, not supported" [V, upstream docs]. For host networking and printer discovery, see [printers.md](printers.md).

## Environment variables worth knowing

The variables users set are listed in the [user README](../../README.md). The full base list is in linuxserver's Selkies docs. This section covers what matters for understanding the image.

**Set in the image** [V]:

| Variable | Value | From |
|---|---|---|
| `DISPLAY` | `:1` | Base (Xvfb's display; the app is on `:0`, see above) |
| `HOME` | `/config` | Base |
| `PULSE_RUNTIME_PATH` | `/defaults` | Base |
| `START_DOCKER` | `true` | Base (no effect unless privileged) |
| `SELKIES_ENCODER` | `h264enc,h265enc,vp8enc,vp9enc,av1enc,jpeg` | Base (the first item is the default) |
| `SELKIES_ENABLE_BASIC_AUTH` | `false` | Base (nginx does the auth) |
| `TITLE` | `Creality Print` | This image (tab title and PWA name) |
| `SSL_CERT_FILE` | `/etc/ssl/certs/ca-certificates.crt` | This image (points the app's bundled TLS stack at the system CAs, as docker-orcaslicer does) [I for the need] |
| `PIXELFLUX_WAYLAND` | `true` | This image (Wayland mode) |
| `SELKIES_AUDIO_ENABLED` | `false` | This image (see "Selkies' idle cost and the key-loop patch" below) |

**Written at init** to `/run/s6/container_environment/` by `init-selkies-config` [V]: `XDG_RUNTIME_DIR=/config/.XDG`, `LD_PRELOAD` (the interposers), `CUPS_SERVER`, `SELKIES_COMMAND_ENABLED=true` (unless hardened), and `LANG`/`LANGUAGE` derived from `LC_ALL`. GPU variables: [gpu.md](gpu.md).

**Base options that matter here:**

- `CUSTOM_PORT`, `CUSTOM_HTTPS_PORT`, `SUBFOLDER`, `DISABLE_IPV6`: nginx.
- `NO_DECOR`, `NO_FULL`: window decorations and maximizing. `NO_GAMEPAD`, `NO_WEBCAM`: drop the interposers.
- `SELKIES_ENCODER=jpeg`: the fallback when a client's browser can't decode the H.264 stream (baseimage-selkies #174) [V, issue].
- `SELKIES_RUN_AFTER_CONNECT`, `SELKIES_RUN_AFTER_DISCONNECT`: taken by `IDLE_QUIT`. If the user sets either one, `IDLE_QUIT` stays off and logs a warning [V].
- `RESTART_APP`: not used by this image (next section). `HARDEN_OPENBOX=true` turns it on unless it is set explicitly [V source].
- `SELKIES_SCALING_DPI`: pinned to 96 by the image when `CP_UI_SCALE` is 2–4, unless the user sets it ([hidpi.md](hidpi.md)).
- `HARDEN_DESKTOP` and file transfers: [files.md](files.md).
- Value syntax: append `|locked` to fix a setting and hide it in the UI (e.g. `SELKIES_USE_CPU="true|locked"`). Lists are comma-separated, with the first item as the default. Ranges are `min-max`. `FILE__<VAR>` reads a value from a file (Docker secrets) [V, upstream docs].
- Not used here: `SELKIES_DESKTOP` (a panel and start menu), `PELORUS` (an agent API with AT-SPI), `DEV_MODE`.

## `RESTART_APP` (not used)

- With `RESTART_APP=true`, the base's `svc-watchdog` checks with `pgrep -u abc -f "sh $HOME/.config/labwc/autostart"` every second (every 2 s until it first appears) and runs the autostart again when it is gone. It also makes the autostart file `root:abc` 0550 [V source].
- This image doesn't use it. Why: [decisions.md](decisions.md). It would start the app again within a second of an idle close, so `IDLE_QUIT` stays off while it (or `HARDEN_OPENBOX`) is on ([idle-quit.md](idle-quit.md)) [V].

## Selkies presence hooks

Selkies runs a command when the first browser connects and when the last one leaves [V, source of the installed `selkies` package]:

- `SELKIES_RUN_AFTER_CONNECT` runs after the first client connects. It runs again each time a client connects while no others are connected.
- `SELKIES_RUN_AFTER_DISCONNECT` runs after the last client disconnects, also when the server shuts down while clients are connected.
- Both are empty (off) by default. They are defined in `settings.py`.
- `set_clients_present()` in `stream_server.py` is called by both streaming modes (WebSockets and WebRTC). It acts only on a change (0 → 1 or 1 → 0 clients) and starts the command as an asyncio task.
- `_run_client_hook()` runs the command with `asyncio.create_subprocess_shell()`, so through `sh -c`. It waits **at most 300 s**, then kills the command and logs a warning. A non-zero exit status is logged as a warning.
- **The hooks are not serialized.** Each one is its own task, so a quick disconnect and reconnect can run two hook commands at once, and the later event's hook can finish first.
- The command runs as `abc`, in Selkies' process tree and with Selkies' environment, so with `DISPLAY=:1`.
- "Connected" means an open Selkies session. A forgotten browser tab in the background counts [V].

What follows for anything built on them:

- A hook must be quick and must never block.
- A hook must not start the app: it would get the wrong display, live inside Selkies' process tree, and be killed after 300 s.
- A hook must tolerate running out of order.
- Selkies must keep running to deliver the hooks.

How `IDLE_QUIT` uses the hooks: [idle-quit.md](idle-quit.md).

## Selkies' idle cost and the key-loop patch

Measured on this image's base (selkies 2.2.1, pixelflux 2.2.3), Intel UHD 630 host, Wayland mode, no browser connected: 60 s samples of every thread's run time and context switches, attributed with `strace -f` and `py-spy` in throwaway containers [V].

Without the image's patch, the container wakes **about 68 times a second at about 0.87 % of one core**, almost all of it Selkies:

| Source | Wakeups/s | CPU % of a core | Cause | Setting that stops it |
|---|---|---|---|---|
| Selkies `_key_repeat_loop` | ~50 | ~0.65 | `asyncio.sleep(0.02)` loop in `selkies/input_handler.py` | none; **parked by the patch** |
| Selkies `_key_stale_sweep` | ~10 | ~0.15 | `asyncio.sleep(0.1)` loop, same file | none; **parked by the patch** |
| Selkies clipboard monitor | ~0.5 | small | a 2 s wait plus a liveness `connect()` to labwc's `wayland-0` | `SELKIES_ENABLE_CLIPBOARD=false` |
| Selkies gamepad interposers | ~1 | small | four `asyncio.sleep(1)` loops | none (`SELKIES_GAMEPAD_ENABLED=false` doesn't stop them) |
| pixelflux compositor thread | 4 | 0.03 | a 250 ms timer, purpose unknown | none |
| pixelflux `pf-dc-watch` | 2 | 0.007 | a 500 ms clipboard watch on labwc | `SELKIES_ENABLE_CLIPBOARD=false` |
| labwc | 0.5 | ~0 | woken by Selkies' 2 s socket probe | `SELKIES_ENABLE_CLIPBOARD=false` |
| pulseaudio, cupsd, nginx, dbus, s6 | 0 | 0 | — | — |

- The two key loops start with the server, not with a client, and also run in Wayland mode, where key repeat is off. With no key or gamepad held, both loop bodies do nothing [V, source and strace].
- No setting reaches them. Turning off the clipboard, audio, printing or gamepads, or X11 mode, left the container at 64–68 wakeups/s [V]. Upstream won't fix it either: 2.2.1 is the last Python release, and the Rust rewrite keeps the same two always-on timers (see [selkies-rust.md](selkies-rust.md)) [V].
- The app's redraws don't wake Selkies (67.6 wakeups/s with the app paused, 68.3 running), and with no client there is no capture, encoding or other periodic Python work [V].
- With a client connected (audio on), the container woke about 628 times a second at 6.7 % of a core, with pulseaudio alone at about 300/s and 2.1 %. It fell back some 30 s after the client left [V]. The audio share (pulseaudio plus pcmflux) is estimated at about 400 wakeups/s and 3 % of a core, from per-process attribution, not from an on/off comparison [I]. It is the reason for the image's audio-off default.
- `SELKIES_ENABLE_CLIPBOARD=false` saves about 2.5 wakeups/s, at the cost of the session-to-browser clipboard; `in` should keep paste working with the same saving [I]. Not worth a default.
- Selkies' memory grows with the streamed resolution [I]. In the 29-minute sessions at 3200×1800 its RSS peaked at about 371 MB and fell back after the client left (see [gpu.md](gpu.md)); one earlier run showed 2.2 GB right after a session and a slice.
- Package C-state residency was not measured. For scale, the host as a whole made about 48,000 idle-state entries a second at the time [V numbers, I conclusion].

### The patch

`build/patches/selkies-park-idle-key-loops.patch`, applied by `build/patch-selkies.sh` in its own Dockerfile layer (after the AppImage layer, so a patch change doesn't re-download the app). Five hunks in `selkies/input_handler.py` [V, code]:

- `__init__` creates `self.input_wake = asyncio.Event()`.
- A new `_key_loop_tick(interval)` sleeps the interval, then, while nothing is held (pressed keys, gamepad heartbeats, suspended keys, repeat state), clears the event and waits on it. Both loops call it instead of `asyncio.sleep`.
- `on_message`, the entry point for one client message, sets the event in a `finally`, after the message is handled.

Why it is safe [V source, I reasoning]:
- Held state is only ever added while handling a client message, and the event is set after that, so a woken loop sees it. Setting it before would be wrong: a key-down awaits a paste check before it adds the key.
- The parking check and the wait have no `await` between them, so nothing can add held state in between on the single event loop.
- After a wake a loop runs at once instead of up to one interval later; every check in it is time-gated (2 s stale window, 0.3 s heartbeat grace, 0.5 s repeat delay), so running early changes nothing.
- Leftover state keeps the loops running as before: the failure direction is "polls like upstream", never "stops releasing keys". Cancelling a parked loop raises `CancelledError`, which both loops already catch.

**The build fails when the base's file changes** [V]. The script finds the package without importing it, runs `git apply --check` and then `git apply` (exact context, only a line offset allowed, all hunks or none), and byte-compiles the result; anything else stops the build with "no longer applies to selkies X; update the patch". Tested against edited copies: a shifted file applies, a changed line inside a hunk's context fails and leaves the file untouched, and applying twice fails. So on a Renovate base bump either the patch still applies (and the `input` e2e spec confirms it works), or the build fails and nothing is published until the patch is regenerated. A move to the Rust Selkies fails the patch step too (see [selkies-rust.md](selkies-rust.md)). Selkies is MPL-2.0, and the patched file ships as source.

Measured with no client connected, unpatched and patched containers side by side, `CP_PRINTER=Creality K1C`, after settling; wakeups per thread over about 75 s, CPU from the container cgroup read from the host over 60 s windows [V]:

| | Unpatched | Patched |
|---|---|---|
| App running: Selkies main threads | 65.5 wakeups/s, 0.87 % | 5.6 wakeups/s, 0.07 % |
| App running: whole container | 113 wakeups/s, 2.1–2.3 % | 50 wakeups/s, 1.5–1.6 % |
| App closed: whole container | 70.9 wakeups/s, 0.48 % | 8.1 wakeups/s, 0.05 % |

Tests [V]:
- `tests/e2e/input.spec.js` (its own CI job): with no client, Selkies must get down to at most 25 wakeups/s within 2 minutes; a raw key-down for Shift_L with no key-up and no heartbeats must still be released by the parked sweep ("Auto-releasing key 65505 (heartbeat lost)."); after the page leaves, the rate must drop again. The unpatched image fails the first step (66–71/s).
- The clipboard spec, which types Ctrl+V and Ctrl+C, passes on the patched image.
- By hand, in X11 mode, where the repeat loop does key repeat: holding a key after the loops had parked gave the same number of repeats as unpatched (42 vs 44). Gamepads were not tested; their only loop state comes from client messages like keys [I].

## The Rust Selkies (`dev`)

The base's `dev` tag carries the Rust rewrite of Selkies on a redesigned Ubuntu 26.04 base (no nginx, labwc, PulseAudio service or `svc-de`). The image stays on `debiantrixie` for now; the contract changes, what a port takes, the benchmarks and when to move are in [selkies-rust.md](selkies-rust.md).
