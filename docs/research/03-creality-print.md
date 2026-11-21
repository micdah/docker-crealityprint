# 03 — The Creality Print application (desk research)

*Researched 2026-11-21.* Each claim is marked **verified** (I saw it in the source, the official release metadata or an official/maintainer statement) or **inferred** (deduced, needs a hands-on check).

Source snapshot: `CrealityOfficial/CrealityPrint` at tag `v7.3.2`, which is commit `6262848e302b8c0d593f2b341cd01310aa2f58a1`, the same as `master` HEAD on 2026-11-13 ("sync: update sources from release-261130 after v7.3.1"). Tag `v7.3.1` is commit `254250c015a5f8c5b9bf3742e89066c8a7095565`. Unless stated otherwise, all file paths below are relative to the repo root at `v7.3.2`.

---

## 1. TL;DR for the image builder

| Topic | Answer |
|---|---|
| Latest **stable** release | **v7.3.1** (build `7.3.1.6378`, 2026-10-31). `releases/latest` returns it. **verified** |
| Latest release overall | **v7.3.2** (build `7.3.2.6412`, 2026-11-13). It is flagged `prerelease: true` on GitHub, yet creality.com/eu/download shows it as the current download (dated Nov 15, 2026). **verified** |
| Asset to use | `CrealityPrint-V<ver>.<build>-x86_64-Release.AppImage` (x86_64 only), e.g. `https://github.com/CrealityOfficial/CrealityPrint/releases/download/v7.3.1/CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage` (191,511,032 bytes). **verified** |
| arm64 | No arm64 AppImage. An aarch64 **flatpak** exists only for v6.2.1, v7.2.0 and v7.3.0 (not v7.3.1 or v7.3.2). Issue #538 asks for arm builds. **verified** |
| AppImage build host | Ubuntu **24.04** (Jenkins agent `ubuntu24.04`), so it targets **glibc 2.39** (inferred) and **webkit2gtk-4.1 / libsoup-3** (maintainer-confirmed for 7.3.1). |
| Lineage | A fork of **OrcaSlicer** (itself a fork of BambuStudio, which forks PrusaSlicer). The About dialog says "based on PrusaSlicer and BambuStudio". Linux builds appeared from 5.1.6. |
| License | **AGPL-3.0** (`LICENSE.txt`; the GitHub API reports `AGPL-3.0`). **verified** |
| Config dir | `$XDG_CONFIG_HOME/Creality/Creality Print/<DATA_VERSION>/`, which defaults to `~/.config/Creality/Creality Print/7.3/` in 7.3.x and was `.../7.0/` for 7.0–7.2.x. **verified** |
| Per-version? | Yes, the directory is per "data epoch". 7.3 introduced a one-time transactional migration from `7.0` (or `6.0`). Persist the whole `~/.config/Creality` tree. **verified** |
| LAN discovery | **mDNS/DNS-SD** multicast (`_services._dns-sd._udp.local`, 224.0.0.251:5353), matching service names that start `_creality…` / `_CXSWBox…`. Bridge networking breaks it, but adding a printer by IP is possible. **verified** |
| Printer control | WebSocket `ws://<ip>:9999` (Creality OS / K1-class), or `wss://<ip>:<wssPort>` for newer "secure" printers (port from `https://<ip>:443/info`). **verified** |
| Camera | WebRTC signalling at `http://<ip>:8000/call/webrtc_local`, RTSP `rtsp://<ip>/ch0_0`, or MJPEG `http://<ip>:8080/?action=stream`. It is decoded in-process and re-served on `127.0.0.1:13666`. **verified** (mostly) |
| Proprietary network plugin | The Bambu plugin code is inherited but **disabled** (`on_init_network()` returns `false`). Nothing is downloaded at runtime. **verified** |

---

## 2. Linux distribution

### 2.1 Release history and Linux formats (GitHub releases API, 37 releases)

I enumerated the releases with `gh api 'repos/CrealityOfficial/CrealityPrint/releases?per_page=100' --paginate` on 2026-11-21. **verified**

| Tag | Published | GH prerelease | Linux assets |
|---|---|---|---|
| v7.3.2 | 2026-11-13 | **true** | `CrealityPrint-V7.3.2.6412-x86_64-Release.AppImage`, `CrealityPrint-Linux-flatpak_V7.3.2-Release_x86_64.flatpak` |
| v7.3.1 | 2026-10-31 | false | `CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage`, `CrealityPrint-Linux-flatpak_V7.3.1-Release_x86_64.flatpak` |
| v7.3.0 | 2026-09-24 | false | **three** AppImages, `CrealityPrint-V7.3.0.{6149,6151,6157}-x86_64-Release.AppImage` (re-spins, newest = 6157); `CrealityPrint-Linux-flatpak_V7.3.0-Release_x86_64.flatpak`; `CrealityPrint-V7.3.0-linux-aarch64-Release.flatpak` |
| v7.2.1 | 2026-08-04 | false | `CrealityPrint-V7.2.1.5476-x86_64-Release.AppImage`, flatpak x86_64 (the release also carries the 7.2.2 Windows/mac hot-fix) |
| v7.2.0 | 2026-06-30 | false | `CrealityPrint-V7.2.0.5226-x86_64-Release.AppImage`, **`CrealityPrint-ubuntu2204-V7.2.0.5251-x86_64-Release.AppImage`**, `CrealityPrint-ubuntu2404-wayland-V7.2.1.5276-x86_64-Beta.AppImage`, `CrealityPrint-Linux-flatpak-wayland-V7.2.1.5371-x86_64-Beta.AppImage`, two flatpaks, aarch64 flatpak |
| v7.1.1 | 2026-04-28 | false | `CrealityPrint-V7.1.1.4472-x86_64-Release.AppImage` only |
| v7.1.0 / v7.0.1 / v6.3.x / v6.2.x | … | false | **two variants**: `CrealityPrint_Ubuntu2004-V…` and `CrealityPrint_Ubuntu2404-V…` (casing varies: `ubuntu2004`/`Ubuntu2004`), plus flatpak |
| v6.2.2-Beta, v6.2.1-Beta, v6.1.1-Beta | … | **false** (!) | Beta AppImages, not flagged as prerelease |
| v6.1.2, v6.2.0 | … | false | `CrealityPrint-V…-x86_64-Release.AppImage` + `CrealityPrint_Ubuntu2404-V…` |
| `tools` | 2025-05-20 | true | not a release (WebView2 installer, a script) |

Key observations:
- **Variants.** From v6.2.1 to v7.1.0 there were "Ubuntu2004" and "Ubuntu2404" builds, similar to OrcaSlicer's webkit-4.0/4.1 split. From v7.1.1 on only one generic AppImage remains, and it **is the Ubuntu 24.04 build**. The Jenkins Linux stage runs on agent label `ubuntu24.04` and has `UPLOAD_NAME="${APP_NAME}_Ubuntu2404-V${VERSION}-x86_64-${RTYPE}.AppImage"` (`Jenkinsfile` lines 267–272, 350–351, 407; **verified**). Issue #610 confirms that the generic 7.2.1 AppImage fails on Linux Mint 21 (Ubuntu 22.04 base). Users had to use the `ubuntu2204` build that existed only for 7.2.0. **The container base must therefore be Ubuntu 24.04 (noble) or newer, or Debian trixie.** **inferred** (strongly)
- **No `.deb`** on GitHub releases, although `BuildLinux.sh -e` / `BuildLinuxDeb.sh.in` exist. **verified**
- **Flathub: not published.** `flathub/io.github.crealityofficial.CrealityPrint` returns 404, and issues #472 and #538 still ask for it. A third-party "FlatPark" repo repackages the official AppImage (issue #629). The flatpak bundles on GitHub use runtime `org.gnome.Platform` **50** (`flatpak/io.github.crealityofficial.CrealityPrint.yml`). **verified**
- **The Windows `.nupkg` files** are Squirrel delta/full packages for the Windows hot-update (7.1.1+). They are irrelevant to Linux. **verified**
- **Build numbers.** The 4th version component (e.g. `6378`) is `git rev-list HEAD --count` on Creality's internal repo (`scripts/build_package_linux.sh`). It is not monotonic per tag on the public repo. **verified**

### 2.2 creality.com CDN

`https://www.creality.com/eu/download` (fetched 2026-11-21) shows Creality Print **v7.3.2.6412, Nov 15 2026**, for Windows, macOS (Apple/Intel) and Linux. The page is JS-rendered, so the fetched copy contained **no static download URLs or CDN hostnames**. The in-app updater obtains its download URL from the Creality Cloud API (`POST https://api.crealitycloud.com/api/cxy/search/softwareSearch`, body `{"type":7,"palform":2}`, where `palform` 2 = Linux; `GUI_App::check_new_version_cx`, `src/slic3r/GUI/GUI_App.cpp` ~L10421). That API requires client headers (`__CXY_*`, see `GUI_App::get_extra_header` L3863), so I did not query it. **Recommendation: use GitHub releases as the only download source.** They are the canonical, versioned and checksummed (via the GitHub asset `digest`) URLs. **inferred**

### 2.3 Automated version detection for CI

The tag format is `vMAJOR.MINOR.PATCH`, with historical `-Beta` suffixes. The GitHub `prerelease` flag is **not reliable**: old `-Beta` tags are `false`, while v7.3.2, which creality.com treats as current, is `true`. **verified**

Recommended logic:
1. Use `/releases/latest`, which excludes prerelease and draft releases, as the stable channel.
2. Additionally reject tag names that do not match `^v[0-9]+\.[0-9]+\.[0-9]+$`.
3. Choose the asset with a regex, and **take the highest build number**, because v7.3.0 shipped three AppImages.

```bash
# Stable tag (GitHub "latest", i.e. non-prerelease, non-draft)
gh api repos/CrealityOfficial/CrealityPrint/releases/latest --jq .tag_name          # -> v7.3.1

# Without gh/auth (60 req/h unauthenticated):
curl -fsSL https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases/latest \
  | jq -r '.tag_name'

# Pick the generic x86_64 Release AppImage with the highest build number
curl -fsSL https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases/latest \
  | jq -r '[.assets[]
            | select(.name | test("^CrealityPrint-V[0-9.]+-x86_64-Release\\.AppImage$"))]
           | sort_by(.name | capture("V(?<v>[0-9.]+)-").v | split(".") | map(tonumber))
           | last | .browser_download_url, .digest'

# Strictly-stable tag list (skip prerelease AND any tag with a suffix):
gh api 'repos/CrealityOfficial/CrealityPrint/releases?per_page=30' \
  --jq '[.[] | select(.prerelease|not) | select(.draft|not)
         | select(.tag_name|test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].tag_name'
```

The version string for the image tag is `${tag#v}`. Optionally append the build number from the asset name (e.g. `7.3.1.6378`). Note that the Linux asset-name pattern changed in the past (`CrealityPrint_Ubuntu2404-V…`), so the CI job should **fail loudly if no asset matches** rather than silently picking something else. **inferred**

---

## 3. Lineage, source and license

- **Upstream: OrcaSlicer (SoftFever)**. **verified** from these markers:
  - The README still contains SoftFever text and links to `SoftFever/OrcaSlicer` downloads.
  - `SECURITY.md` names `softfeverever@gmail.com`.
  - Deps use `orcaslicer_add_cmake_project` and `https://github.com/SoftFever/Orca-deps-wxWidgets` tag `v3.3.2` (`deps/wxWidgets/wxWidgets.cmake`).
  - `flatpak/io.github.softfever.OrcaSlicer.yml` is present, and `flatpak/README.md` says "basically a copy of com.bambulab.BambuStudio".
  - The source has 255 `// Orca` comments.
  - The About dialog says "CrealityPrint is based on PrusaSlicer and BambuStudio" (`src/slic3r/GUI/AboutDialog.cpp` L157).

  The fork point is CP 5.0 (April 2024), whose release notes mention compatibility with Prusa/Orca presets. The Linux version arrived in 5.1.6 (Nov 2024). The exact OrcaSlicer base version is not stated anywhere. The 2024 timing suggests OrcaSlicer ~2.0 / 2.1 **(inferred)**. Since then the code base has diverged heavily: wxWidgets 3.3.2, an "AI Edition", a CEF/WebView2 front-end on Windows, and a large Vue web UI in `resources/web/`.
- **Build system: CMake + Ninja**. Dependencies come from the superbuild `deps/CMakeLists.txt` (Boost, OpenCV, OCCT, CGAL, OpenVDB, FFmpeg, paho-mqtt, aliyun-oss SDK, `metartc` WebRTC, breakpad, Pango, wxWidgets 3.3.2 static GTK3). The Linux entry point is `BuildLinux.sh`:
  - `sudo ./BuildLinux.sh -u` installs the apt deps.
  - `./BuildLinux.sh -dsi` builds deps, then the slicer, then the AppImage.

  Per-distro package lists live in `linux.d/` (`debian` = Ubuntu < 24.04, `debian2` = Ubuntu ≥ 24.04). The release packaging script is `scripts/BuildLinux_Package.sh`, and the AppImage recipe is `src/platform/unix/BuildLinuxImage.sh.in` + `build_appimage.sh.in`. There is also a dev `Dockerfile` (Ubuntu 22.04, inherited from Orca) that builds from source. **verified**
- **Closed parts.** `deps/CR_CLOSED/` (e.g. `CR_FILLTENSOR`), `CR_TPMS` and `CR_KM_RECIPE` are dependency recipes. At least `CR_CLOSED` suggests prebuilt or closed components, so building fully from source may not be possible. **inferred**; I did not investigate further, because we will use the binary.
- **License: AGPL-3.0** (`LICENSE.txt`). **verified** Implications for redistributing the unmodified AppImage inside a Docker image **(inferred; not legal advice)**:
  - Redistribution is allowed, but under AGPL/GPL §6 we must provide or offer the Corresponding Source. Pointing to Creality's public repo at the matching tag is the common practice (linuxserver/docker-orcaslicer does the same). Ideally put the tag/commit in an image label and the README.
  - Ship or keep the license text (it is inside the AppImage `resources/` tree).
  - The AGPL §13 "network interaction" clause applies to *modified* versions offered over a network. Exposing the unmodified GUI through Selkies does not modify the program. If we ever patch the binary or its resources, we must offer the source of our modifications to the remote users.
  - Bundled third-party libraries carry their own licenses (e.g. x264 is GPL, Pango is LGPL; `usr/share/licenses/pango/COPYING` is copied in).
  - The trademark/branding "Creality" is a separate issue from the copyright license. Avoid implying an official image.

---

## 4. Runtime dependencies (desk side)

The AppImage is **not self-contained**. `BuildLinuxImage.sh.in` copies only the main binary plus `resources/`, and `build_appimage.sh.in` adds a handful of `.so` files to `usr/lib/`. **verified**:

`libpango*` (the app builds its own Pango to avoid a 1.57.0 crash), `libusrsctp`, `libsrtp2`, `libasound`, `libopus`, `libspeexdsp`, `libz`, `liblzma`, `libx264`, `libGLU`, `libOpenGL`, `libGLdispatch`, `libexpat`, `libLerc`, `libmspack`.

Everything else comes from the **host**: wxWidgets is linked statically, but GTK and WebKit are dynamic. The AppRun wrapper sets `LD_LIBRARY_PATH="$DIR/bin:$DIR/usr/lib"` and `LC_ALL=C`, and handles NVIDIA GLX vendor selection.

| Dependency | Version/notes | Status |
|---|---|---|
| glibc | Built on Ubuntu 24.04 → expect symbol versions up to **GLIBC_2.38/2.39** | inferred; hands-on should run `objdump -T` |
| GTK | GTK **3** (`-DSLIC3R_GTK=3`, `-DDEP_WX_GTK3=ON`) | verified |
| WebKitGTK | **webkit2gtk-4.1** (libsoup-3). `linux.d/debian2` installs `libwebkit2gtk-4.1-dev`; the flatpak CMake uses `pkg_check_modules(webkit2gtk-4.1)`; a maintainer comment on #400 (Nov 2026) says "The current AppImage (7.3.1) links against libsoup-3.0 only". The ≤6.2.0 builds mixed libsoup2/3 (#394, #400). | verified |
| GStreamer | `libslic3r_gui` links `gstreamer-1.0` + `gstreamer-base-1.0` ("for bambu:/// support", `src/slic3r/CMakeLists.txt` ~L1086). The flatpak adds `gst-plugins-good` (jpeg, gtk3 sink) for the live view. For the container, install `libgstreamer1.0-0`, `libgstreamer-plugins-base1.0-0`, `gstreamer1.0-plugins-good`, and probably `-bad`/`-libav` (WebKit media) | verified (link) / inferred (plugins) |
| OpenGL | Minimum **OpenGL 2.0** (`OpenGLManager.cpp` L454/476); uses ≥3.0 features when available. Under X11 it calls `wxGLCanvas::PreferGLX()` (`src/CrealityPrint.cpp` ~L262). Mesa llvmpipe should satisfy this. | verified |
| OSMesa / EGL | Build deps include `libosmesa6-dev` and `eglexternalplatform-dev`. Issues #393/#411 (6.x) reported a missing `libOSMesa`. | verified (build) / hands-on to check runtime |
| Other host libs | `libsecret-1`, `libdbus-1`, `libudev`, `libcurl`/`libssl`? (deps build their own CURL/OpenSSL statically with `SLIC3R_STATIC=1`), `fontconfig`, `libfribidi`, `libharfbuzz`, `libthai` (#664: not bundled in 7.3.1), `libbz2.so.1.0` (#650: Fedora lacks the Debian SONAME; a fix was announced for a release *after* 7.3.1), `libx264` (bundled), `libdeflate`, `libtiff`, `libLerc` | partially verified; ldd needed |
| FUSE | The AppImage is built with current `appimagetool` (type-2 runtime). In Docker, use `--appimage-extract` and run `squashfs-root/AppRun`, as Orca's image does. The recipe itself uses `--appimage-extract-and-run` inside Docker. | verified (recipe) / inferred (approach) |
| Locale | AppRun forces `LC_ALL=C`; the flatpak entrypoint uses `LC_ALL=C.UTF-8`. Issue #373: a missing English locale prevented startup. Install `locales` and generate `en_US.UTF-8`. | verified / inferred |

Notable environment knobs found in the source (**verified**):
- `CREALITY_WEBVIEW_HARDWARE_ACCELERATION=never|default|auto` (`src/slic3r/GUI/Widgets/WebView.cpp` ~L779). On WebKitGTK < 2.42 hardware acceleration is forced to NEVER.
- On Wayland the app itself sets `WEBKIT_DISABLE_COMPOSITING_MODE=1`, but not on X11 (`src/CrealityPrint.cpp` L224–240). Selkies is X11, so the container may need `WEBKIT_DISABLE_COMPOSITING_MODE=1` and/or `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Users report that this fixes blank or black web panels (#637). The flatpak sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` for NVIDIA.
- If `/dev/dri` has more than one `renderD*` node, the app sets `DRI_PRIME=1`. If `/proc/driver/nvidia/version` exists, it sets `__NV_PRIME_RENDER_OFFLOAD=1` and `__GLX_VENDOR_LIBRARY_NAME=nvidia` (X11). This is relevant when passing GPUs into the container.
- `XDG_CONFIG_HOME` determines the config root (see §6).

---

## 5. Known Linux bugs (GitHub issues, as of 2026-11-21)

Most relevant first. **verified** (issue text):

- **#607 / #621 / #637 – FreeType symbol collision with *variable* fonts (SIGABRT/SIGSEGV at startup).** The binary statically links and *exports* FreeType. When the host's cairo/pango pick a variable font (e.g. `AdwaitaSans`, `opsz`/`wght` axes), two FreeType versions share `FT_Face` and crash. The workaround is a fontconfig that rejects variable fonts, or making a static font (e.g. Noto Sans) the GTK UI font. **Container action: install only static fonts (e.g. `fonts-noto-core`, `fonts-dejavu`), do not install `fonts-adwaita`/Cantarell-VF, or set the GTK font to a static family.** Still open in 7.3.1.
- **#610 – the generic AppImage does not run on Ubuntu 22.04 bases.** Only Ubuntu 24.04+ works (see §2.1).
- **#650 / #566 – `libbz2.so.1.0` missing** on Fedora-family hosts. Not an issue on Debian/Ubuntu. Fixed after 7.3.1.
- **#664 – `libthai.so.0` missing**. Install `libthai0`.
- **#623 – the embedded WebKit Home/cloud panels went blank (a Cloudflare challenge) plus a `WebKitWebProcess` CPU spin.** This was an intermittent server-side problem (2026-09-28/29) and also hit Orca/Bambu.
- **#615 – WebKitWebProcess SIGABRT (heap corruption) on quit** (Flatpak & AUR).
- **#604 – GPU hang / black "Not Responding" window after slicing on Intel iGPU with Mesa 26.0.x.** Suggested test: `LIBGL_ALWAYS_SOFTWARE=1`.
- **#558** – the AppImage does not use hardware-accelerated rendering. **#483** – segfault on Debian + NVIDIA/X11. **#378** – blank viewport (5.x/6.x).
- **#440 – HiDPI 150% scaling breaks the UI** (Wayland). **#570** – the UI breaks with multiple monitors. **#589/#654** – fixed-size dialogs clipped (OK button missing). These matter for Selkies resolution changes.
- **#478 – the "Add printer" dialog spins forever** (Wayland; works in an Xfce/X11 session). **#452** – "Internet unavailable" in AppImage 6.2.0.
- **#492 – user filament presets deleted** when the cloud sync fails while logged in. This is a persistence/offline risk.
- **#552/#565/#576** (fixed in 7.2.1) – the preset UI was read-only on Linux.
- **#443/#571** – process lingers or restarts after close (fixed in 6.2.2/7.2.1).
- **#547** – the Linux camera view has low fps and no audio (Linux uses the in-process decoder → MJPEG path).
- **#544/#473/#451** – Wayland issues. Irrelevant under Selkies/X11.

---

## 6. Config / data directory (persistence)

### 6.1 Path computation — **verified**

- `version.inc` sets `SLIC3R_APP_KEY "Creality"` and `SLIC3R_APP_USE_FORDER "Creality Print"`.
- `CMakeLists.txt` L4 sets `CREALITYPRINT_DATA_VERSION "7.3"` with the comment "Data compatibility epoch; independent of the application release version".
- `GUI_App::init_app_config()` (`src/slic3r/GUI/GUI_App.cpp` ~L3574–3620), on Linux:
  - `root = $XDG_CONFIG_HOME`, or `~/.config` if unset or empty.
  - It calls `set_data_dir(root + "/" + GetAppName())` with `GetAppName() == "Creality"`.
- `set_data_dir()` (`src/libslic3r/utils.cpp` L317–345) appends `"/" + SLIC3R_APP_USE_FORDER + "/" + data_directory_name()`.
- **Result: `${XDG_CONFIG_HOME:-$HOME/.config}/Creality/Creality Print/7.3`**. An `" Alpha"` suffix is added for alpha builds.
- **Before 7.3** (e.g. tags `v7.2.1`, `v6.3.1`), `version_dir = CREALITYPRINT_VERSION_MAJOR + ".0"`, giving `…/Creality Print/7.0` for all 7.0–7.2.x releases and `…/Creality Print/6.0` for 6.x. Issue #607 shows a 7.2.1 log in `~/.config/Creality/Creality Print/7.0/log/`.
- **`--datadir <dir>`** CLI option (`GUI_Init.cpp` L98): it is *not* used verbatim. It also appends `/Creality Print/7.3`, and it marks `m_datadir_redefined`, which **skips the migration**. Prefer `XDG_CONFIG_HOME` or `HOME` over `--datadir`.
- In a linuxserver image with `HOME=/config`, the result is **`/config/.config/Creality/Creality Print/7.3/`**. **inferred**

### 6.2 Upgrade behaviour (per-version dirs)

- **7.3 introduced `DataMigration`** (`src/libslic3r/DataDirectoryMigration.{hpp,cpp}`). On first start of a 7.3.x build, if `…/7.3` is not initialised, it looks for `…/7.0`, then `…/6.0`. It copies, transactionally (it uses staging dir `.7.3.staging-<ts>`, lock `.migration-7.3.lock` and `migration/` reports):
  - `Creality.conf` (plus a `.bak`)
  - `extra_config.json`, `deviceInfo.json`, `user_info.json`, `privacyInfo.json`
  - `user/**` presets (machine/filament/process/local_device; `.cereal` files are skipped)
  - `filament_mixing/`

  It then re-stages `system/` profiles from the bundled `resources/profiles`. It refuses to run while another `CrealityPrint` process is running (it checks `/proc/*/comm`). **verified**
- So a **minor upgrade (7.3.1 → 7.3.2) reuses `7.3`**. A **future epoch bump (e.g. 7.4/8.0) will create a new directory** and presumably migrate again. **The image must persist the parent `~/.config/Creality/` directory, not a versioned subfolder.** The old directory is left in place, so disk use grows. **verified / inferred**
- `CREALITYPRINT_DATA_VERSION` is a CMake cache variable, independent of the app version. Release builds set it in CMake, not per tag. **verified**

### 6.3 What lives inside `…/Creality Print/7.3/` — **verified** (string references to `data_dir()` in `src/`)

| Path | Content |
|---|---|
| `Creality.conf` (+`.bak`) | Main JSON app config: preferences, `region`, `language`, `firstguide/finish`, `is_first_install`, `privacy_version`, `skip_version`, and **`cloud.user_id` / `cloud.token`, i.e. the Creality Cloud login token** (`GUI_App::setUserAccount`, L3892) |
| `user_info.json` | Logged-in user info |
| `deviceInfo.json`, `current_device.json` | **LAN printer list** and the selected device. Persist these so printers added by IP survive restarts |
| `privacyInfo.json`, `launchInfo.json`, `extra_config.json` | Privacy acceptance, launch state |
| `user/<uid or default>/{machine,filament,process}/` | **User presets** (`PRESET_USER_DIR`) |
| `system/`, `vendor/`, `printers/` | System/vendor profiles (seeded from resources, updated online) |
| `log/` | `debug_<date>_<pid>.log`. The process `chdir`s into `log/`. Breakpad minidumps go here too |
| `cache/`, `thumbnail_cache/`, `ota/`, `ota_result.json`, `hms/` | Caches, online profile/"OTA" downloads, update state (`update_state.json` under cache) |
| `plugins/` | Inherited Bambu plugin folder (unused; see §7.6) |
| `cloud_download_data/`, `models/`, `shapes/`, `filament_mixing/`, `cameratools/url.txt`, `automation/` | Misc user and cloud data |

Outside the data dir (**inferred**, WebKitGTK defaults; wx's `SetDataPath` is only applied to the Windows Edge backend in `WebView.cpp` L539):
- WebKitGTK cookies, localStorage and IndexedDB for the embedded web UI → `~/.local/share/<prgname>/` and `~/.cache/<prgname>/`. The web front-end may keep login state there as well. **Persist `~/.local/share` and `~/.cache`, or the whole `$HOME`.** Hands-on should verify the exact directory names.
- The default download path is the `download_path` key, empty by default. Temporary uploads use `fs::temp_directory_path()`.

---

## 7. Container-relevant features

### 7.1 LAN discovery — **verified**

- `cxnet::syncDiscoveryService(prefix)` (`src/slic3r/GUI/print_manage/utils/cxmdns.cpp`, using the `mjansson/mdns` C library `mdns.c`) sends a **DNS-SD service enumeration** (`_services._dns-sd._udp.local.`) over **multicast UDP 5353 (224.0.0.251 / ff02::fb)** on all interfaces and waits ~5 s (`select` timeout).
- It keeps answers whose service names start with `CXSWBox`, `creality` or `Creality`:
  - `_creality<2-digit><4-digit>…` encodes the printer model/ID.
  - `_CXSWBox…` is the older Creality WiFi Box.
- Callers: `PrinterMgrView.cpp` ~L2015/L2170 (device page scan and address correction) and `GUI_App.cpp` ~L9190 (`update_devices_list`).
- Inherited Orca/Prusa `Bonjour.cpp`/`BonjourDialog` (mDNS for OctoPrint-type physical printers) is also present.
- **Docker bridge networking does not forward multicast, so automatic discovery will fail.** The options are `network_mode: host`, macvlan/ipvlan, or an mDNS reflector (e.g. avahi `enable-reflector`), which may or may not help, because the app uses its own raw mDNS sockets rather than avahi. Hands-on should test.
- **Manual add by IP** exists:
  - `LanDeviceProbe` (`print_manage/Device/LanDeviceProbe.cpp`) probes TCP 443/80 and `GET http(s)://<ip>/info` to obtain `wssPort` and `videoPort` for newer secure printers.
  - The `EVT_SHOW_IP_DIALOG` "enter IP" dialog is also available.
  - Plain unicast TCP works fine through bridge NAT.

### 7.2 Printer control and sending G-code — **verified**

- **Control/status.** The Vue device-manager UI (`resources/web/deviceMgr/assets/*.js`) opens a WebSocket directly from WebKit to **`ws://<ip>:9999`** (Creality OS: K1/K1C/K1 Max, Ender-3 V3 family, K2…), or to **`wss://<ip>:<wssPort>`** (default 443) for printers that report `secureConnection`.
- **Upload paths** (`print_manage/RemotePrinterManager.cpp` ~L434–465):
  - `REMOTE_PRINTER_TYPE_KLIPPER4408`: HTTP `POST http://<ip>:80/upload/<file>` (or `https://<ip>:443`) (`Klipper4408Interface.cpp`).
  - `REMOTE_PRINTER_TYPE_CX`: port 80 (`KlipperCXInterface.cpp`).
  - `REMOTE_PRINTER_TYPE_KLIPPER`: Moonraker `POST http://<ip>:<port>/server/files/upload`, port per printer (typically 7125) (`KlipperInterface.cpp`).
  - `REMOTE_PRINTER_TYPE_LAN` (CXSWBox / older): **FTP** `ftp://<ip>/mmcblk0p1/creality/gztemp/<file>` (`LanPrinterInterface.cpp` L90). Passive FTP through NAT should work; active FTP would not. **inferred**
  - `REMOTE_PRINTER_TYPE_OCTOPRINT`: HTTP.
- **Cloud printing.** MQTT (`paho-mqtt`; `print_manage/App/CloudDeviceMqttSession.cpp`, `mqtt_client.cpp`) plus Aliyun OSS uploads (`Upload3mfToCloud.cpp`, `UploadGcodeToCloud.cpp`). All of this is outbound only, so it is container-friendly.
- The Orca-style "physical printer" path (OctoPrint/Moonraker/etc. via `PhysicalPrinterDialog`) is also present.

### 7.3 Camera — mostly **verified**

- The front-end and C++ use **WebRTC** with signalling at **`http://<ip>:8000/call/webrtc_local`** (K1/K2-class).
- `HttpServer.cpp` L167–190 provides `/rtspvideostream` (**RTSP** `rtsp://<ip>/ch0_0`) and **MJPEG** `http://<ip>:8080/?action=stream` (Ender-3 V3 / mjpg-streamer). It also handles `videoPort` for secure printers.
- On Linux, the C++ `WebRTCDecoder` (`src/slic3r/GUI/video/`, the `metartc` dep plus FFmpeg, x264, usrsctp, srtp2, opus) decodes the stream. The app's own HTTP server on **`127.0.0.1:13666`** then serves it to the WebView as `/videostream` MJPEG. The port is `LOCALHOST_PORT`, 15888 for `CUSTOMIZED` builds, and the server tries up to +19 on conflict. It binds to loopback only (`HttpServer.cpp` L313).
- WebRTC needs UDP media from the printer to the container. Under bridge NAT, outbound-initiated ICE/UDP usually works (host-candidate to NAT'd client), but this is **untested**, and host networking is the safe bet. **inferred**
- Issue #547 reports low fps on Linux with this path.

### 7.4 Creality Cloud login — **verified**

- The account login is an **embedded WebKit dialog** (`ZUserLogin`, `src/slic3r/GUI/WebUserLoginDialog.cpp`) loading Creality's login page (QR code and email/password).
- **Third-party login** (Google/Apple/etc., `thirdparty_login`) calls `wxLaunchDefaultBrowser(url)`, i.e. `xdg-open` inside the container. The OAuth callback returns to the app's **loopback server `http://localhost:13666`** (`get_localhost_url`). In a Selkies container this only works if a browser is installed *inside* the container. The user's own browser cannot reach the container's `localhost:13666`. **inferred**; recommend email/QR login in the docs.
- The token is stored in `Creality.conf` (`cloud.user_id`, `cloud.token`) and `user_info.json`.
- Cloud requests send `__CXY_DUID_ = MAC address` (`get_extra_header`, L3873, Windows-only `GetMACAddress` shown). If the Linux version also uses the MAC, a changing container MAC could look like a new device. **inferred**; consider a fixed `mac_address:` in compose.
- The region and country code (`AppConfig::get_country_code`: CHN→CN, USA/North America→US, Europe→EU, Asia-Pacific→JP, else Others) select `api.crealitycloud.com` vs `.cn`, etc.

### 7.5 First run, wizards, update checks

- **First-run onboarding** is driven by the Home-page SPA (web UI): edition choice AI vs Professional (7.2+), region, printer selection, LAN connect, and a new-user tour. Related `Creality.conf` keys: `is_first_install`, `firstguide/finish`, `region`, `privacy_version` (comments in `GUI_App.cpp` ~L2320–2440, L14054, L14412). A legacy `GuideFrame`/`WebGuideDialog` wizard also exists. Pre-seeding `Creality.conf` to skip it is possible in principle but fragile. **verified (keys) / inferred (skip)**
- **Update check**: `PresetUpdater::sync_version()` → `check_new_version_cx()` runs on every start, and `enabled_version_check` is hard-coded to `true` (`src/slic3r/Utils/PresetUpdater.cpp` L250, L384). Related keys:
  - `check_stable_update_only` limits the check to stable versions.
  - "Skip version" stores `app/skip_version`.
  - **On Linux and macOS the update only opens the download URL in a browser** (`wxLaunchDefaultBrowser`, ~L4884–4920). It never self-replaces the AppImage (unlike Windows Squirrel hot-update).

  There is **no config switch to disable the check entirely**; the user can only dismiss or skip it. **verified**
- **Online profile ("OTA") updates**: `preset_updater->sync(...)` plus `UpdateParams::startPeriodicChecks()` when `sync_system_preset == "true"`. These write into the data dir (`ota/`, `system/`). **verified**
- **Telemetry**: `https://www.crealitycloud.com/api/rest/bicollector/front/sa/data` (analytics collector) and `trackEvent`. `stealth_mode` exists in AppConfig (inherited from Bambu "stealth mode", which disables cloud calls). Whether it is fully honoured in CP was not checked. **verified (strings) / inferred (behaviour)**

### 7.6 Bundled/downloaded network plugins — **verified**

- The Bambu `NetworkAgent` / `bambu_networking` plugin download code (`GUI_App::download_plugin`, `install_plugin`, `copy_network_if_available`) is inherited. However, `GUI_App::on_init_network()` (L5461–5468) returns `false` right after the `installed_networking` check, so **the plugin is never loaded** and no proprietary `.so` is fetched at runtime.
- The proprietary bits (WebRTC, MQTT, OSS) are compiled into the binary.
- The web UI is bundled in `resources/web/` (≈45 MB). Some panels (Home, model library, AI assistant `cxagent.crealitycloud.com`, `makenow.crealitycloud.com`) load remote content.

---

## 8. Open questions for the hands-on agent

1. **ldd / objdump on the 7.3.1 AppImage `bin/CrealityPrint`:** confirm `libwebkit2gtk-4.1.so.0` + `libsoup-3.0` (and no 4.0/soup2); the maximum `GLIBC_x.y`; `libgstreamer-1.0`; `libOSMesa`/`libEGL`; `libthai`, `libbz2`, `libsecret`, `libudev`. Produce the minimal apt list for Ubuntu 24.04 / Debian trixie.
2. Does it start under Selkies' X11 with only Mesa llvmpipe? Are `WEBKIT_DISABLE_COMPOSITING_MODE=1` / `WEBKIT_DISABLE_DMABUF_RENDERER=1` / `CREALITY_WEBVIEW_HARDWARE_ACCELERATION=never` needed for the Home/Device web panels?
3. Reproduce the **variable-font crash** (#607/#621): which fonts does the base image ship? Is Adwaita Sans or Cantarell-VF present? Validate the fontconfig `<rejectfont>` workaround.
4. Confirm the data dir with `HOME=/config` is `/config/.config/Creality/Creality Print/7.3/`, and find the **WebKitGTK data dir names** (`~/.local/share/<?>`, `~/.cache/<?>`) and whether the login survives a container restart with only `/config` persisted.
5. Can `squashfs-root/AppRun` (extracted) be used directly, as Orca's image does? Check that `resources/` is found relative to `bin/`.
6. LAN: with bridge networking, does "add by IP" work for a K1/K2 (ws 9999 / wss)? Does the camera (WebRTC :8000, MJPEG :8080) work through NAT? Does mDNS discovery work with `network_mode: host`?
7. Third-party OAuth login: confirm it opens a browser inside the container (`xdg-open`) and fails without one. Is email/QR login sufficient?
8. Does the first-run edition/region onboarding appear every time if the WebKit data or `Creality.conf` is not persisted? Can a pre-seeded `Creality.conf` skip it?
9. Does the Linux build compute `__CXY_DUID_` from the MAC (code path for non-Windows `GetMACAddress`)? If so, does a changing container MAC force re-login?
10. HiDPI / Selkies resize: check clipped dialogs (#589/#654) and the 150 % scaling breakage (#440) at Selkies' default DPI.
11. v7.3.2 is GitHub-`prerelease` but creality.com lists it as current. Decide which channel the image tracks (recommend `releases/latest` = 7.3.1 until 7.3.2 is promoted).

---

## 9. Sources

- Releases API: `https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases` (enumerated 2026-11-21), `…/releases/latest` → v7.3.1.
- Repo at `v7.3.2` = `6262848e302b8c0d593f2b341cd01310aa2f58a1`:
  - `version.inc`, `CMakeLists.txt`, `BuildLinux.sh`, `linux.d/debian`, `linux.d/debian2`, `scripts/BuildLinux_Package.sh`, `scripts/build_package_linux.sh`, `Jenkinsfile`
  - `src/platform/unix/BuildLinuxImage.sh.in`, `src/platform/unix/build_appimage.sh.in`
  - `flatpak/io.github.crealityofficial.CrealityPrint.yml`, `flatpak/entrypoint`, `deps/CMakeLists.txt`, `deps/wxWidgets/wxWidgets.cmake`, `deps/metartc/metartc.cmake`
  - `src/libslic3r/utils.cpp`, `src/libslic3r/DataDirectoryMigration.{hpp,cpp}`, `src/libslic3r/AppConfig.cpp`
  - `src/slic3r/GUI/GUI_App.cpp`, `src/slic3r/GUI/GUI.cpp`, `src/slic3r/GUI/GUI_Init.cpp`, `src/CrealityPrint.cpp`
  - `src/slic3r/GUI/HttpServer.{hpp,cpp}`, `src/slic3r/GUI/WebUserLoginDialog.cpp`, `src/slic3r/GUI/Widgets/WebView.cpp`
  - `src/slic3r/GUI/print_manage/utils/cxmdns.cpp`, `src/slic3r/GUI/print_manage/Device/*.cpp`, `src/slic3r/GUI/print_manage/RemotePrinterManager.cpp`, `src/slic3r/GUI/print_manage/App/PrinterMgrView.cpp`
  - `src/slic3r/Utils/PresetUpdater.cpp`, `src/slic3r/GUI/OpenGLManager.cpp`, `src/slic3r/GUI/AboutDialog.cpp`, `resources/web/deviceMgr/assets/*.js`
- Older tags compared: `v7.2.1` and `v6.3.1`, `src/libslic3r/utils.cpp` (`version_dir = MAJOR + ".0"`).
- Issues: #607, #621, #637, #610, #650, #664, #400, #394, #623, #615, #604, #558, #483, #440, #570, #589, #654, #478, #452, #492, #547, #538, #472, #629, #626 on https://github.com/CrealityOfficial/CrealityPrint/issues
- https://www.creality.com/eu/download (fetched 2026-11-21: lists v7.3.2.6412, no static URLs)
- Flathub check: `gh api repos/flathub/io.github.crealityofficial.CrealityPrint` → 404.
