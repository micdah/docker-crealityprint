# Creality Print in the image

What the Creality Print application is, how the image installs and starts it, and how it behaves inside a container. The data directory is in [persistence.md](persistence.md), GPU and OpenGL in [gpu.md](gpu.md), printers in [printers.md](printers.md), the upload watcher in [files.md](files.md). Why the image does what it does is in [decisions.md](decisions.md).

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.
Verified against: Creality Print 7.3.1 and 7.3.2 source and AppImages.

- Creality Print is an AGPL-3.0 fork of OrcaSlicer: a wxWidgets/GTK3 desktop app with an OpenGL 3D view and many embedded WebKitGTK pages.
- Linux ships as one x86_64 AppImage per release, built on Ubuntu 24.04. It needs glibc 2.38 or newer, webkit2gtk-4.1 and libsoup-3 from the host [V].
- The image downloads the release named in `ARG CREALITYPRINT_VERSION` (now `v7.3.2`), checks its sha256, extracts it unmodified to `/opt/crealityprint` and makes its directories 0755. On the base image, `libwebkit2gtk-4.1-0` is the only package the app needs [V].
- The app runs as `abc` on Xwayland `:0`. It is started by `/usr/local/bin/crealityprint`, which sets `GDK_BACKEND=x11` and runs `AppRun`.
- Every running instance listens on the session D-Bus for files from a second instance. The image uses this to add uploads to the open plate without starting a second app [V].

## What the app is

- **Lineage.** A fork of OrcaSlicer, which forks BambuStudio, which forks PrusaSlicer. The About dialog says "based on PrusaSlicer and BambuStudio". The code has diverged a lot since the fork in 2024 [V markers, I date].
- **Toolkit.** wxWidgets 3.3.2 linked statically against GTK3. The 3D view is OpenGL (details in [gpu.md](gpu.md)). The home page, setup wizard, device manager and login are a Vue web UI in `resources/web/`, shown in WebKitGTK views [V].
- **Build.** CMake and Ninja, with a dependency superbuild (Boost, OCCT, CGAL, OpenVDB, FFmpeg, paho-mqtt, the `metartc` WebRTC stack, wxWidgets). The Linux entry point is `BuildLinux.sh`. Recipes such as `deps/CR_CLOSED` suggest some parts are closed, so a full build from source may not be possible [I]. The image never builds from source.
- **License.** AGPL-3.0 (`LICENSE.txt`) [V]. The image ships the unmodified AppImage and records the exact upstream release in the labels `crealityprint.version` and `crealityprint.upstream`. If the image ever patched the binary or its resources, it would have to publish that source [I, not legal advice].
- **Network plugin.** The Bambu network-plugin code is inherited, but `GUI_App::on_init_network()` returns `false`. No proprietary plugin is loaded or downloaded at runtime. WebRTC, MQTT and the cloud upload code are compiled into the binary [V, source].

## Releases and assets

As of 2026-11-21 [V, GitHub releases API]:

| Release | Published | GitHub prerelease | Linux x86_64 AppImages |
|---|---|---|---|
| v7.3.2 | 2026-11-13 | **true** | `CrealityPrint-V7.3.2.6412-x86_64-Release.AppImage` |
| v7.3.1 | 2026-10-31 | false | `CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage` (191,511,032 bytes) |
| v7.3.0 | 2026-09-24 | false | three re-spins: builds 6149, 6151 and 6157 |
| v7.2.1, v7.1.1 | 2026-08-04, 2026-04-28 | false | one generic AppImage |
| v7.2.0 | 2026-06-30 | false | generic, `ubuntu2204`, and two `wayland` Beta builds |
| v6.2.1–v7.1.0 | 2025–2026 | false | `CrealityPrint_Ubuntu2004-V…` (webkit2gtk-4.0) and `CrealityPrint_Ubuntu2404-V…` (4.1), casing varies |
| v6.1.x–v6.2.0 | 2025 | false | generic and `CrealityPrint_Ubuntu2404-V…` |
| v6.0.0 | 2025 | false | none |
| up to v5.1.7 | 2024 | false | `Creality_Print-v…` (older naming) |

- **The naming changes often.** The generic `CrealityPrint-V<version>.<build>-x86_64-Release.AppImage` is the Ubuntu 24.04 build: Creality's Jenkins Linux stage runs on an `ubuntu24.04` agent [V, source].
- **The tag doesn't give the file name.** The 4th version part (`6378`) is a commit count on Creality's internal repo, so the download URL can't be built from the tag alone [V].
- **The GitHub prerelease flag is unreliable.** Old `-Beta` tags are not flagged, and v7.3.2 is flagged while creality.com offers it as the current download for Windows, macOS and Linux [V]. That is why the image tracks every plain `vX.Y.Z` tag (see [decisions.md](decisions.md)).
- **Other formats.** Most releases also carry an x86_64 flatpak (runtime `org.gnome.Platform` 50). aarch64 exists only as a flatpak for v6.2.1, v7.2.0 and v7.3.0. There is no `.deb` and no Flathub package. The `.nupkg` files are for the Windows updater [V].
- **creality.com** renders its download page with JavaScript and has no static download URLs [V]. GitHub releases, with the asset `digest` as checksum, are the only download source the image uses.

## How the image installs it

`build/fetch-crealityprint.sh <tag>` runs during `docker build` [V, code]:

1. Rejects a tag that isn't a plain `vX.Y.Z`.
2. Reads `/releases/tags/<tag>` from the GitHub API. CI passes a token as a build secret to avoid the anonymous limit of 60 requests an hour.
3. Keeps assets matching `^CrealityPrint-V[0-9.]+-x86_64-Release\.AppImage$` and takes the highest build number. No match fails the build.
4. Downloads the asset and compares its sha256 with the GitHub asset `digest`. A missing digest or a mismatch fails the build.
5. Extracts it with `--appimage-extract` (no FUSE needed) and moves it to `/opt/crealityprint`. The extracted directories are 0700, so they are made 0755 for the non-root user [V]. Nothing else in the AppImage changes.
6. Runs `ldd` on `bin/CrealityPrint` with the library path `AppRun` uses, and fails if any library is `not found`.
7. Copies the app's `CrealityPrint.png` to `/usr/share/selkies/www/icon.png` (the Selkies favicon and PWA icon), and writes the tag and URL to `/build_version`.

The `Dockerfile` pins `ARG CREALITYPRINT_VERSION=v7.3.2`. Renovate proposes each new plain `vX.Y.Z` release, prereleases included, as its own PR. The CI smoke test checks that the `CrealityPrint` process starts as `abc` and stays up [V, code].

## Inside the AppImage

Measured on 7.3.1 [V]:

- **Size.** 512 MB extracted. `resources/` is about 280 MB: `profiles` 81 MB, `web` 62 MB, `fonts` 36 MB, `images` 31 MB, `creality_models` 30 MB, `calib` 20 MB, `i18n` 15 MB, plus shaders, printers, certificates and more.
- **`bin/CrealityPrint`.** A 236 MB x86-64 PIE, not stripped, with debug info. Built with GCC 13.3.0 and clang 18.1.3 from Ubuntu 24.04. Its highest glibc symbol version is `GLIBC_2.38`; Debian trixie has 2.41.
- **Bundled libraries in `usr/lib/`.** `libGLU`, `libGLdispatch`, `libOpenGL`, `libLerc`, `libasound`, `libexpat`, `liblzma`, `libmspack`, `libopus`, pango 1.52.2 (`libpango`, `libpangocairo`, `libpangoft2`, `libpangoxft`), `libspeexdsp`, `libsrtp2`, `libusrsctp`, `libx264` and `libz`. GTK, WebKitGTK, cairo, harfbuzz and GStreamer core come from the host.
- **FreeType.** The binary links FreeType statically and exports its `FT_*` symbols. With a variable font as the GTK UI font, the host's cairo/pango and the app's FreeType share font objects and crash the app at start (#607, #621, #637; a fix was pending as PR #661 as of 2026-11-21) [V, issues]. The base has no variable UI font; `sans-serif` is Noto Sans [V].

`AppRun` is a short bash script [V, 7.3.1 and upstream source]:

- `LD_LIBRARY_PATH="$DIR/bin:$DIR/usr/lib"`. It overwrites any value from outside (upstream PR #539 to append it was open as of 2026-11-21).
- `LC_ALL=C`, to avoid a segfault on systems with unexpected locale data.
- If an NVIDIA GLX library is installed but the boot GPU isn't NVIDIA, it sets `__GLX_VENDOR_LIBRARY_NAME=mesa`, unless that is already set (see [gpu.md](gpu.md)).
- `exec "$DIR/bin/CrealityPrint" "$@"`.

## Libraries the image provides

`ldd` on the bare base image [V]:

| Missing on the base | Debian package |
|---|---|
| `libwebkit2gtk-4.1.so.0` | `libwebkit2gtk-4.1-0` |
| `libjavascriptcoregtk-4.1.so.0` | `libjavascriptcoregtk-4.1-0` (a dependency of the above) |
| `libsoup-3.0.so.0` | `libsoup-3.0-0` (a dependency of the above) |

- With `libwebkit2gtk-4.1-0` installed, nothing is missing, and no bundled library has unresolved dependencies [V].
- The base already has GTK3, cairo, harfbuzz, GStreamer core (`libgstreamer`, `libgstbase`, `libgstvideo`), glvnd with Mesa 25.0.7, NSS, D-Bus and libtiff [V].
- Libraries reported missing upstream on other distros cause no trouble here: `libthai` (#664) and `libbz2.so.1.0` (#650, #566) resolve, `libx264` and `libmspack` are bundled, and `libOSMesa` (#393) is not linked [V, ldd]. `libOSMesa`, `libGLES_CM`, `libiomp5` and two TBB libraries appear only as strings in the binary, probably optional probes, and none was needed at runtime [V strings, I purpose].
- **GStreamer.** The app links GStreamer core. WebKit pulls in `gstreamer1.0-plugins-base` and `-good` as hard dependencies. The optional plugin packages are not installed: the app and both camera paths work without them (see [printers.md](printers.md)) [V].
- **Locale.** No locales are generated, because `AppRun` forces `LC_ALL=C` [V: the app runs fine]. The UI language is `app.language` in `Creality.conf`. On a first run the app derives it from `LANG` and saves it (`en_US` in tests) [V]. Other languages on first run are untested [I].

## How it starts

- **Chain** [V]: labwc runs its autostart file, which the base copies once from the image's `/defaults/autostart_wayland` into `/config/.config/labwc/autostart`. It runs `/usr/local/bin/crealityprint`. That script exports `GDK_BACKEND=x11` and runs `/opt/crealityprint/AppRun`. Both desktop menus call the same launcher.
- **Display.** In Wayland mode (`PIXELFLUX_WAYLAND=true`) the app is an X11 client on Xwayland `:0`, inside labwc. The container env says `DISPLAY=:1` (the X11-mode default), so every helper that talks to the app sets `DISPLAY=:0` itself [V].
- **Why X11.** Native Wayland has open upstream bugs: no filament popup (a comment in #552), an "Add printer" dialog that spins forever (#478) and broken HiDPI scaling (#440). Creality's own Debian 13 guide (below) also sets `GDK_BACKEND=x11`. The setting is not A/B-tested in this image [I].
- **Process environment** [V]: user `abc`, `HOME=/config`, `XDG_RUNTIME_DIR=/config/.XDG`, `LC_ALL=C`, `GDK_BACKEND=x11`, `DISPLAY=:0`, `XDG_CURRENT_DESKTOP=labwc:wlroots`. The image also sets `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`; without a CA path the app reports "not connected to the internet" (#452) [V, issue].
- **Processes** [V]: `CrealityPrint` plus one `WebKitWebProcess` and one `WebKitNetworkProcess` per embedded web view (4 of each at idle).
- **Sandboxing.** No `seccomp=unconfined` is needed. WebKit's `bubblewrap` is installed as a dependency. Whether WebKit actually sandboxes is unknown [V start, I sandbox].
- **Logs.** The app's stdout and stderr don't reach `docker logs`, because the base sends labwc's output to `/dev/null` (see [base-image.md](base-image.md)). Each process writes `log/debug_<date>_<pid>.log.0` in the data directory (`/config/.config/Creality/Creality Print/7.3/`, see [persistence.md](persistence.md)) [V]. The binary has log-cleanup code, so old logs shouldn't pile up [I].
- **Restarting only the app.** There is no s6 service for the app. Start it again from the desktop's right-click menu, or as `abc` with `DISPLAY=:0 /usr/local/bin/crealityprint`. The idle-quit daemon starts it the same way (see [idle-quit.md](idle-quit.md)).
- **Harmless log noise** [V]: `OnInit memory total_bytes 0` (the app can't read memory info in the container; any effect on auto-tuning is unknown [I]); `Unable to init GLAD OpenGL loader` three times at start, with and without a GPU.
- **Internal HTTP server.** The app serves `127.0.0.1:13666` (it tries up to 19 higher ports if that one is busy), on loopback only. It relays printer camera video to the web views, serves the device-manager page (`…/deviceMgr/index.html?…&port=13666`) and receives third-party login callbacks. It is not reachable from outside the container [V, source and app log].

## Environment variables the app reads

From the source [V]. The image sets none of them.

- `CREALITY_WEBVIEW_HARDWARE_ACCELERATION=never|default|auto` sets WebKit's hardware-acceleration policy. Below WebKitGTK 2.42 it is always `never`; the base has 2.54.
- On Wayland the app sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` itself, but not on X11. Here it runs as an X11 client, so it doesn't [I]. Elsewhere users fix blank or black web panels with it or with `WEBKIT_DISABLE_DMABUF_RENDERER=1` (#637). None were seen in this image's tests [V].
- With more than one `/dev/dri/renderD*` node the app sets `DRI_PRIME=1`. If `/proc/driver/nvidia/version` exists, it sets `__NV_PRIME_RENDER_OFFLOAD=1` and `__GLX_VENDOR_LIBRARY_NAME=nvidia` (on X11). GPU behaviour is in [gpu.md](gpu.md).
- `XDG_CONFIG_HOME` (else `~/.config`) is the root of the data directory (see [persistence.md](persistence.md)).

## Single instance and opening files

What the 7.3.1 source does (`InstanceCheck.cpp`, `Plater.cpp`) [V]:

- **The bus name.** Every first instance registers `io.github.crealityofficial.CrealityPrint.InstanceCheck.Object<hash>` on the session bus, whatever `single_instance` says (`OtherInstanceMessageHandler::listen()`). `<hash>` is a hash of the executable path, not a version. The object path is `/io/github/crealityofficial/CrealityPrint/InstanceCheck/Object<hash>`, and the method is `AnotherInstance` with one string argument.
- **`single_instance`** (an `app` key in `Creality.conf`, default `false`) only decides whether a *new* process sends its arguments to that name and exits (`instance_check()`). The app reads it only at start. The `--single-instance` command-line flag is rejected by the 7.3.1 parser ("Invalid option") [V].
- **With `single_instance` off,** a second process becomes a full second app with its own window, over the first one, and both share one config. It also can't take the bus name the first one holds; it logs "Not primary owner of DBus name" [V]. The image therefore never starts a second instance next to a running one.
- **The message** is the new process's argv joined with `;`. Each argument is quoted like `escape_strings_cstyle()` (`libslic3r/Config.cpp`) does: in double quotes when it holds `;`, whitespace, `"` or `\`, with `\` and `"` escaped. A space-joined string is accepted on the bus but ignored, because it all counts as argv[0] [V].
- **`handle_message()`** skips argv[0], keeps arguments that are existing paths, and posts `EVT_LOAD_MODEL_OTHER_INSTANCE`. The plater raises the main window and calls `Plater::load_files()`, the same entry point as a drop onto the window:
  - a single non-3MF file: an undo snapshot ("Load File: …"), then the model is **added to the current plate** at the bed centre, with no auto-arrange. Unsaved work is kept [V];
  - a single 3MF: `open_3mf_file()`. On a non-empty plate the "Drop project file" dialog offers *Open as project* or *Import geometry only* (the default). *Open as project* asks to save unsaved changes first [V];
  - G-code: `load_gcode()`, preview only. Models mixed with G-code are refused with an info box.
- **No option chooses "import" over "open as project" on the command line.** Files passed to a first instance open as its startup project. A `crealityprintlink://open/` argument forces forwarding; the image doesn't use it.
- **The session bus** comes from X11 autolaunch on `:0` (`dbus-x11`). The system bus is off in this image, and the app doesn't need it [V].
- **The instance lock** is `cache/<hash>.lock` in the data directory (`fcntl`). A lock left by a killed app is harmless; the next start runs normally [V].

The image's `/usr/local/bin/crealityprint-open <file>…` finds the bus name with `ListNames`, builds the message as above and calls `AnotherInstance` on `DISPLAY=:0`. It exits 1 when no app is on the bus. The upload watcher built on it is in [files.md](files.md).

## First run

- On an empty data directory the app shows its onboarding, in WebKit web views [V]:
  1. software mode: AI Edition (Beta) or Professional Edition (preselected);
  2. login area: Asia-Pacific, Chinese Mainland, Europe, North America or Others;
  3. "Welcome to Creality Print": log in to Creality Cloud, connect a printer via LAN, or skip;
  4. a printer picker, with Creality and other vendors' models;
  5. the "User Experience Improvement Program" window (telemetry): Cancel or Join in.
- The answers go to `Creality.conf` (`region`, `language`, `firstguide`, `is_first_install`) and `privacyInfo.json` [V]. The image's first-run seed always declines step 5, and with `CP_PRINTER` it skips the wizard (see [persistence.md](persistence.md)).
- The app needs a working WebKit for all of this: the wizard is not native.

## Cloud, updates and telemetry

- **Creality Cloud login** is an embedded WebKit dialog (`ZUserLogin`) with QR code and email/password [V, source; not tested with a real account]. Google/Apple login calls `wxLaunchDefaultBrowser`, i.e. a browser *inside* the container, and the OAuth callback goes to the app's `localhost:13666`. The image has no browser, so only email/QR login works [V source, I outcome].
- **The login token** is stored in `Creality.conf` (`cloud.user_id`, `cloud.token`) and `user_info.json`. The region picks the API host (`api.crealitycloud.com` or the `.cn` one) [V, source].
- **Device identity.** Cloud requests send `__CXY_DUID_`, which the Windows code fills with the MAC address. Whether Linux does too, and whether a re-created container (new MAC) then has to log in again, is unknown [I].
- **Remote web content.** Some panels (Home, model library, the AI assistant at `cxagent.crealitycloud.com`, `makenow.crealitycloud.com`) load from Creality's servers. A Cloudflare challenge once blanked them for a day and made `WebKitWebProcess` spin (#623) [V, issue].
- **Cloud presets.** Logged-in users have lost user filament presets when cloud sync failed (#492) [V, issue].
- **App update check.** At start, `PresetUpdater::sync()` → `sync_version()` → `check_new_version_cx()` asks the Creality Cloud API (`softwareSearch`, platform 2 = Linux) for a newer version. `enabled_version_check` is hard-coded to `true`, so no setting turns it off; the user can only dismiss it or skip a version (`app.skip_version`; `check_stable_update_only` limits it to stable releases). On Linux the update only opens the download URL in a browser. It never replaces the AppImage, unlike the Windows updater [V, source]. Users update by pulling a new image.
- **Profile updates.** With `sync_system_preset` on, the app downloads newer vendor profiles into the data directory (`ota/`, `system/`) and offers them in a toast ("Detected a new parameter package to update…") [V].
- **Telemetry.** The app posts analytics to a `crealitycloud.com` collector. A `stealth_mode` key is inherited from BambuStudio; whether Creality Print honours it is unchecked [V strings, I behaviour].

## Command line

The image starts the app with no arguments, or with files from the upload watcher. Useful to know:

- `--cli` slices headless with the extracted AppImage [V by third-party projects, not tested here]. `--slice` alone is ignored in 7.3.0 and the GUI hangs at start (#634) [V, issue].
- `--datadir <dir>` appends `/Creality Print/<epoch>` and skips the data-directory migration [V, source]. The image doesn't use it (see [persistence.md](persistence.md)).
- `--single-instance` is rejected (see above).

## Known upstream issues that matter here

| Issue | Problem | In this image |
|---|---|---|
| #607, #621, #637 | Variable UI font crashes the app at start | Base has none; don't add one. CI smoke and e2e tests catch it |
| #610 | The generic AppImage fails on Ubuntu 22.04-based systems | Trixie has glibc 2.41 and webkit2gtk-4.1 [V] |
| #567 | Preferences crash with pango 1.57 (Fedora 44) | 7.3.2 bundles pango 1.52.2 and puts it first; on Ubuntu 26.04 (pango 1.57), Preferences, a slice and Preview work [V, Rust Selkies trial]. See [selkies-rust.md](selkies-rust.md) |
| #452 | "Not connected to the internet" without a CA path | `SSL_CERT_FILE` is set |
| #440, #478, a comment in #552 | Native Wayland: HiDPI scaling, "Add printer" spins, filament popup missing | App runs on Xwayland |
| #589, #654 | Fixed-size dialogs clipped, OK button missing; a fix is announced for a release after 7.3.2 | A small browser window may hit it; use at least 1080p [I] |
| #615 | `WebKitWebProcess` aborts on quit | Harmless |
| — (seen here) | The unsaved-project backup is skipped when its `lock.txt` PID belongs to a running process, which after a `docker restart` is often the app itself | See [persistence.md](persistence.md) |
| — (seen here) | After restoring unsaved work, the app redraws at about 60 frames/s until the first click in the 3D view (11 cores without a GPU) | Click once into the view |
| #604 | Intel GPU hang after slicing on Mesa 26 | See [gpu.md](gpu.md) |
| #547 | Low camera frame rate on Linux | See [printers.md](printers.md) |
| #552, #576 | Preset settings read-only in 7.1.0–7.2.0, fixed in 7.2.1 | Don't build those versions |

## Footprint

Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, 16 cores, 31 GiB RAM. Unless noted: a research build of 7.3.1 on the `debiantrixie` base of 2026-11-21 (`ls153`), no GPU passed in, no browser connected [V].

| Measure | Value |
|---|---|
| Base image | 3.7 GB on disk, 934 MB compressed |
| AppImage layer | 538 MB |
| Image with the optional GStreamer plugins | 5.02 GB on disk, 1.29 GB compressed |
| Image without them, like the shipped image | 4.77 GB. The shipped image also adds `inotify-tools`, `jq` and `mesa-utils`; its size was not re-measured |
| First build (apt, 190 MB download, extract) | 1 min 14 s |
| `docker run` → web UI answers | 1.3 s |
| `docker run` → `CrealityPrint` process | 3.0 s |
| `docker run` → main window, fresh `/config` | 4.2 s |
| App start → main window, existing config (shipped image, host with an Intel UHD 630) | about 1.6 s with a warm page cache, about 5 s in e2e runs |
| Idle after a restart | 1.8–2.9 % CPU (of one core), 2.15 GiB (`docker stats`, includes page cache), 413 PIDs |
| RSS at idle | selkies 875 MB, `CrealityPrint` 786 MB, `WebKitWebProcess` 449 + 309 + 209 + 209 MB |

Plan about 2 GiB of RAM per container, more while slicing. Selkies' memory grows with the streamed resolution [I]. CPU while orbiting and long-session memory are in [gpu.md](gpu.md); idle numbers with the app running and closed are in [idle-quit.md](idle-quit.md).

## Upstream Linux support and prior art

- Creality's README covers only "Linux (Ubuntu)" with `chmod +x` on the AppImage. Nothing upstream covers Docker, headless or web use, and no upstream issue asks for it beyond a build-in-Docker report (#389) [V]. Creality staff actively triage Linux issues (as of 2026-11) [V].
- Creality's wiki page "Creality Print on ChromeOS" (Debian 13, V7.3.0, https://wiki.creality.com/en/software/6-0/chrome-os) lists the host packages `libopengl0 libglu1-mesa libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libfuse2t64`, and `GDK_BACKEND=x11` for the GPU. In this image the GL libraries are bundled, JavaScriptCore comes with WebKit, and extraction replaces FUSE [V].
- As of 2026-11-21 there was no maintained Creality Print web container, and linuxserver has none. The few community images broke at asset selection or re-extracted the AppImage into `/config` on every start. Headless projects run the extracted AppImage with `--cli`. This image follows linuxserver's docker-orcaslicer instead (see [decisions.md](decisions.md)) [V].
