# 01 — `linuxserver/docker-baseimage-selkies`

Research date: **2026-11-21**. Research only: nothing in this document was run in a container.

Claim markers:

- **[verified]**: seen in source code or docs at the commit cited.
- **[inferred]**: my reading or extrapolation. Confirm it hands-on before relying on it.

## Sources

| Key | Source | Ref / commit |
| --- | --- | --- |
| BASE | https://github.com/linuxserver/docker-baseimage-selkies, branch `master` (publishes tag `debiantrixie`) | `a7d1dfd0cd98b6992786a4883382f1094d075534`, same commit as release tag `debiantrixie-f7632021-ls153` |
| BASE-DEV | same repository, branch `dev` | `f5df769a0dd0e3078afcf566ac6526736bdd36c2` (2026-11-20) |
| ORCA | https://github.com/linuxserver/docker-orcaslicer, branch `master` | `4b114d95b04b4517e79d01cd6681b843bce10ef2` (2026-11-17) |
| DOCS | https://github.com/linuxserver/docker-documentation, `docs/selkies/**`, rendered at https://docs.linuxserver.io/selkies/ | `3a909e2de81fea470dacd0f1b965f90484f17de7` (2026-11-20) |
| SELKIES | https://github.com/selkies-project/selkies, tag `2.2.1` (the release BASE pins) | `d6b9351421bd503ffa89bdee78e2bce758b1ffe5` |
| Issues | GitHub issues on BASE and ORCA, read with `gh` on 2026-11-21 | — |

The file paths below are relative to the repository root of the cited source. For example, `BASE:root/defaults/startwm.sh` is that file at the BASE commit.

---

## 1. Branches, flavours and tags

There is **no `latest` tag** for the base image, by design. Downstream images pin a distro tag [verified, BASE:README.md].

The image is published as `ghcr.io/linuxserver/baseimage-selkies:<tag>` and on Docker Hub as `lsiobase/selkies:<tag>`. The aarch64 build uses the prefix `arm64v8-<tag>`, as in `ORCA:Dockerfile.aarch64` (`FROM ghcr.io/linuxserver/baseimage-selkies:arm64v8-debiantrixie`). Immutable release tags look like `debiantrixie-f7632021-ls153`, which is `<tag>-<id>-ls<build>` [verified, git tags].

| Branch | Published tag | Distro (FROM of the final stage) | Status (2026-11-21) | Branch HEAD |
| --- | --- | --- | --- | --- |
| `master` | **`debiantrixie`** | `ghcr.io/linuxserver/baseimage-debian:trixie` (Debian 13) | current | `a7d1dfd` |
| `ubunturesolute` | `ubunturesolute` | `baseimage-ubuntu:resolute` (Ubuntu 26.04 [inferred version number]) | current | `5e47586` |
| `alpine324` | `alpine324` | `baseimage-alpine:3.24` | current | `217d9cd` |
| `arch` | `arch` | `baseimage-arch:latest` (rolling) | current | `468ab7b` |
| `fedora44` | `fedora44` | `baseimage-fedora:44` | current | `021c26e` |
| `kali` | `kali` | `baseimage-debian:kali` (Kali rolling) | current | `3a2ae89` |
| `dev` | `dev` | `baseimage-ubuntu:resolute` plus the head Selkies "bundle" | integration testing | `f5df769` |
| `ubuntunoble` | `ubuntunoble` | Ubuntu 24.04 | **deprecated**: the README carries a deprecation notice | `ca3dbb0` |
| `el9` | `el9` | `baseimage-el:9` | **deprecated** | `2683a56` |
| `alpine323`, `fedora42`, `fedora43` | same names | older releases | **deprecated** | — |

Sources: the README "Available Distros" table, `jenkins-vars.yml` `release_tag` on each branch, and the deprecation notices in the README of each old branch [verified]. All current flavours are built for x86_64 and aarch64 [verified, README].

### Which tag does OrcaSlicer use? **`debiantrixie`**

- `ORCA:Dockerfile` line 3: `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie` [verified].
- History of that FROM line in ORCA [verified, `git log -G'^FROM'`]:
  - `311fc2b` (2023-11): `baseimage-kasmvnc:debianbookworm`, the old KasmVNC base.
  - `9e99a25` (2025-09-15): `baseimage-selkies:ubuntunoble`. The changelog says "Rebase to Ubuntu Noble and Selkies, HTTPS is now required".
  - `27bfa00` (2026-04-19): `ubunturesolute`.
  - `f604128` (2026-05-11): **`debiantrixie`**, with the commit message "rebase to debian trixie to fix preferences menu". Why they moved, from ORCA issue #36: the upstream OrcaSlicer **AppImage segfaulted in `libpangoft2`** because the libpango in resolute (1.57) was too new for the AppImage built against Ubuntu 24.04 (pango 1.52). The maintainer rebased to Trixie rather than build from source. **This matters for Creality Print, which also ships an AppImage.**

---

## 2. Dockerfile build stages (`BASE:Dockerfile`, master)

Pinned versions: `ARG SELKIES_RELEASE=2.2.1`, `PIXELFLUX_RELEASE=2.2.3`, `PCMFLUX_RELEASE=2.2.1`. All current branches pin the same three [verified].

| Stage | Base | What it builds |
| --- | --- | --- |
| `frontend` | `baseimage-alpine:3.24` | `git clone selkies-project/selkies`, checks out `2.2.1`, applies `patches/*.patch` (`ios-keyboard.patch`, `keyboard-drag.patch`), then `npm run build` for `addons/selkies-web-core` and `addons/selkies-dashboard`. The output goes to `/buildout/selkies-dashboard`, which is later copied to `/usr/share/selkies/selkies-dashboard` [verified]. |
| `interposers` | `baseimage-debian:trixie` | Compiles from the Selkies addons: `/usr/lib/selkies_input_interposer.so` (plus a 32-bit build and legacy `selkies_joystick_interposer*.so` symlinks), `/usr/lib/selkies_v4l2_interposer.so` (webcam, plus 32-bit), and `/opt/lib/libudev.so.1.0.0-fake` (plus `_32`). The 32-bit builds exist on x86_64 only [verified]. |
| final | `baseimage-debian:trixie` | Runtime, see below. |

What the final stage installs [verified]:

- **Packages, from apt.** X11 stack (`xvfb`, `xserver-xorg-core` plus video drivers, `openbox`, `xterm`, `stterm`, `xdotool`, `xclip`, `xsel`, `xsettingsd`). Wayland stack (`labwc`, `xwayland`, `foot`, `wl-clipboard`, `wlr-randr`). GPU userspace (Mesa DRI/VA/Vulkan, Intel `intel-media-va-driver-non-free` and `i965-va-driver-shaders` on x86_64 only, `libnvidia-egl-wayland1`, `libnvidia-egl-gbm1`). `nginx` plus `libnginx-mod-http-fancyindex`. `pulseaudio`. `dbus-x11`. `cups-daemon` and `cups-filters`. `dunst` and `libnotify-bin`. Fonts (`fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji`). `locales-all`. `sudo`. Docker CE (`docker-ce`, CLI, buildx and compose plugins, `containerd.io`, `fuse-overlayfs`). Node.js 22. Python 3 (`python3-gi`, `python3-venv`).
- **Selkies.** A Python venv at **`/lsiopy`**, created with `--system-site-packages`. It gets the `pixelflux-2.2.3` and `pcmflux-2.2.1` cp313 manylinux wheels and the `selkies-2.2.1` wheel, all from GitHub releases. **Pelorus**, the agent and accessibility API, is also installed with pip.
- **Prebuilt binaries copied from `ghcr.io/linuxserver/selkies-layers:<arch>-debiantrixie-{xvfb,wtype,labwc}`:**
  - A **patched XLibre Xvfb** (`xlibre-xserver-25.2.2`) with glamor and DRI3. It has four LinuxServer patches: GPU-resident pixmap plus RandR resize, 4 CRTCs for multi-monitor, timeline syncobj presents, and a fake vblank at the capture rate.
  - A **patched labwc 0.9.7**, with an IPC socket and a second-screen control socket.
  - waylandtyper, a fork of `wtype`.

  Source: [verified, DOCS:developer-guide/baseimage-internals.md]. So **neither the X server nor the compositor is stock**.
- **Other downloads at build time:** proot-apps to `/proot-apps/`, `selkies-desktop` to `/usr/bin/selkies-desktop`, the `dind` script, the Selkies icon and favicon to `/usr/share/selkies/www/`, and an Openbox theme.
- **Tweaks made at build time:**
  - `/etc/xdg/openbox/rc.xml`: every app maximized (`<application class="*"><maximized>yes</maximized>`), `C-S-d` bound to ToggleDecorations, and the desktop count set to 1.
  - `openbox-session` gets `--replace`.
  - `abc` gets **passwordless sudo**, the password `abc`, the shell bash, and membership of the `docker` group.
- **Baked `ENV`** [verified]: `DISPLAY=:1`, `HOME=/config`, `PERL5LIB=/usr/local/bin`, `START_DOCKER=true`, `PULSE_RUNTIME_PATH=/defaults`, `SELKIES_INTERPOSER=/usr/lib/selkies_input_interposer.so`, `SELKIES_WEBCAM_INTERPOSER=/usr/lib/selkies_v4l2_interposer.so`, `NVIDIA_DRIVER_CAPABILITIES=all`, `DISABLE_DRI3=false`, `SELKIES_ENCODER="h264enc,h265enc,vp8enc,vp9enc,av1enc,jpeg"`, `SELKIES_ENABLE_BASIC_AUTH=false`, `SELKIES_VIDEO_STREAMING_MODE=false`, `SELKIES_ALLOWED_ORIGINS="*"`, `SELKIES_RATE_CONTROL_MODE="crf,cbr"`, `SHELL=/bin/bash`, `__GL_SYNC_TO_VBLANK=0` (x86_64 only), `TITLE=Selkies`.
- `EXPOSE 3000 3001` and `VOLUME /config`.

The aarch64 Dockerfile is identical except for: no 32-bit interposers, no Intel VA drivers or `xserver-xorg-video-intel`, no `gir1.2-gtk-3.0`, no Steam icon, and no `__GL_SYNC_TO_VBLANK` [verified, diff of `Dockerfile` vs `Dockerfile.aarch64`].

> **Heads-up, the `dev` branch is a redesign** [verified, BASE-DEV]. It installs a prebuilt Selkies "bundle" into `/opt/selkies` and drops the separate `svc-nginx`, `svc-pulseaudio`, `svc-xorg`, `svc-de` and `svc-dbus` services. Instead `selkies session --session="bash /defaults/startwm.sh" --wayland-session="bash /defaults/startwm_wayland.sh" --port=3000 --https-port=3001 ...` serves HTTP(S) itself and runs the session. It also adds `EXIT_ON_APP_CLOSE` through `svc-app-exit`, which answers open issue #198. If this lands on `debiantrixie`, the downstream contract may shift. The `/defaults/autostart*` files are still present there.

---

## 3. s6-overlay service tree

The base inherits the standard LSIO s6 v3 chain from `baseimage-debian`: migrations, adduser (PUID/PGID), device perms, mods, custom files, `/custom-cont-init.d`, `/custom-services.d`. The Selkies image adds its own units under `BASE:root/etc/s6-overlay/s6-rc.d/` [verified].

### Oneshots (init chain)

```
init-os-end
 └─ init-selkies            (marker, empty)
     └─ init-nginx
         └─ init-selkies-config
             └─ init-video
                 └─ init-selkies-end (marker) → init-config → … → init-services
```

| Unit | What it does [verified, `run` scripts] |
| --- | --- |
| `init-nginx` | On the first run only, creates the self-signed cert `/config/ssl/cert.pem` and `cert.key` (10 years, `CN=*`). On every boot, copies `/defaults/default.conf` to `/etc/nginx/sites-available/default` and `sed`-substitutes `CUSTOM_PORT`, `CUSTOM_HTTPS_PORT`, `CUSTOM_WS_PORT` and `SUBFOLDER`. If `PASSWORD` is set, writes `/etc/nginx/.htpasswd` for `CUSTOM_USER` (default `abc`) and uncomments `auth_basic`. If `DISABLE_IPV6` is set, deletes the `listen [::]` lines. Runs `mkdir -p $FILE_MANAGER_PATH` (default `$HOME/Desktop`) as `abc`. Copies `/usr/share/selkies/$DASHBOARD` to `/usr/share/selkies/web` and copies `www/icon.png` over `favicon.ico` and `icon.png`. Writes a PWA `manifest.json` that uses `TITLE`. |
| `init-selkies-config` | The main one. See §4, §5 and the GPU/gamepad notes. In short: chooses the Wayland or X11 config dir, copies `autostart` and `menu.xml` on the first run only, recreates `$HOME/.XDG` as `XDG_RUNTIME_DIR`, clears PulseAudio locks, maps `LC_ALL` to `LANG`/`LANGUAGE`, applies the hardening vars, regenerates `rc.xml`, syncs proot-apps, sets up the Steam shim, picks `DRI_NODE`/`DRINODE`, creates the gamepad device nodes plus `LD_PRELOAD`, creates the webcam node plus `LD_PRELOAD`, sets `CUSTOM_WS_PORT=8082`, applies the WebRTC auto-enable, and adapts legacy env vars. It writes all derived env vars into **`/run/s6/container_environment/<VAR>`**, so every `with-contenv` service sees them. |
| `init-video` | For every char device under `/dev/dri` and `/dev/dvb`, adds `abc` to a group that matches the device GID, creating the group if needed, and runs `chmod g+rw`. Sets `AUTO_GPU=true` on x86_64 when a render node exists and nothing is pinned. Detects whether an older Intel GPU needs `LIBVA_DRIVER_NAME=i965`. On Nvidia, writes any missing OpenCL ICD, Vulkan ICD, EGL vendor JSON and GBM symlink, and may set `__GLX_VENDOR_LIBRARY_NAME=nvidia`. |

### Longruns

Every longrun depends on `init-services`. The extra edges come from `dependencies.d/` [verified].

| Service | Extra deps | What it runs |
| --- | --- | --- |
| `svc-nginx` | — | Kills zombie nginx workers, then `exec nginx -g 'daemon off;'`. |
| `svc-pulseaudio` | — | `pulseaudio --exit-idle-time=-1` as `abc`. The runtime dir is `/defaults` (`PULSE_RUNTIME_PATH`), so the pid file is `/defaults/pid` and the socket is `/defaults/native`. |
| `svc-xorg` | — | Wayland mode: `sleep infinity`. X11 mode: `Xvfb :1 -dpi 96 +extension COMPOSITE DAMAGE GLX RANDR RENDER MIT-SHM XFIXES XTEST +iglx +render -nolisten tcp -ac -shmem`, plus `-glamor -dri <node>` when a render node exists and `DISABLE_DRI3=false`. Runs as `abc`. |
| `svc-dbus` | `svc-xorg` | **System** bus: `dbus-daemon --system --nofork` as `messagebus`. |
| `svc-xsettingsd` | `svc-nginx`, `svc-xorg` | X11 only, and skipped when xfce4-session exists: `xsettingsd`. Writes `~/.xsettingsd` with `Xft/DPI 98304` if the file is missing. |
| `svc-selkies` | `svc-nginx`, `svc-pulseaudio`, `svc-xorg` | Waits for `/defaults/pid`, then loads two PulseAudio null sinks (`output` and `input`) once, guarded by `/dev/shm/audio.lock`. Then `exec selkies --addr=localhost` as `abc`. Selkies listens on `127.0.0.1:8082`. **In Wayland mode this process *is* the display server**: pixelflux starts a headless Smithay compositor on `$XDG_RUNTIME_DIR/wayland-1` [verified, DOCS:developer-guide/architecture.md]. Also handles `DEV_MODE`. |
| `svc-de` | `svc-nginx`, `svc-selkies`, `svc-xorg`, `legacy-cont-init` | Wayland: waits for `${XDG_RUNTIME_DIR}/wayland-1`, then runs `/defaults/startwm_wayland.sh` as `abc`. X11: waits for `xset q`, sets the initial mode to `SELKIES_MANUAL_WIDTH`x`HEIGHT` (default 1024x768) through `cvt`/`xrandr`, runs `xrdb ~/.Xresources` (breeze cursor), then runs `/defaults/startwm.sh` as `abc`. The PID goes into `/de-pid`. The `finish` script sends TERM to the whole session process tree with a 5 s grace period. |
| `svc-watchdog` | — | Does nothing unless `RESTART_APP=true`. When it is set, it polls `pgrep -u abc -f "sh $HOME/.config/{labwc,openbox}/autostart"` and relaunches the autostart if it is gone. |
| `svc-docker` | — | If the container is privileged (it checks for `/dev/cpu_dma_latency`) and `START_DOCKER=true`, mounts a tmpfs on `/tmp` and runs dockerd. Otherwise sleeps. |

**Effective start order:**

1. nginx, pulseaudio, docker, watchdog, and xorg (Xvfb in X11 mode).
2. dbus and xsettingsd.
3. selkies (and so the Wayland compositor).
4. de: labwc or openbox, which then runs the autostart, which starts the app.

### Window manager and session

- **Wayland mode** (`PIXELFLUX_WAYLAND=true`, which OrcaSlicer sets) [verified, `BASE:root/defaults/startwm_wayland.sh`]:
  - Exports `XCURSOR_THEME=breeze_cursors`, `XCURSOR_SIZE=24`, `XKB_DEFAULT_LAYOUT=us`, `XKB_DEFAULT_RULES=evdev` and `WAYLAND_DISPLAY=wayland-1`, then runs `labwc`.
  - labwc nests as a client of pixelflux's `wayland-1`, serves `wayland-0` to apps, and runs **XWayland on `:0`**.
  - labwc itself executes `~/.config/labwc/autostart` with `sh`.
  - Variants: with `SELKIES_DESKTOP=true` it runs the `selkies-desktop` panel/shell. With `PELORUS=true` it runs `dbus-run-session` plus `at-spi2-registryd` plus `pelorus`.
- **X11 mode** (`PIXELFLUX_WAYLAND` unset or false) [verified, `BASE:root/defaults/startwm.sh`]: `dbus-launch --exit-with-session openbox-session`. Openbox runs `~/.config/openbox/autostart`. Here `DISPLAY` is `:1`.
- **Session D-Bus:** X11 mode gets one from `dbus-launch`. Wayland mode **starts no session bus** unless `PELORUS=true` [verified, from reading `startwm_wayland.sh`]. Whether GTK apps then fall back to D-Bus X11 autolaunch through XWayland (`dbus-x11` is installed) is **[inferred, untested]**.
- **Overriding a base service downstream:** ORCA ships `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` containing only `sleep infinity`, which **disables the system D-Bus**. Because only the `run` file is replaced, the base's `type` and `dependencies.d` still apply [verified]. The file was added in commit `66c8320` (2025-11-25), right after ORCA issue #24: "`org.freedesktop.hostname1` failed … Permission denied". The link between the two is [inferred].

---

## 4. How an app is launched, and how a downstream image overrides it

### The downstream contract [verified, DOCS:developer-guide/building-images.md, components/baseimages.md]

| File in image | Role | Persistence semantics |
| --- | --- | --- |
| `/defaults/autostart_wayland` | Shell script run by labwc (as `abc`) in Wayland mode | **Copied to `/config/.config/labwc/autostart` only if that file is missing.** Never overwritten after that. |
| `/defaults/autostart` | Same for Openbox, X11 mode | Copied to `/config/.config/openbox/autostart` if missing |
| `/defaults/menu_wayland.xml` / `/defaults/menu.xml` | Right-click root menu (Openbox menu XML, which labwc also reads) | Copied to `.../labwc/menu.xml` or `.../openbox/menu.xml` if missing. A `menu.xml.bak` is also made on the first run, so `DISABLE_TERMINALS` can be toggled on and off. |
| `/defaults/labwc.xml` | labwc `rc.xml` template | **Regenerated into `/config/.config/labwc/rc.xml` on every boot**, then the hardening/`NO_DECOR`/`NO_FULL` edits are applied. User edits to `rc.xml` are lost. |
| `/etc/xdg/openbox/rc.xml` | Openbox config | Restored from `rc.xml.bak` on every boot, then edited the same way |
| `/defaults/startwm_wayland.sh` / `/defaults/startwm.sh` | The whole session. Override these to own everything (this is what Webtop KDE does). | Not copied. Runs straight from `/defaults` every boot. |
| `/usr/share/selkies/www/icon.png` | Favicon, PWA icon, selkies-desktop mark | Copied into `/usr/share/selkies/web/` on every boot by `init-nginx` |
| `ENV TITLE=...` | Browser tab and PWA name | — |

Source of the semantics: `BASE:root/etc/s6-overlay/s6-rc.d/init-selkies-config/run` lines 114-147 and 282-331 [verified].

**Gotcha:** because autostart and menu are copied only when missing, a new image whose autostart command changes **will not** update existing users' `/config`. When testing, use a fresh `/config`. A wrapper script in the image, such as `/usr/bin/creality-print-launcher`, keeps the autostart line stable while you change the image [inferred best practice, matching the docker-chromium `wrapped-chromium` pattern in DOCS:building-images.md].

### What OrcaSlicer does (complete overlay) [verified, ORCA:root/]

```
root/defaults/autostart            -> /opt/orcaslicer/AppRun
root/defaults/autostart_wayland    -> /opt/orcaslicer/AppRun
root/defaults/menu.xml             -> xterm, FireFox, OrcaSlicer
root/defaults/menu_wayland.xml     -> foot,  FireFox, OrcaSlicer
root/etc/s6-overlay/s6-rc.d/svc-dbus/run -> "sleep infinity"
```

From the Dockerfile:

- `ENV TITLE=OrcaSlicer SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PIXELFLUX_WAYLAND=true`.
- It downloads the icon to `/usr/share/selkies/www/icon.png`.
- It installs Firefox from the Mozilla apt repo (pinned), GStreamer plugins, `libwebkit2gtk-4.1-0`, `libmspack0` and `libwx-perl`.
- It picks the `Ubuntu2404_V*` AppImage, **extracts it** with `--appimage-extract` into `/opt/orcaslicer` (no FUSE), and runs `localedef -i en_GB -f UTF-8 en_GB.UTF-8`.
- It adds `sed -i "1a export GDK_BACKEND=x11" /opt/orcaslicer/AppRun`. Changelog of 18.10.26: "Force OrcaSlicer to use the X11 GDK backend to fix UI rendering issues under Wayland". So the slicer runs on XWayland inside labwc.
- `find /opt/orcaslicer -type d -exec chmod 755 {} +` fixes the `700` directories in the new AppImage format (ORCA issue #45).
- `EXPOSE 3001` only, plus `VOLUME /config`.

The right-click menu gives a terminal and a relaunch entry, so a closed or crashed app can be restarted from the desktop. The maintainer points users to this in ORCA issues #31 and #36.

---

## 5. Environment variables

The authoritative list is DOCS:user-guide/configuration.md (https://docs.linuxserver.io/selkies/user-guide/configuration/), plus the upstream generated list at https://docs.selkies.io/settings. Behaviour marked [verified] below was also checked in the init scripts.

### Standard LSIO (inherited)

| Var | Default | Notes |
| --- | --- | --- |
| `PUID` / `PGID` | 911 | Remaps `abc`, so `/config` ownership matches the host user |
| `TZ` | `Etc/UTC` | |
| `UMASK` | — | inherited |
| `DOCKER_MODS` | — | Runtime mods, `\|`-separated |
| `FILE__<VAR>` | — | Docker-secret style: read the value of `<VAR>` from a file (inherited LSIO feature) |

### Baseimage / container level

| Var | Default | Effect |
| --- | --- | --- |
| `PIXELFLUX_WAYLAND` (alias `SELKIES_WAYLAND`) | unset, so X11 | `true` selects pixelflux compositor plus labwc. Otherwise Xvfb plus Openbox. Downstream images bake their choice (ORCA: `true`). |
| `SELKIES_DESKTOP` | — | `true` in Wayland mode adds the `selkies-desktop` panel, start menu and icons |
| `PELORUS` | — | `true` starts the Pelorus agent API (port 5100, proxied at `/pelorus/`) plus AT-SPI. It sets `PIXELFLUX_CU=5000`, a random `PIXELFLUX_CU_TOKEN` and `ROOT_PATH=/pelorus` |
| `CUSTOM_PORT` | 3000 | nginx HTTP port |
| `CUSTOM_HTTPS_PORT` | 3001 | nginx HTTPS port |
| `CUSTOM_WS_PORT` | 8082 | Internal Selkies port behind nginx |
| `CUSTOM_USER` | `abc` | Basic-auth username, only used if `PASSWORD` is set |
| `PASSWORD` | unset, so **no auth** | Turns on nginx basic auth |
| `SUBFOLDER` | `/` | Path prefix, which needs both slashes, for example `/creality/`. nginx and Selkies both read it. |
| `TITLE` | `Selkies` | Tab title and PWA name |
| `DASHBOARD` | `selkies-dashboard` | Chooses the web UI (`selkies-dashboard-wish` is the alternative) |
| `FILE_MANAGER_PATH` (alias `SELKIES_FILE_MANAGER_PATH`) | `$HOME/Desktop`, which is `/config/Desktop` | Upload target and download browser root. Created at init [verified]. |
| `LC_ALL` | — | For example `de_DE.UTF-8`. Init derives `LANG` and `LANGUAGE` from it [verified]. All locales are prebuilt (`locales-all`). |
| `NO_DECOR` | — | Any value: no window decorations. `ctrl+shift+d` toggles them at runtime. |
| `NO_FULL` | — | Any value: do not auto-maximize windows |
| `NO_GAMEPAD` | — | No js/event nodes and no interposer `LD_PRELOAD`. Locks the gamepad UI off. |
| `NO_WEBCAM` | — | No `/dev/video0` and no V4L2 interposer |
| `NO_STEAM` | — | Removes the built-in Steam installer shim |
| `DRINODE` (alias `SELKIES_RENDER_DRI`) | auto | Render GPU (EGL/3D, or Xvfb glamor) |
| `DRI_NODE` (alias `SELKIES_ENCODE_DRI`) | auto | Encode GPU (VA-API/NVENC) |
| `AUTO_GPU` | `true` when a render node exists (x86_64) | `false`, or a vendor or driver name |
| `DISABLE_DRI3` | `false` | X11 only: Xvfb without the GPU |
| `DISABLE_IPV6` | — | Removes the IPv6 listens |
| `START_DOCKER` | `true` | DinD when privileged |
| `CUPS_SERVER` | `$HOME/.XDG/selkies-cups/cups.sock` | The session's virtual "Selkies" printer, which sends a PDF to the browser |
| `PAPERSIZE` | `A4` | |
| `WATERMARK_PNG`, `WATERMARK_LOCATION` | — | Overlay watermark (location 1-6) |
| `RESTART_APP` | — | Watchdog relaunches the autostart. Makes the autostart file root-owned and `550`. |
| `HARDEN_DESKTOP` | — | Turns on `DISABLE_OPEN_TOOLS`, `DISABLE_SUDO` and `DISABLE_TERMINALS`. Also disables file transfers, the command channel and printing, and hides the files and apps sidebar sections, unless you set those explicitly. |
| `HARDEN_OPENBOX` | — | Turns on `DISABLE_CLOSE_BUTTON`, `DISABLE_MOUSE_BUTTONS` and `HARDEN_KEYBINDS`, and sets `RESTART_APP=true` |
| `DISABLE_OPEN_TOOLS`, `DISABLE_SUDO`, `DISABLE_TERMINALS`, `DISABLE_CLOSE_BUTTON`, `DISABLE_WINDOW_BUTTONS`, `DISABLE_MOUSE_BUTTONS`, `HARDEN_KEYBINDS` | — | Individual lockdowns. They `chmod 0000` binaries and rewrite `rc.xml` and `menu.xml` [verified]. |
| `DEV_MODE` | — | Selkies developer hot reload |
| `PA_REPO_FOLDER` (alias `SELKIES_APPS_REPO_FOLDER`) | — | Local proot-apps catalogue |

### `SELKIES_*` application settings (highlights; the full table is in DOCS)

- **Value syntax:**
  - Append `|locked` to hide or lock the setting in the UI, for example `SELKIES_ENCODER="jpeg"` or `SELKIES_USE_CPU="true|locked"`.
  - Lists are comma-separated and the first item is the default.
  - Ranges are `min-max`, `value`, or `value,min-max`.
  - Every setting is also a CLI flag (`--video-crf`).
- **Container defaults that differ from upstream:** `SELKIES_ENCODER` (no striped H.264), `SELKIES_VIDEO_STREAMING_MODE=false`, `SELKIES_RATE_CONTROL_MODE=crf,cbr`, `SELKIES_ENABLE_BASIC_AUTH=false` (nginx does auth), `SELKIES_ALLOWED_ORIGINS=*`, `SELKIES_COMMAND_ENABLED=true`, `SELKIES_ENABLE_DUAL_MODE=false`, `SELKIES_WEBCAM_ENABLED=true`, `CUSTOM_WS_PORT=8082`.
- **Groups**, by variable family:

  | Group | Variables |
  | --- | --- |
  | Transport | `SELKIES_MODE` (`websockets`, or `webrtc`, chosen automatically when any `SELKIES_TURN_*`, `SELKIES_STUN_*` or `SELKIES_WEBRTC_PUBLIC_IP` var is set) |
  | Video | `SELKIES_FRAMERATE` (8-240, initial 60), `SELKIES_VIDEO_CRF`, `SELKIES_VIDEO_BITRATE`, `SELKIES_VIDEO_FULLCOLOR`, `SELKIES_VIDEO_10BIT`, `SELKIES_USE_CPU`, `SELKIES_JPEG_QUALITY`, paint-over settings |
  | Audio | `SELKIES_AUDIO_BITRATE`, `SELKIES_AUDIO_CHANNELS`, `SELKIES_AUDIO_DEVICE_NAME=output.monitor` |
  | Display | `SELKIES_MANUAL_RESOLUTION`, `SELKIES_MANUAL_WIDTH`/`HEIGHT`, `SELKIES_ENABLE_RESIZE`, `SELKIES_SCALING_DPI` (96-288), `SELKIES_USE_CSS_SCALING`, `SELKIES_SECOND_SCREEN`, cursor options, `SELKIES_MAC_CMD_AS_CTRL`, `SELKIES_KEYBOARD_SHORTCUTS` |
  | Features | `SELKIES_AUDIO_ENABLED`, `SELKIES_MICROPHONE_ENABLED`, `SELKIES_GAMEPAD_ENABLED`, `*_ON_START` |
  | Clipboard and files | `SELKIES_ENABLE_CLIPBOARD` (`true`/`in`/`out`/`false`), `SELKIES_ENABLE_BINARY_CLIPBOARD`, `SELKIES_CLIPBOARD_SEAMLESS`, `SELKIES_FILE_TRANSFERS` (`upload,download`; empty disables), `SELKIES_FILE_TRANSFER_LIMIT_MBPS` |
  | Printing and audit | `SELKIES_PRINTING_ENABLED`, `SELKIES_PRINT_SPOOL_PATH`, `SELKIES_AUDIT_WEBHOOK_*` |
  | Sharing | `SELKIES_ENABLE_SHARING`, `SELKIES_ENABLE_SHARED`, `SELKIES_ENABLE_PLAYER2-4`, `SELKIES_MASTER_TOKEN`, `SELKIES_TOKENS_FILE` |
  | UI visibility | `SELKIES_UI_TITLE`, `SELKIES_UI_SHOW_SIDEBAR`, `SELKIES_UI_SIDEBAR_SHOW_*` (video, screen, audio, stats, shortcuts, clipboard, files, apps, sharing, gamepads, webcam, fullscreen, gaming mode, trackpad, keyboard button, soft buttons) |
  | Server | `SELKIES_FRAME_ANCESTORS` (CSP), `SELKIES_ENABLE_METRICS_HTTP` |
  | Lifecycle | `SELKIES_RUN_AFTER_CONNECT`/`DISCONNECT`, `SELKIES_APP_WAIT_READY` with `SELKIES_APP_READY_FILE=/tmp/selkies-appready` |
  | WebRTC/TURN | `SELKIES_WEBRTC_*`, `SELKIES_STUN_*`, `SELKIES_TURN_*`, Cloudflare TURN |

- **Legacy names are still mapped at init** [verified]: `SELKIES_H264_CRF`, `SELKIES_H264_FULLCOLOR`, `SELKIES_H264_STREAMING_MODE`, `SELKIES_H264_PAINTOVER_*`, `SELKIES_IS_MANUAL_RESOLUTION_MODE`, `SELKIES_CLIPBOARD_ENABLED`, and the `x264enc` encoder name.

Tip for downstream init scripts [verified pattern]: to set an env var for all services at runtime, write it to `/run/s6/container_environment/<VAR>`. This is what `init-selkies-config` does.

---

## 6. Ports, HTTPS, reverse proxy, `shm_size`, seccomp

| Port | Owner | Exposure |
| --- | --- | --- |
| 3000 | nginx, HTTP | Only for use behind a TLS-terminating reverse proxy |
| **3001** | nginx, HTTPS, self-signed `/config/ssl/cert.pem` | **What users browse to** |
| 8082 | Selkies server (`/api`: WebSocket, WebRTC signalling, file browser and uploads, print docs, operator API) | localhost only, through nginx `SUBFOLDERapi` |
| 5100 | Pelorus | localhost, through `/pelorus/` |
| 5000 | pixelflux Computer Use API | localhost |
| 5173 | Vite dev server (`DEV_MODE`) | localhost, through `/devmode` |

Sources: `BASE:root/defaults/default.conf` and DOCS:baseimage-internals.md [verified].

- **Why HTTPS is required:**
  - The client decodes video and audio with **WebCodecs**, which browsers expose only in a secure context (HTTPS or `localhost`) [verified, DOCS:security.md and quickstart.md].
  - The async **clipboard** API also needs a secure context: `selkies-web-core/lib/clipboard-sync.js` checks `window.isSecureContext` [verified, SELKIES].
  - So do the **Gamepad API**, `getUserMedia` for mic and webcam, and pointer lock [verified, SELKIES:docs/faq.md, docs/native.md].
  - Browsing plain `http://host:3000` directly gives "a broken client" [verified, DOCS:installation.md].
- **Reverse proxy** [verified, DOCS:reverse-proxy.md]:
  - Proxy the **whole** container to port 3000 as one location.
  - Pass the WebSocket `Upgrade`/`Connection` headers.
  - Set read and send timeouts to about 3600 s.
  - `proxy_buffering off`.
  - `client_max_body_size 0` for uploads.
  - The proxy must still serve HTTPS to the user.
  - For a subfolder, set `SUBFOLDER=/path/` on the container.
  - A strict proxy that talks to 3001 must skip certificate verification (ORCA README "Strict reverse proxies").
  - Because `PASSWORD`/`SUBFOLDER` substitution is plain `sed`, exotic characters break the nginx config.
  - WebRTC media bypasses the proxy over UDP.
- **`shm_size: 1gb`** is the documented "set on everything" flag. Without it browsers and Electron or CEF apps crash, and the audio machinery also uses `/dev/shm` (the `audio.lock`) [verified, DOCS:installation.md; ORCA `readme-vars.yml` sets `shm_size: 1gb`].
- **`security_opt: seccomp=unconfined`** is only a last resort for old kernels or old libseccomp. The maintainers tell users to remove it (ORCA issue #35) [verified, DOCS:troubleshooting.md, security.md].
- **`--privileged`** is not needed, except to run Docker-in-Docker [verified].
- **Unsupported environments:** docker-ce is supported. Podman and host networking are "may work, not supported" [verified, DOCS:installation.md, AGENTS.md].

---

## 7. `/config` layout (the home directory of `abc`, `HOME=/config`)

Everything outside `/config` is lost when the image is updated [verified, README].

| Path | Created by | Lifetime |
| --- | --- | --- |
| `/config/ssl/cert.pem`, `cert.key` | `init-nginx` | First run. Persists, so you can replace it with your own cert. |
| `/config/.config/labwc/{autostart,menu.xml,menu.xml.bak,rc.xml}` | `init-selkies-config` | autostart and menu: first run only. `rc.xml`: regenerated every boot. |
| `/config/.config/openbox/{autostart,menu.xml,rc.xml}` | same (X11 mode) | same |
| `/config/.XDG/` | `init-selkies-config` | **Deleted and recreated every boot.** It is `XDG_RUNTIME_DIR` and holds `wayland-0`/`wayland-1`, `labwc.sock`, the gamepad and webcam interposer sockets, and `selkies-cups/cups.sock`. |
| `/config/Desktop/` | `init-nginx` (`FILE_MANAGER_PATH`) | Upload and download directory |
| `/config/.local/bin/{proot-apps,proot,bwrap→proot,...}`, `/config/.bashrc` | `init-selkies-config` | Synced when the proot-apps version changes |
| `/config/.local/state/selkies/print/` | Selkies | Print spool, as PDFs |
| `/config/.Xresources`, `/config/.xsettingsd` | `svc-de` / `svc-xsettingsd` (X11) | Created if missing |
| `/config/.config/<App>/...` | The app itself | For example ORCA: `/config/.config/OrcaSlicer/OrcaSlicer.conf` (ORCA issue #38) |

[verified from the init scripts, except the app config path, which comes from the ORCA issue]

**[inferred]** Unix sockets live under `/config/.XDG`, so putting `/config` on NFS or SMB is likely to break the session. LSIO lists NFS/SMB `/config` as an unsupported environment (BASE:AGENTS.md).

---

## 8. Client features

| Feature | Facts |
| --- | --- |
| **Clipboard** | Bidirectional and seamless by default. Text, rich text and images (binary clipboard). There is also a sidebar clipboard box with an "Upload Image" button. Policy is set by `SELKIES_ENABLE_CLIPBOARD=true\|in\|out\|false`, `SELKIES_ENABLE_BINARY_CLIPBOARD` and `SELKIES_CLIPBOARD_SEAMLESS`. Requires HTTPS. In the image, `wl-clipboard`, `xclip` and `xsel` are installed. [verified, DOCS:web-client.md, Dockerfile] |
| **Audio** | PulseAudio null sinks `output` (apps play into it; pcmflux captures `output.monitor` and encodes Opus) and `input` (browser mic, then a virtual source). `SELKIES_AUDIO_*`. Mic off by default (`SELKIES_MICROPHONE_ENABLED=false`). [verified] |
| **Gamepad** | Up to 4 pads. The `LD_PRELOAD` interposer plus fake udev present `/dev/input/js0-3` and `event1000-1003` as Xbox 360 pads, through sockets in `$XDG_RUNTIME_DIR`. `NO_GAMEPAD` turns this off. **Note:** the interposer is preloaded into *every* process through the global `LD_PRELOAD` [verified, `init-selkies-config`]. |
| **Webcam** | A virtual `/dev/video0` plus a V4L2 interposer, also preloaded globally. `NO_WEBCAM` turns it off. |
| **Keyboard / IME** | On Wayland, keys are injected through the pixelflux compositor seat by scancode against an xkb keymap, and unicode or IME text goes through a virtual keyboard client. On X11, through XTEST with a spare keycode overlay. The default layout is `us` (`XKB_DEFAULT_LAYOUT` in `startwm_wayland.sh`). macOS Cmd is mapped to Ctrl (`SELKIES_MAC_CMD_AS_CTRL`). The mobile on-screen keyboard supports IME (Pinyin). Past issues with Chinese IME races and sticky modifiers (#150, #161, #144, #155) are closed. [verified, DOCS:architecture.md, issues] |
| **Multi-monitor** | The "Add Screen +" button opens a second browser window as a second monitor. On X11 this is always available (the patched Xvfb has 4 CRTCs). On Wayland it needs patched labwc or KWin, and Selkies probes for that at startup. `SELKIES_SECOND_SCREEN=false` hides it. [verified, DOCS:web-client.md] |
| **Sidebar** | Core toggles (display, audio, mic, webcam, gamepad), fullscreen, virtual trackpad, gaming mode (pointer lock), on-screen keyboard. Sections: video settings (encoder, FPS, CRF, 4:4:4, 10-bit, turbo, CPU encoding, rate control), screen (resolution, DPI, scaling), audio, clipboard, files (upload and download), apps (proot-apps), sharing (view-only and player links), gamepads, printing, stats. Each section can be hidden with `SELKIES_UI_SIDEBAR_SHOW_*`. |
| **Mobile / touch** | Trackpad mode, direct touch mode, a "More keys" palette. |
| **Printing** | A virtual "Selkies" CUPS printer turns documents into PDFs and hands them to the browser's print dialog. |
| **Single-app WM gestures** | Right-click the desktop for the root menu, middle-click for the window list, `ctrl+shift+d` to toggle decorations. |

---

## 9. Known limits and issues (as of 2026-11-21)

From BASE and ORCA GitHub issues, plus the docs:

- **The distro and AppImage ABI matter.** ORCA moved resolute to trixie because the newer libpango crashed the AppImage in Preferences (ORCA #36). Debian Trixie is currently the base that is known to work with an "Ubuntu 24.04" AppImage [verified].
- **GTK apps under Wayland:** ORCA had to force `GDK_BACKEND=x11` (XWayland) to fix UI rendering issues (ORCA changelog of 18.10.26) [verified]. Separately, ORCA #43 reported broken menus and buttons on some Intel GPUs, which was fixed by a later Selkies release [verified].
- **System D-Bus activation fails in the container:** `org.freedesktop.hostname1 … Permission denied` (ORCA #24). ORCA neutralises `svc-dbus` [verified fix; causal link inferred].
- **AppImage permissions:** newer AppImages extract with `700` directories, so `abc` cannot execute them. Fix with `chmod 755` on the directories (ORCA #45) [verified].
- **Client-side decode:** after an image update, Chromium on a client with an old GPU looped with "A critical video error occurred" on x264. The fix was the client falling back to `prefer-software` decoding (BASE #174, closed). Users can force `jpeg`, or add the striped H.264 encoder (`h264enc-striped`) back to `SELKIES_ENCODER` [verified].
- **CPU requirements:** x86_64 needs **AVX2**, and Proxmox's default VM CPU types hide it (ORCA #35, BASE #147). Arm64 was briefly misdetected and is now fixed [verified].
- **Black screen after an update** was usually a missing app dependency, for example `libmspack0` (ORCA #31), or stale env flags (ORCA #35). The recovery path is right-click, then a terminal, then relaunch [verified].
- **Intermediate TLS certs:** an app inside the container that talks to a printer or Moonraker with a server that does not send its full chain fails. That is a server-side fix (ORCA #25) [verified]. ORCA sets `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` [verified].
- **Nvidia:** not available on Alpine. Needs a host driver ≥580 and `--device /dev/nvidia-modeset`. Kernel params are needed below 595.80. **proot-apps cannot use Nvidia** [verified, DOCS:gpu.md, installing-apps.md].
- **Security:** no auth by default. The GUI has a terminal with passwordless sudo. Sharing links are "a demo". Basic auth is "to keep the kids out, not the internet" [verified].
- **Open BASE issues:** #198 "Optionally terminate the container when the app exits" (being built on `dev` as `EXIT_ON_APP_CLOSE`), and #192, a feature request to choose the download folder [verified].
- **Fixed recently, worth knowing:** a stale `/dev/shm/audio.lock` broke audio after a restart (#191). An empty `PASSWORD` enabled an unusable login (#177). A race between svc-de and cont-init env writes (#178) [verified, closed].

---

## 10. GPU, settings persistence, file transfer (short; see the dedicated docs)

- **GPU → `04-gpu-acceleration.md`.**
  - Concrete facts: `DRINODE` renders and `DRI_NODE` encodes, and they must match for zero copy.
  - `AUTO_GPU` turns itself on when `/dev/dri/renderD*` exists (x86_64).
  - `init-video` fixes group membership for `/dev/dri/*`.
  - X11 mode: Xvfb uses `-glamor -dri <node>` unless `DISABLE_DRI3=true`. Wayland: pixelflux renders on `SELKIES_RENDER_DRI`.
  - Nvidia plumbing is written at init: `/etc/vulkan/icd.d/nvidia_icd.json`, `/etc/glvnd/egl_vendor.d/10_nvidia.json`, `/etc/OpenCL/vendors/nvidia.icd`, the GBM copy, and `__GLX_VENDOR_LIBRARY_NAME=nvidia`.
  - The test tools are `vkcube`, `vainfo` and `nvidia-smi`.
  - ORCA issues #13 (segfault with renderD128) and #19 (no build plate on Nvidia) are historical, KasmVNC-era.
- **Settings persistence → `05-settings-persistence.md`.**
  - Only `/config` persists. App settings go to `~/.config/<App>` (ORCA: `/config/.config/OrcaSlicer/`).
  - autostart and menu are copied once. `rc.xml` is regenerated every boot.
  - `.XDG` is wiped every boot.
  - Client-side stream settings persist in the browser, and per-user overrides apply unless the setting is `|locked`.
  - `/config` is portable across distro flavours [verified, DOCS:installation.md].
- **File transfer → `06-file-transfer.md`.**
  - Upload by drag-and-drop or the sidebar button. Files land in `FILE_MANAGER_PATH` (default `/config/Desktop`).
  - Download from the sidebar "Files" browser of the same directory, served under `SUBFOLDERapi` (`/api/files/`) by Selkies on 8082. nginx uses `client_max_body_size 0` and `proxy_request_buffering off` there.
  - Controls: `SELKIES_FILE_TRANSFERS=upload,download` (empty means off), `SELKIES_FILE_TRANSFER_LIMIT_MBPS`, `SELKIES_UI_SIDEBAR_SHOW_FILES`. `HARDEN_DESKTOP` disables transfers.
  - A host bind mount into `/config/Desktop`, or a subfolder of it, is the obvious way to exchange STL/3MF/G-code files [inferred].
  - Printing gives a separate PDF path to the browser.

---

## 11. Implications for the Creality Print image

1. **Base: `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie`** (and `arm64v8-debiantrixie` for aarch64), the same as ORCA.
   - Creality Print is a Bambu Studio / PrusaSlicer-family wxGTK app, distributed like Orca as an AppImage built on Ubuntu. Trixie is the base that has been shown to work with that ABI (ORCA #36).
   - Pin a release tag (`debiantrixie-<id>-lsNNN`) for reproducible builds, because there is no stable `latest` and LSIO makes breaking changes without release notes.
2. **Copy ORCA's recipe nearly line for line:**
   - `ENV TITLE="Creality Print"` and `PIXELFLUX_WAYLAND=true`.
   - Install the runtime libs the AppImage needs. Start from ORCA's list: `libwebkit2gtk-4.1-0`, the GStreamer plugins, `libmspack0`. Creality Print's exact deps need checking.
   - Extract the AppImage with `--appimage-extract` into `/opt/creality-print`. There is no FUSE in the container.
   - Run `chmod 755` on its directories.
   - Inject `export GDK_BACKEND=x11` into `AppRun` (ORCA's workaround for GTK rendering under Wayland), or do it in a wrapper script.
   - Generate any locale the app insists on, as ORCA does with `localedef en_GB.UTF-8`.
   - Set `SSL_CERT_FILE` so the app's printer and cloud TLS works.
3. **Overlay `root/`:**
   - `defaults/autostart_wayland` and `defaults/autostart`: one line launching the app. Prefer a **stable wrapper path**, because existing `/config` keeps the old autostart forever.
   - `defaults/menu_wayland.xml` and `defaults/menu.xml`: terminal (foot or xterm) plus "Creality Print". Optionally a browser, which ORCA adds for printer web UIs and cloud login.
   - Icon: `/usr/share/selkies/www/icon.png`.
   - Consider copying ORCA's `svc-dbus/run` → `sleep infinity` override if the app triggers the same `hostname1` activation failure. Test first.
4. **Run defaults to document:**
   - `-p 3001:3001`, `--shm-size=1gb`, `-v ./config:/config`, `PUID`/`PGID`.
   - Optional `--device /dev/dri` for an Intel or AMD GPU. Creality Print's 3D viewport needs OpenGL. Without a GPU it renders through Mesa llvmpipe [inferred]; see 04.
   - Do **not** recommend `seccomp=unconfined` or `--privileged`.
   - Put HTTPS at the reverse proxy and pass WebSocket headers through.
5. **Do not reimplement** PUID/PGID, ports, auth, TLS, file transfer, clipboard or audio. The base owns all of them. If you need a runtime tweak, use an `init-*` oneshot that depends on `init-selkies-end`, or write `/run/s6/container_environment/<VAR>`.
6. **Test checklist** (adapted from DOCS:building-images.md):
   - Fresh `/config` and existing `/config`.
   - The app starts maximized.
   - The right-click menu relaunches it after a crash.
   - Clipboard works both ways.
   - Upload and download through `/config/Desktop`.
   - `RESTART_APP=true`.
   - Wayland (default) **and** `PIXELFLUX_WAYLAND=false`.
   - A client browser with and without hardware decode.

### Open questions

- Which Ubuntu version is the current Creality Print Linux AppImage built on? Does it hit the same pango and GLib ABI limits that made ORCA choose Trixie over resolute?
- Does Creality Print need a **session** D-Bus (keyring, portals, `xdg-open` for links)? In Wayland mode the base starts none unless `PELORUS=true`.
- Will the `dev` branch redesign (Selkies serving HTTP(S) itself, no nginx, pulse or de services) be promoted to `debiantrixie`? If it is, check whether `/defaults/autostart*` and `default.conf` semantics still hold.
- Is software OpenGL fast enough for Creality Print's 3D preview on a CPU-only host? (For 04.)
