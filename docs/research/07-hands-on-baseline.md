# 07 — Hands-on baseline: Creality Print in Selkies

Date: 2026-11-21 · Author: research agent D (hands-on) · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, no GPU passed in

**Result: it works (verified).** Creality Print V7.3.1 starts automatically in a `baseimage-selkies:debiantrixie` container, without a GPU, once **one** extra apt package (`libwebkit2gtk-4.1-0`) is installed. It renders the 3D plater with Mesa **llvmpipe**. The first-run wizard can be completed through the Selkies web UI, an STL can be imported and sliced, and settings survive a container restart. No crashes or blocking errors came up, so no workarounds were needed beyond copying orcaslicer's (`GDK_BACKEND=x11`, `chmod 755` on the extracted dirs).

Research image: **`crp-research:baseline`** (kept). Its Dockerfile and `root/` overlay are in the scratch dir (see §6) and inlined below.

Legend: **[V]** = verified (observed by running it), **[I]** = inferred.

---

## 1. Reference: what linuxserver/docker-orcaslicer does

Shallow clone of `linuxserver/docker-orcaslicer` at commit `4b114d95` (2026-11-17). The image tested was `lscr.io/linuxserver/orcaslicer:latest`, labelled `v2.5.1-ls52`.

- `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie` [V]
- `ENV TITLE=OrcaSlicer SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PIXELFLUX_WAYLAND=true` [V]
- apt (no-recommends), after adding the Mozilla apt repo: `firefox gstreamer1.0-alsa gstreamer1.0-gl gstreamer1.0-gtk3 gstreamer1.0-libav gstreamer1.0-plugins-bad gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-pulseaudio gstreamer1.0-qt5 gstreamer1.0-tools gstreamer1.0-x libgstreamer-plugins-bad1.0 libmspack0 libwebkit2gtk-4.1-0 libwx-perl` [V]
- Downloads the AppImage at build time (GitHub API, `select(test("Ubuntu2404_V"))`), then `--appimage-extract` → `/opt/orcaslicer`, `localedef en_GB.UTF-8`, `sed -i "1a export GDK_BACKEND=x11" AppRun`, and `find /opt/orcaslicer -type d -exec chmod 755 {} +` [V]
- `root/`: `defaults/autostart` and `defaults/autostart_wayland` both contain `/opt/orcaslicer/AppRun`; `defaults/menu.xml` and `menu_wayland.xml` hold openbox/labwc right-click menus; `etc/s6-overlay/s6-rc.d/svc-dbus/run` is overridden with `sleep infinity`, which disables the base image's dbus service [V]
- `EXPOSE 3001`, `VOLUME /config` [V]

## 2. Asset chosen

```
gh api repos/CrealityOfficial/CrealityPrint/releases --paginate -q '.[] | [.tag_name,.name,.prerelease,.draft,.published_at] | @tsv'
gh api repos/CrealityOfficial/CrealityPrint/releases/latest -q '.tag_name, (.assets[] | [.name,.size,.browser_download_url,.digest] | @tsv)'
```

| Release | Status | Published |
|---|---|---|
| v7.3.2 | **prerelease** | 2026-11-13 |
| **v7.3.1** | **latest stable** (used) | 2026-10-31 |
| v7.3.0 | stable | 2026-09-24 |

Linux assets for v7.3.1 [V]:

| Asset | Size | Note |
|---|---|---|
| **`CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage`** | 191,511,032 B | **chosen.** Only one AppImage; no per-Ubuntu or per-webkit variants (unlike OrcaSlicer) |
| `CrealityPrint-Linux-flatpak_V7.3.1-Release_x86_64.flatpak` | 192,564,312 B | not used |
| `crealityprint-7.3.1-release-{full,delta}.nupkg` | 231 MB / 25 MB | Squirrel/Velopack-style update packages [I: probably Windows updater] |

- URL: https://github.com/CrealityOfficial/CrealityPrint/releases/download/v7.3.1/CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage
- sha256 `f8c8dbf18a6b0d5878961b24490fc20958eefe2f03f6a89f524cb9b21e55a107`. This matches the `digest` the GitHub API reports [V]. The download took about 8 s.
- v7.3.2 (prerelease) also ships just one x86_64 AppImage (`CrealityPrint-V7.3.2.6412-x86_64-Release.AppImage`). The naming pattern is stable, so `select(test("x86_64-Release\\.AppImage$"))` works for both [V].
- No aarch64 Linux asset exists [V].

## 3. AppImage contents

The AppImage was extracted inside a throwaway container from the base image, never run on the host:

```
docker run --rm --name crp-research-D-extract --entrypoint bash \
  -v $S/dl-appimage:/in:ro -v $S/extracted:/out \
  ghcr.io/linuxserver/baseimage-selkies:debiantrixie \
  -c 'cd /out && cp /in/*.AppImage /tmp/a && chmod +x /tmp/a && /tmp/a --appimage-extract >/dev/null && chown -R 1000:1000 /out'
```

Extracted size: 512 MB [V]. Layout:

- `AppRun`: a bash script, shown in full below [V]
- `bin/CrealityPrint`: a 236 MB ELF x86-64 PIE, not stripped, with debug info. Built with `GCC (Ubuntu 13.3.0-6ubuntu2~24.04.1)` and Ubuntu clang 18.1.3, so on **Ubuntu 24.04**. It needs up to GLIBC_2.38 (trixie has 2.41) [V]. Statically contains wxWidgets (GTK3), OCCT, TBB and similar [I].
- `usr/lib/`: the bundled shared libs [V]: `libGLU.so.1 libGLdispatch.so.0 libOpenGL.so.0 libLerc.so.4 libasound.so.2 libexpat.so.1 liblzma.so.5 libmspack.so.0 libopus.so.0 libpango-1.0.so.0 libpangocairo-1.0.so.0 libpangoft2-1.0.so.0 libpangoxft-1.0.so.0 (pango 1.52.2) libspeexdsp.so.1 libsrtp2.so.1 libusrsctp.so.2 libx264.so.164 libz.so.1`. The srtp, usrsctp, x264 and opus libs suggest a built-in WebRTC stack for printer cameras [I].
- `resources/` (about 280 MB): `profiles` 81M, `web` 62M (the HTML/JS front-ends for the device manager, wizard and so on), `fonts` 36M, `images` 31M, `creality_models` 30M, `calib` 20M, `i18n` 15M, plus `shaders`, `printers`, `cert`, `data`, `dailytip`, `tooltip`, `filament_mixing` and `profiles_template`.
- Directory permissions inside the squashfs are `0700` [V]. That is why orcaslicer's `find -type d -exec chmod 755` step is required, or the `abc` user cannot read `/opt/crealityprint`.

`AppRun` (verbatim, v7.3.1):

```bash
#!/bin/bash
DIR=$(readlink -f "$0" | xargs dirname)
export LD_LIBRARY_PATH="$DIR/bin:$DIR/usr/lib"

# FIXME: CrealityPrint segfault workarounds
# 1) CrealityPrint will segfault on systems where locale info is not as expected (i.e. Holo-ISO arch-based distro)
export LC_ALL=C

# 2) Hybrid iGPU/NVIDIA systems: libglvnd may select NVIDIA's GLX vendor even
#    when the display is driven by an Intel or AMD GPU, causing GLX context
#    creation to fail with BadValue. Prefer Mesa for a non-NVIDIA boot VGA
#    device, while preserving explicit user choices such as PRIME offload.
if [ -z "${__GLX_VENDOR_LIBRARY_NAME+x}" ]; then
    have_nvidia_glx=0
    if command -v ldconfig >/dev/null 2>&1 &&
       ldconfig -p 2>/dev/null | grep -q 'libGLX_nvidia\.so\.0'; then
        have_nvidia_glx=1
    else
        for glx_library in             /usr/lib/*/libGLX_nvidia.so.0             /usr/lib*/libGLX_nvidia.so.0             /lib/*/libGLX_nvidia.so.0             /lib*/libGLX_nvidia.so.0; do
            if [ -e "$glx_library" ]; then
                have_nvidia_glx=1
                break
            fi
        done
    fi

    if [ "$have_nvidia_glx" = "1" ]; then
        for drm_device in /sys/class/drm/card*/device; do
            boot_vga=$(cat "$drm_device/boot_vga" 2>/dev/null)
            gpu_vendor=$(cat "$drm_device/vendor" 2>/dev/null)
            if [ "$boot_vga" = "1" ] && [ "$gpu_vendor" != "0x10de" ]; then
                export __GLX_VENDOR_LIBRARY_NAME=mesa
                break
            fi
        done
    fi
fi

exec "$DIR/bin/CrealityPrint" "$@"
```

Notes: `AppRun` forces `LC_ALL=C`, so orcaslicer's `localedef en_GB` step is not needed [V: the app ran fine without it, and its UI language comes from its own config (`language: en_US`)]. The NVIDIA/GLX vendor logic matters to the GPU tester.

## 4. Missing libraries (ldd)

```
docker run --rm --name crp-research-D-ldd --entrypoint bash \
  -v $S/extracted/squashfs-root:/app:ro ghcr.io/linuxserver/baseimage-selkies:debiantrixie -c '
  export LD_LIBRARY_PATH=/app/bin:/app/usr/lib
  ldd /app/bin/CrealityPrint | grep "not found"
  for f in /app/usr/lib/*.so*; do ldd $f | grep "not found"; done'
```

Result on the bare base image [V]:

| Missing lib | Needed by | Debian trixie package | Version installed |
|---|---|---|---|
| `libwebkit2gtk-4.1.so.0` | `bin/CrealityPrint` | `libwebkit2gtk-4.1-0` | 2.54.0-1~deb13u3 |
| `libjavascriptcoregtk-4.1.so.0` | `bin/CrealityPrint` | `libjavascriptcoregtk-4.1-0` (dependency of the above) | 2.54.0-1~deb13u3 |
| `libsoup-3.0.so.0` | `bin/CrealityPrint` | `libsoup-3.0-0` (dependency of the above) | 3.6.5-3 |

- No bundled `.so` has unresolved deps [V].
- The base image already provides everything else the binary links against: GTK3, GDK, cairo, harfbuzz, GStreamer core (`libgstreamer-1.0`, `libgstvideo`, `libgstbase`), EGL/GLX/libGL (glvnd + Mesa 25.0.7), wayland-client/egl, NSS/NSPR, dbus and tiff [V].
- After installing the package, `ldd` reports 0 "not found" entries, and webkit, soup and jsc resolve to `/lib/x86_64-linux-gnu/` [V].
- Strings in the binary that could be dlopen targets: `libOSMesa.so.6/8`, `libGLES_CM.so.1`, `libiomp5.so`, `libtbbbind_2_0.so.3`, `libittnotify.so` [V: present as strings]. None was needed at runtime in these tests. They are probably optional TBB, OCCT or VTK probes [I].

### Diff vs orcaslicer's apt list

| Package | orcaslicer | crp baseline | Needed for Creality Print? |
|---|---|---|---|
| `libwebkit2gtk-4.1-0` | yes | yes | **yes, hard dependency** [V] |
| `gstreamer1.0-{gl,libav,plugins-bad,plugins-base,plugins-good,tools,x}` | yes | yes | **no, not for start-up or slicing** [V: a `webkit-only` variant without them started, showed the web-rendered wizard and spawned all WebKit processes]. Possibly needed for camera/video in the Device tab [I, untested] |
| `gstreamer1.0-{alsa,gtk3,plugins-ugly,pulseaudio,qt5}`, `libgstreamer-plugins-bad1.0` | yes | no | not observed as needed |
| `libmspack0` | yes | no | no, it is bundled in the AppImage `usr/lib` [V] |
| `libwx-perl` | yes | no | no; it's a perl binding and the CrealityPrint binary links wx statically [I] |
| `firefox` (+ Mozilla repo) | yes | no | maybe, for "open in browser" links (privacy policy, wiki) [I, untested] |
| `localedef en_GB.UTF-8` | yes | no | no, because `AppRun` forces `LC_ALL=C` [V] |

Size effect: `libwebkit2gtk-4.1-0` alone pulls in 154 packages when the gstreamer set is included (424 MB layer). The webkit-only variant is about 250 MB smaller on disk (4.77 GB vs 5.02 GB) [V]. That variant was deleted after the test.

## 5. Build

- **Approach: download inside the build with a version ARG, like orcaslicer** (`CREALITYPRINT_VERSION=v7.3.1`). The apt layer and the download layer are separate RUNs, so the download is cached while the apt list changes.
- Build: `docker build -t crp-research:baseline .` took **1m14s** on the first build (apt plus the 190 MB download plus extract/export) [V].

## 6. Final Dockerfile and `root/` overlay (in full)

Scratch dir (`$S`) = `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-D`

Dockerfile path: `$S/image/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
# THROWAWAY research image (agent-D baseline) - mirrors linuxserver/docker-orcaslicer.

FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie

ARG CREALITYPRINT_VERSION=v7.3.1

ENV TITLE=CrealityPrint \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PIXELFLUX_WAYLAND=true

# Layer 1: runtime deps (split from the download so iterations hit the cache)
RUN \
  echo "**** install packages ****" && \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive \
  apt-get install --no-install-recommends -y \
    gstreamer1.0-gl \
    gstreamer1.0-libav \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-tools \
    gstreamer1.0-x \
    libwebkit2gtk-4.1-0 && \
  apt-get autoclean && \
  rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/*

# Layer 2: Creality Print AppImage, downloaded at build time and extracted
RUN \
  echo "**** install crealityprint from appimage ****" && \
  DOWNLOAD_URL=$(curl -sX GET "https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases/tags/${CREALITYPRINT_VERSION}" \
    | jq -r 'first(.assets[].browser_download_url | select(test("x86_64-Release\\.AppImage$")))') && \
  echo "**** downloading ${DOWNLOAD_URL} ****" && \
  cd /tmp && \
  curl -o /tmp/crp.app -L "${DOWNLOAD_URL}" && \
  chmod +x /tmp/crp.app && \
  ./crp.app --appimage-extract > /dev/null && \
  mv squashfs-root /opt/crealityprint && \
  sed -i "1a export GDK_BACKEND=x11" /opt/crealityprint/AppRun && \
  find /opt/crealityprint -type d -exec chmod 755 {} + && \
  printf "CrealityPrint ${CREALITYPRINT_VERSION}\nURL: ${DOWNLOAD_URL}\n" > /build_version && \
  rm -rf /tmp/*

COPY /root /

EXPOSE 3001
VOLUME /config
```

`$S/image/root/defaults/autostart` and `$S/image/root/defaults/autostart_wayland` (identical):

```
/opt/crealityprint/AppRun
```

`$S/image/root/defaults/menu.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
<menu id="root-menu" label="MENU">
<item label="xterm" icon="/usr/share/pixmaps/xterm-color_48x48.xpm"><action name="Execute"><command>/usr/bin/xterm</command></action></item>
<item label="CrealityPrint" icon="/opt/crealityprint/CrealityPrint.png"><action name="Execute"><command>/opt/crealityprint/AppRun</command></action></item>
</menu>
</openbox_menu>
```

`$S/image/root/defaults/menu_wayland.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
<menu id="root-menu" label="MENU">
<item label="foot" icon="/usr/share/pixmaps/xterm-color_48x48.xpm"><action name="Execute"><command>/usr/bin/foot</command></action></item>
<item label="CrealityPrint" icon="/opt/crealityprint/CrealityPrint.png"><action name="Execute"><command>/opt/crealityprint/AppRun</command></action></item>
</menu>
</openbox_menu>
```

`$S/image/root/etc/s6-overlay/s6-rc.d/svc-dbus/run` (mode 755, copied from orcaslicer, which disables the base image's dbus service):

```bash
#!/usr/bin/with-contenv bash

sleep infinity
```

Differences from orcaslicer: no Firefox (and no menu entry for it), no custom icon download for `/usr/share/selkies/www/icon.png`, no `localedef`, and a trimmed gstreamer set.

## 7. Running it

```
docker run -d --name crp-research-D-run -p 3100:3000 -p 3101:3001 --shm-size=1gb crp-research:baseline
```

- `--security-opt seccomp=unconfined` was **not needed** [V]. WebKit's `bubblewrap` sandbox package is installed as a dependency. WebKit processes start fine under the default seccomp profile [V], though whether WebKit actually sandboxes or falls back is unknown [I].
- `http://localhost:3100` returns HTTP 200 (Selkies UI, title "CrealityPrint"). `https://localhost:3101` returns 200 (self-signed) [V].
- Second run with lsio env vars and a bind mount [V]:
  ```
  docker run -d --name crp-research-D-run -p 3100:3000 -p 3101:3001 --shm-size=1gb \
    -e PUID=1000 -e PGID=1000 -e TZ=Europe/Copenhagen -v $S/config-run2:/config crp-research:baseline
  ```
  The files under the bind mount are owned by host uid 1000 (`micdah`), so the PUID/PGID remap works.

### How the app is launched (for the GPU, persistence and file-transfer testers)

- The image runs in Wayland mode (`PIXELFLUX_WAYLAND=true`). `svc-de` waits for `/config/.XDG/wayland-1` and then runs `/defaults/startwm_wayland.sh` as `abc`, which starts **labwc**. labwc runs `~/.config/labwc/autostart`, which `init-selkies-config` copies on first run from `/defaults/autostart_wayland`. That file runs `/opt/crealityprint/AppRun` [V: process tree].
- Because of `export GDK_BACKEND=x11` in `AppRun`, the app runs as an **X11 client on Xwayland `:0`** inside labwc, not as a native Wayland client [V: `Xwayland :0 -rootless` process; app env has `DISPLAY=:0`, `GDK_BACKEND=x11`, `WAYLAND_DISPLAY=wayland-0`].
- App process environment [V]: `HOME=/config`, `XDG_RUNTIME_DIR=/config/.XDG`, `LC_ALL=C`, `GDK_BACKEND=x11`, `DISPLAY=:0`, `XDG_CURRENT_DESKTOP=labwc:wlroots`, plus `SELKIES_*` vars. It runs as user `abc`.
- Processes at idle [V]: `CrealityPrint` plus 4 `WebKitWebProcess` and 4 `WebKitNetworkProcess` (one pair per embedded web view: home, device manager, wizard and so on), `Xwayland`, `labwc`, `selkies` (python), `pulseaudio` and `nginx`.
- The app opens an internal HTTP port: the device-manager web view is loaded as `file:///opt/crealityprint/resources/web/deviceMgr/index.html?...&port=13666` [V: app log]. It's internal to the container.
- Docker logs show only Selkies/pixelflux output. The app's own stdout/stderr does not reach `docker logs`, because labwc's autostart swallows it [V]. The app log is at `/config/.config/Creality/Creality Print/7.3/log/debug_<date>.log.0` [V].
- To restart only the app: kill the `CrealityPrint` process and relaunch `/opt/crealityprint/AppRun` as `abc` with the env above. There's no s6 service for the app itself [I: same as orcaslicer].

### GL without a GPU

- **llvmpipe works; no `/dev/dri` is needed to start or to render the plater** [V]. `/dev/dri` was absent. With `mesa-utils` installed on the fly in the container (not part of the image), `glxinfo -B` on `:0` reported `OpenGL renderer string: llvmpipe (LLVM 19.1.7, 256 bits)`, `4.5 (Core/Compatibility Profile) Mesa 25.0.7-2+deb13u1`, `Accelerated: no` [V].
- The CrealityPrint process maps `libGLX_mesa`, `libEGL_mesa`, `libgallium-25.0.7` and `libGL.so.1` from the system, plus the **bundled** `libGLdispatch.so.0` and `libGLU.so.1` [V]. The glvnd dispatch lib comes from Ubuntu 24.04 and is mixed with trixie's libGLX/libGL. That worked here, but a GPU or NVIDIA test should watch for glvnd ABI mismatches [I].
- The Selkies side reports `[Wayland] Renderer: software (Pixman), no render node` and `Encoder: software H264 (x264)`, falling back to `svt-av1` when the client picks AV1. pixelflux tried nvenc and failed with `libcuda.so.1` not found, which is harmless [V].

## 8. Walking the first-run wizard (Playwright)

The host had **no Playwright and no Chromium** (`require('playwright')` failed, and there was no browser binary). Workaround [V]: `npm i --ignore-scripts playwright@1.49.0` in `$S/pw`, then run the scripts inside `mcr.microsoft.com/playwright:v1.49.0-noble` with `--network host`. Wrapper: `$S/scripts/pw.sh`. Scripts: `$S/scripts/shot.js` (timed screenshots) and `$S/scripts/steps.js` (JSON list of click/key/type/screenshot actions; viewport 1600×900, `deviceScaleFactor: 2`). Mouse clicks and keyboard input on the Selkies canvas reach the app [V]. Selkies resized the remote desktop to the client's size × DPR (3200×1800 at scale 2) [V: log `Layout calculated: Total Size=3200x1800`].

First-run sequence observed [V]:

1. "Please select software mode": AI Edition (Beta) / **Professional Edition** (preselected) → Next
2. "Please select your login area": Asia-Pacific / Chinese Mainland / Europe / North America / Others → picked Europe → Next
3. "Welcome to Creality Print": *Log in to Creality Cloud to sync printers* / *Connect Printer via LAN* / **Skip Printer Connection for Now**
4. Printer picker modal (Creality Flagship/Ender/CR/Hi/... series, SPARKX, and other vendors such as Anker, Anycubic, BBL...) → ticked Creality K1 → Confirm
5. "User Experience Improvement Program" (separate full-screen window): Cancel / Join in → Cancel
6. Main window: Prepare tab with a K1 bed rendered in 3D (llvmpipe)

These pages (1–3 and the UX dialog) are **HTML in WebKit** web views, not native wx widgets [I: the layout and fonts suggest it, and WebKit processes spin up]. So the wizard depends on WebKit working.

Then [V]: Add (Ctrl+I) opened a GTK file chooser. Typing `/config/cube.stl` via Ctrl+L and pressing Enter imported a 20 mm cube. **Slice plate** produced G-code: 14m42s, 3.48 g, 144 steps, in a few seconds on llvmpipe. The Preview tab rendered the toolpaths.

### Screenshots (3200×1800 PNG, all under `$S/shots/`)

| Path | What's visible |
|---|---|
| `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-D/shots/01-first-020s.png` | First connect: app already running with its menu bar (AI Creation / Online Models / Prepare / Preview / Device) and the "select software mode" page; Selkies sidebar handle at the left edge |
| `.../agent-D/shots/02-wizard-b-after-next.png` | Login-area selection (region list) |
| `.../agent-D/shots/03-wizard-b-next.png` | "Welcome to Creality Print": Cloud login / LAN / Skip |
| `.../agent-D/shots/04-wizard-a-skip.png` | Printer-selection modal |
| `.../agent-D/shots/05-wizard-b-confirm.png` | Creality K1 ticked (Confirm still processing) |
| `.../agent-D/shots/06-wizard-a-wait.png` | "User Experience Improvement Program" opt-in window |
| `.../agent-D/shots/07-main-a-after-ux-cancel.png` | Main Prepare view: Creality K1, Smooth PEI plate rendered in 3D, process settings panel |
| `.../agent-D/shots/08-import-a-dialog.png`, `08-import-b-typed.png` | Native GTK3 file chooser ("Choose one or more files (3mf/step/stl/svg/obj/amf)") opened from Add, with the location bar showing `/config/cube.stl`. Sidebar bookmarks: Recent, Home (`/config`), **Desktop** (`/config/Desktop`), log, Other Locations. Filter list: 3mf, stl, oltp, stp/step, svg, amf, obj, gltf/glb, fbx, dae, 3ds, ply, off |
| `.../agent-D/shots/08-import-c-loaded.png` | 20 mm cube on the plate; object info box (20×20×20 mm, 12 triangles) |
| `.../agent-D/shots/09-slice-a-sliced.png` | Preview tab after slicing: G-code preview, line-type stats, layer slider |
| `.../agent-D/shots/10-run2-a-fresh.png` | Run 2 (PUID/PGID, bind-mounted /config): wizard shown again on the empty config |
| `.../agent-D/shots/10-run2-c-main.png` | Run 2 after the wizard. The blind clicks landed on Creality K2 Plus this time, with a Textured PEI plate |
| `.../agent-D/shots/11-restart-a-after-restart.png` | After `docker restart`: **no wizard**, K2 Plus still selected. A toast reads "Detected a new parameter package to update… Immediate Update" |
| `.../agent-D/shots/12-sidebar-a-open.png` | Selkies sidebar opened (click on the pink handle at the left edge, about CSS x=7, y=450 at 1600×900) |
| `.../agent-D/shots/12-sidebar-b-files.png` | Sidebar **FILES** section expanded: **Upload Files** and **Download Files** buttons |
| `.../agent-D/shots/13-minimal-a-start.png` | The webkit-only variant (no gstreamer plugins) showing the wizard |

(The `...` stands for `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad`.)

## 9. Config and data paths under /config

Observed after the first run and the wizard [V]:

| Path | Content |
|---|---|
| `/config/.config/Creality/Creality Print/7.3/` | **Main app data dir.** `Creality.conf` (JSON app config: `region`, `language`, `firstguide`, `download_path`, …), `user/default/` (user presets), `system/` (vendor profiles copied from resources, e.g. `Creality.json`, `Custom.json`), `printers/`, `cache/`, `log/`, `ota/`, `thumbnail_cache/`, `filament_mixing/`, `migration/`, `deviceInfo.json`, `privacyInfo.json`. About 24 MB after first run |
| `/config/.config/Creality/Creality Print/.migration-7.3/` and `.migration-7.3.lock` | Settings-migration state between versions |
| `/config/.local/share/CrealityPrint/` | WebKit storage: `localstorage/file__0.localstorage`, `hsts-storage.sqlite`, `storage/`, `mediakeys/` |
| `/config/.cache/CrealityPrint/` | WebKit `CacheStorage`, `WebKitCache` |
| `/config/.Creality/crealityprint_squirrel/7.3.1.6378/` | Empty dir, named after the Squirrel/Velopack updater (see open questions) |
| `/config/.cache/mesa_shader_cache_db/` | Mesa llvmpipe shader cache (about 2.3 MB) |
| `/config/.config/labwc/`, `.config/gtk-3.0/`, `.config/pulse/`, `.XDG/`, `Desktop/` | Base-image or desktop files |

Notes for the persistence tester:
- The data dir name contains the **major.minor version** (`7.3`). A 7.4 upgrade will likely create `.../7.4/` and migrate from `7.3` (the `migration/` and `.migration-7.3` dirs suggest this) [I].
- `Creality.conf` → `"download_path": "/config/.config/Creality/Creality Print/7.3/cloud_download_data"` [V].
- `"is_first_install": "1"`, `"region": "Europe"` and `firstguide.first_launch_at_utc` are recorded in `Creality.conf` [V]. After a `docker restart` with the bind-mounted `/config`, the wizard was skipped and the printer choice kept [V].

## 10. Resource numbers

| Metric | Value |
|---|---|
| `crp-research:baseline` image | **5.02 GB** on disk / **1.29 GB** content (compressed) [V] |
| Layers on top of base | apt layer 424 MB, AppImage layer 538 MB, `root/` 45 kB [V] |
| Base `ghcr.io/linuxserver/baseimage-selkies:debiantrixie` | 3.7 GB / 934 MB (label `f7632021-ls153`, built 2026-11-21, digest `sha256:793fc3628ad6…`) [V] |
| `lscr.io/linuxserver/orcaslicer:latest` (comparison) | 6.86 GB / 1.75 GB (`v2.5.1-ls52`) [V] |
| `mcr.microsoft.com/playwright:v1.49.0-noble` (test tool only) | 3.47 GB / 873 MB [V] |
| Startup, `docker run` → web UI HTTP 200 | **1.3 s** [V] |
| `docker run` → `CrealityPrint` process | **3.0 s** [V] |
| `docker run` → main window initialised (log line `PrinterMgrView m_browser`) | **4.2 s** [V] (fresh /config, first run) |
| Idle, no client connected, after a restart (run 2) | **CPU 1.8–2.9 %**, **mem 2.15 GiB**, 413 PIDs [V] |
| Idle, no client, run 1 right after a 3200×1800 session and a slice | CPU 2.6–3.8 %, mem 3.9 GiB (selkies process RSS 2.2 GB, CrealityPrint 840 MB) [V] |
| Per-process RSS at idle (run 2) | selkies 875 MB, CrealityPrint 786 MB, WebKitWebProcess 449 + 309 + 209 + 209 MB [V] |

Note: Docker's memory number includes page cache, and Selkies' RSS grows with the streamed resolution [I]. The `docker stats` here use an unlimited memory limit (31 GiB host).

## 11. Errors hit and workarounds

| Problem | Fix |
|---|---|
| Base image lacks `libwebkit2gtk-4.1.so.0`, `libjavascriptcoregtk-4.1.so.0`, `libsoup-3.0.so.0` | `apt-get install libwebkit2gtk-4.1-0` [V] |
| Extracted squashfs dirs are 0700 | `find /opt/crealityprint -type d -exec chmod 755 {} +` (copied from orcaslicer and applied preemptively; the unchmodded case was not tested, so this is [I] that it would fail) |
| Host has no Playwright or Chromium | Ran the scripts inside `mcr.microsoft.com/playwright:v1.49.0-noble` with `--network host` (`$S/scripts/pw.sh`) [V] |
| `bc` missing on host for timing | Used `awk` [V] |
| App crashes, GL failures, webkit failures | **None seen** [V] |

`GDK_BACKEND=x11` was copied from orcaslicer and not A/B tested. Running native Wayland GTK under labwc is untested [I].

## 12. Open questions

1. **Native Wayland vs Xwayland**: does the app work without `GDK_BACKEND=x11`? wxWidgets GL canvases on native Wayland are often broken, so keep x11 unless tested [I].
2. **GStreamer plugins**: start-up and slicing work without them. Do the Device tab's printer camera streams (WebRTC/RTSP via the bundled libsrtp2, usrsctp and x264) need `gstreamer1.0-plugins-*` or `-libav`? This needs a real printer to test.
3. **Firefox / xdg-open**: links such as the "Privacy Policy" link and the Creality Cloud login may try to open an external browser. Is Firefox needed, as in orcaslicer, or does the cloud login happen inside a WebKit view? Untested.
4. **Self-update**: the `crealityprint_squirrel/<version>` dir and the `.nupkg` release assets point to an updater. Does the Linux AppImage offer in-app updates, and should they be disabled or ignored in a container (`check_stable_update_only` is in `Creality.conf`)? No update prompt appeared in about 10 min. The "new parameter package" (preset/profile OTA) toast did appear after a restart.
5. **dbus disabled** (orcaslicer's `svc-dbus` override): no visible problem, but WebKit or GTK portals might log dbus warnings. App stderr isn't captured, so this wasn't checked.
6. **glvnd mix**: the AppImage bundles `libGLdispatch.so.0` and `libOpenGL.so.0` from Ubuntu 24.04 while the system provides `libGL/libGLX/libEGL` from trixie. That works on llvmpipe; check with `/dev/dri` (Intel iris) and with NVIDIA.
7. **seccomp**: works without `seccomp=unconfined`. Whether WebKit's bubblewrap sandbox is active or silently disabled wasn't checked.
8. **aarch64**: there is no Linux arm64 asset, so the image would be amd64-only.
9. `OnInit memory total_bytes 0 memory available_bytes 0` in the app log: the app can't read memory info in the container. It's harmless so far but might affect auto-tuning (e.g. thread counts) [I].

## 13. Cleanup state

- All `crp-research-D-*` containers removed (`docker ps -a --filter name=crp-research-D` is empty) [V].
- Kept images: `crp-research:baseline` (5.02 GB), `ghcr.io/linuxserver/baseimage-selkies:debiantrixie` (3.7 GB), `lscr.io/linuxserver/orcaslicer:latest` (6.86 GB, already present before this work), `mcr.microsoft.com/playwright:v1.49.0-noble` (3.47 GB, test tooling).
- Deleted: `crp-research:minimal-webkit-only` (4.77 GB, the experiment with no gstreamer plugins).
- The orcaslicer fallback on port 3100 was **not needed**, because Creality Print itself works.
- Scratch artefacts in `$S`: `dl-appimage/` (original AppImage), `extracted/squashfs-root/`, `image/` (Dockerfile and root), `image-minimal/`, `scripts/` (`pw.sh`, `shot.js`, `steps.js`, `cube.py`, `time-start.sh`), `pw/` (the playwright npm package), `shots/`, `out/` (`ldd-base.txt`, `build1.log`, package lists) and `config-run2/` (the bind-mounted /config from run 2, with the wizard completed and a K2 Plus selected; usable as a pre-seeded config).
