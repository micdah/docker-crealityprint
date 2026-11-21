# 08 — Prior art: Creality Print in containers, Linux pitfalls, sibling lsio images

Research date: **2026-11-21**. Each claim is marked:

- **[verified]**: I read the source directly (repo file, issue thread, API response).
- **[inferred]**: my conclusion from the evidence, not stated by the source.

Upstream: Creality Print latest stable is **v7.3.1** (2026-10-31) and the latest pre-release is **v7.3.2** (2026-11-13) [verified, `gh release list -R CrealityOfficial/CrealityPrint`].

---

## 1. Existing Creality Print containers

No maintained, popular Creality Print web-GUI container exists. Every project found has 0 to 1 stars, was a one-off experiment, and has no issues filed. Two of them pin or target versions older than v7. [verified, by GitHub and Docker Hub search, see below]

Searches run (2026-11-21):
- `gh search repos` for "creality print docker", "crealityprint", "creality-print docker", "crealityprint docker" and "creality-print".
- `gh search code` for "CrealityPrint filename:Dockerfile" and similar queries.
- The Docker Hub search API, for `crealityprint`, `creality-print`, `creality print` and `creality`.
- Every fork of `linuxserver/docker-orcaslicer` (30 forks), with each fork's Dockerfile grepped for "creality".
- Web searches for Unraid CA, Kasm registry and Reddit.

### 1.1 Stevoni/docker-crealityprint (the closest match to our plan)

- URL: https://github.com/Stevoni/docker-crealityprint
- Activity: created 2026-01-16, last push 2026-01-17. Five commits, 0 stars, 0 issues. [verified]
- Base: `ghcr.io/linuxserver/baseimage-selkies:ubuntunoble`. It is a near-verbatim copy of `docker-orcaslicer` as it stood in late 2025: the original lsio files are kept with a `.linuxserver` suffix, and the README says "All credit goes to the LinuxServer.io team". [verified]
- Install method [verified, Dockerfile]:
  - Installs apt packages, from the `ppa:xtradeb/apps` PPA plus noble: `firefox`, the full `gstreamer1.0-*` set, `libgstreamer-plugins-bad1.0`, `libwebkit2gtk-4.1-0` and `libwx-perl`.
  - Finds the AppImage with `awk '/browser_download_url.*AppImage/{print $4;exit}'` against the *latest* release, which picks the **first** AppImage asset listed.
  - Extracts it with `--appimage-extract` and moves the result to `/opt/CrealityPrint`. Also runs `localedef -i en_GB -f UTF-8 en_GB.UTF-8`.
  - Sets `ENV TITLE=CrealityPrint`, `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` and `NO_GAMEPAD=true`.
  - Uses port 3001.
- Init/launch [verified]:
  - `root/defaults/autostart` and `autostart_wayland` both contain only `/opt/CrealityPrint/AppRun`.
  - Has openbox `menu.xml` and `menu_wayland.xml` files with xterm/foot, Firefox and CrealityPrint entries.
  - Copies lsio's `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` → `sleep infinity`, which disables the system D-Bus service (see §3.1 for why).
- Problems and weak points:
  - The icon is fetched from the upstream `CrealityPrint.ico` and saved as `icon.png`, a format mismatch. [verified]
  - The GitHub workflow selects `./DockerfileNightly` for scheduled builds, but that file does not exist in the repo, so the nightly cron build cannot succeed. [verified tree listing; failure itself inferred]
  - "First AppImage in the latest release" is fragile, because Creality ships several AppImages per release (see §2.1). In 2026-01 the latest was v7.0.1, which shipped `…Ubuntu2004…` and `…Ubuntu2404…` AppImages. The Ubuntu2004 build needs `libwebkit2gtk-4.0`, which noble does not ship. [verified asset list; which asset was first is inferred]
  - It does not have the orcaslicer fixes that came after it: `GDK_BACKEND=x11` in AppRun, `find … -type d -exec chmod 755`, and the Debian trixie rebase. [verified by comparison]

### 1.2 gitsang/creality-print-docker

- URL: https://github.com/gitsang/creality-print-docker. Docker Hub: `gitsang/creality-print`, tag `v6.3.0`, about 110 pulls, pushed 2025-12-14. [verified]
- Base: `ghcr.io/linuxserver/baseimage-kasmvnc:ubuntujammy`. [verified]
- Install method [verified]:
  - `apt-get install libgtk-3-dev libwebkit2gtk-4.0-dev`. These are `-dev` packages, used only to pull in runtime libraries.
  - Downloads `CrealityPrint_Ubuntu2004-V6.3.0.3420-x86_64-Release.AppImage` to `/usr/local/bin/CrealityPrint`, **without extracting it at build time**.
- Autostart: `/usr/local/bin/CrealityPrint --appimage-extract` then `./squashfs-root/AppRun`. It re-extracts into `$HOME` (`/config`) on **every** container start: slow, and it leaves about 600 MB in the persistent volume. [verified file; impact inferred]
- No README content and no issues. It was a single afternoon's work. [verified]
- Takeaway: on a jammy (22.04) base, the "Ubuntu2004" AppImage (webkit2gtk-4.0) is the one that matches. [verified pairing; that it runs is inferred]

### 1.3 shaileshaanand/docker-crealityprint

- URL: https://github.com/shaileshaanand/docker-crealityprint, one commit on 2024-12-29. [verified]
- Base: `ghcr.io/linuxserver/baseimage-kasmvnc:debianbookworm`. [verified]
- Install method: apt `firefox-esr jq libwebkit2gtk-4.1-0`, then the AppImage chosen by the jq regex `Creality_Print.*\.AppImage`, extracted to `/opt/CrealityPrint`. [verified]
- Extra trick: it also installs **`klipper_estimator`** (Annex-Engineering) to `/usr/bin`, so a Klipper printer gets accurate print-time post-processing. [verified]
- What broke: the regex matches only the **v4/v5** asset naming (`Creality_Print-v5.1.7…`). From v6 on, assets are named `CrealityPrint…`, so the build cannot find a download URL today. In Dec 2024 the "latest" was effectively v5.1.7, the last Qt-based release, because v6.0.0 had no Linux build. [verified asset names; breakage inferred]

### 1.4 rodriguezst/docker-slicers (fork of docker-orcaslicer)

- URL: https://github.com/rodriguezst/docker-slicers ("Web accessible 3D printer slicers inside a Debian Container"), last push 2024-03-07. [verified]
- Base: `baseimage-kasmvnc:debianbookworm`. It bundles OrcaSlicer, Cura and **Creality Print v4.3.8** (pinned with `ARG CREALITYPRINT_VERSION=v4.3.8` and `CREALITYPRINT_BUILD=6991`) in one image, each AppImage extracted under `/opt`. [verified]
- Only useful as a sign that people wanted "one desktop, several slicers". Creality Print 4.x was a Qt app, unrelated to today's wx/Orca-based 6.x and 7.x. [verified version; architecture note inferred from upstream history]

### 1.5 Non-GUI / headless prior art

These are not web-GUI images, but they matter for dependencies and CLI use.

- **hemiao2023/crealityprint** (Docker Hub, "Official image of creativity print", tag `6.1.1`, 5.7 GB, 2025-04-30). [verified]
  - The author `hemiao2023` is a Creality maintainer who answers upstream issues.
  - The layers show it is upstream's own `Dockerfile`: Ubuntu 22.04 build environment, `BuildLinux.sh -u/-d/-s/-i`, `ENTRYPOINT /CrealityPrint/build/package/bin/CrealityPrint`.
  - It is a build image, not a runtime or web image.
- **Upstream `Dockerfile`** in the CrealityPrint repo (copied from OrcaSlicer, "maintainer DeftDawg"). It is a build container on `ubuntu:22.04` and sets `ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` "so that Orca Slicer doesn't complain about the CA cert path". Issue #389 reports that it does not build as shipped: `BuildLinux.sh` is missing its exec bit, and Breakpad is missing. Upstream's answer was "use the .devcontainer". https://github.com/CrealityOfficial/CrealityPrint/issues/389 [verified]
- **caio-pellegrini/print-farm-openclaw-agent** `experiments/slicing/Dockerfile.creality` (2026-09). [verified]
  - Builds a headless CLI image on `ubuntu:24.04`, with the AppImage **pinned by version and SHA-256** (`CrealityPrint-V7.2.1.5476`, sha256 `b28f66c2…`).
  - Runtime deps: `libopengl0 libglu1-mesa libgtk-3-0 libwebkit2gtk-4.1-0 libsm6 libice6 libx11-6 libxext6 libxkbcommon0 libegl1 libglx0 libwayland-egl1 libsoup-3.0-0 libmspack0 libpango-1.0-0 libsecret-1-0 dbus libnss3`.
  - Uses `ENTRYPOINT /opt/creality/AppRun`.
  - https://github.com/caio-pellegrini/print-farm-openclaw-agent/blob/main/experiments/slicing/Dockerfile.creality
- **tschd/creality-mcp** (2026-10). Runs the extracted AppImage with `AppRun --cli` for headless slicing. Tested with `CrealityPrint-V7.3.0.6151`. It extracts the AppImage so that no FUSE mount happens per slice. https://github.com/tschd/creality-mcp [verified]
- **StevenNaliwajka/crealityprint-headless** (2026-10). Patches v7.2.1 source for headless slicing. [verified]
  - It shows the GUI plate code segfaults without a `wxApp`.
  - It shows the bundled paho-mqtt is built against OpenSSL 3 but linked against bundled OpenSSL 1.1.1. The author needed an `SSL_get1_peer_certificate` shim.
  - It is a reminder that CrealityPrint is **AGPL-3.0**, so a modified build served over a network must publish its source. Unmodified redistribution inside an image is plain GPL-style distribution.
  - https://github.com/StevenNaliwajka/crealityprint-headless
- **fronald/crealityprint_runner** (2026-06), a Fedora launcher. [verified]
  1. Patches `AppRun` so it *appends to* `LD_LIBRARY_PATH` instead of overwriting it. This is the same change as the still-open upstream PR #539: https://github.com/CrealityOfficial/CrealityPrint/pull/539.
  2. Runs `ldd` on `bin/CrealityPrint` and symlinks any missing SONAMEs (for example `libbz2.so.1.0`) into a temp lib directory.
  - Upstream issues point to it as a workaround. https://github.com/fronald/crealityprint_runner
- **hansegard/CrealityPrint-flatpak** (WIP, 2025-12). A flatpak built from the extracted AppImage, which fails with `libBasicKernel.so: object file has no loadable segments`. Upstream now ships its own flatpak, so this is obsolete. [verified]

### 1.6 Places with nothing found

- **Unraid Community Apps / forums**: no Creality Print template or support thread found (web search, 2026-11-21). [verified absence in search; not exhaustive]
- **Kasm Workspaces registry**: no Creality Print workspace found. [verified absence in search; not exhaustive]
- **Reddit** (r/Creality, r/selfhosted, r/klippers): web search found no thread about running Creality Print in Docker or a browser. The Linux threads are about AppImage crashes. [inferred from search; Reddit is poorly indexed]
- **noVNC slicer images**: `Sodium-Hydrogen/slicers-novnc` (Orca/Prusa/SuperSlicer), `helfrichmichael/orcaslicer-novnc` and `mikeah/cura-novnc` exist. None include Creality Print. [verified README]

---

## 2. Running Creality Print on Linux (problems that matter in a container)

### 2.1 Packaging and asset naming is unstable [verified, release asset list]

| Release | Linux assets |
|---|---|
| v4.3.x–v5.1.7 | `Creality_Print-v5.1.7.10514-x86_64-Release.AppImage` (Qt app) |
| v6.0.0 | none |
| v6.1.x–v6.2.0 | `CrealityPrint-V6.x-…AppImage` + `CrealityPrint_Ubuntu2404-V6.x-…AppImage` |
| v6.2.1–v7.0.1 | `CrealityPrint_Ubuntu2004-…AppImage` + `CrealityPrint_Ubuntu2404-…AppImage` + `CrealityPrint-Linux-flatpak_V…_x86_64.flatpak` (v7.0.0 shipped a single `CrealityPrint-V7.0.0.4127-…AppImage`) |
| v7.1.0 | `CrealityPrint_ubuntu2004-…` / `CrealityPrint_ubuntu2404-…` (lower-case "ubuntu") + flatpak |
| v7.2.0 | 6 assets: generic, `ubuntu2204`, `ubuntu2404-wayland` Beta, `flatpak-wayland` Beta AppImage, aarch64 flatpak and others |
| v7.2.1, v7.3.x | **one** generic `CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage` + flatpak(s). v7.3.0 has **three** AppImages (builds 6149, 6151, 6157) |

- The Ubuntu2004 builds link `libwebkit2gtk-4.0`. The Ubuntu2404 and generic 7.2.1+ builds link `libwebkit2gtk-4.1`. Example: issue #325 comment, "Doesn't work in Ubuntu 24.04 as it depends on libwebkit2gtk-4.0-37". [verified]
- The tag name and the build number differ (`v7.3.1` → `7.3.1.6378`), so the download URL cannot be built from the tag alone. [verified]
- There is no aarch64 AppImage. aarch64 ships only as a flatpak (v6.2.1, v7.2.0, v7.3.0). [verified]

### 2.2 Known runtime failures and the workarounds people used

| Symptom | Cause | Workaround | Relevance to us |
|---|---|---|---|
| `error while loading shared libraries: libOSMesa.so.8` (v6.2.0) | The AppImage did not bundle OSMesa | `apt install libosmesa6`. Upstream fixed it. https://github.com/CrealityOfficial/CrealityPrint/issues/393 [verified] | `libosmesa6` is cheap insurance. lsio bambustudio installs it too |
| `libsoup2 symbols detected…` abort (v6.2.0 generic AppImage on Mint 22) | Mixing libsoup2 and libsoup3 | Use the Ubuntu2404 build. Upstream says 7.3.1 links only `libsoup-3.0`. https://github.com/CrealityOfficial/CrealityPrint/issues/400 [verified] | Pick the build that matches the base's webkit/soup ABI |
| `libbz2.so.1.0` missing (Fedora/Bluefin, 7.1.1–7.3.1) | Not bundled. AppRun **overwrites** `LD_LIBRARY_PATH` | Symlink or bundle it. Upstream says the next build bundles it in `usr/lib`. https://github.com/CrealityOfficial/CrealityPrint/issues/650, #566, #637 [verified] | Debian/Ubuntu provide `libbz2.so.1.0` in `libbz2-1.0`, so this is a non-issue on Debian bases [inferred] |
| `libthai.so.0` missing (7.3.1) | Not bundled | Install `libthai0`. https://github.com/CrealityOfficial/CrealityPrint/issues/664 [verified] | Make sure `libthai0` is present (it normally comes with GTK/pango on Debian) [inferred] |
| `libx264.so.164` missing (Fedora, 7.3.0) | SONAME mismatch | Symlink it. #637 [verified] | Debian trixie ships `libx264-164` [inferred, check during build] |
| SIGSEGV in `tt_apply_mvar` / SIGABRT after `wxLocale` init (7.0–7.3.2) | The binary **statically links FreeType and exports `FT_*` symbols**. The host cairo/pango then mixes two FreeType versions, which crashes on **variable fonts** (Adwaita Sans) | A fontconfig file that `<rejectfont>`s `/usr/share/fonts/Adwaita/*` via `FONTCONFIG_FILE`, or a static UI font such as Noto Sans. Fix pending in PR #661. https://github.com/CrealityOfficial/CrealityPrint/issues/607, #621, #637 [verified] | **High.** The container controls fonts: keep variable fonts away from the GTK default font, or ship a fontconfig override |
| Crash opening **Preferences** (Fedora 44, 7.0.1–7.2.1) | Very likely the pango 1.57 font-lookup crash. Orca had the same crash, see §3.1 | Upstream master now bundles "one coherent Pango runtime instead of inheriting the crashing 1.57.0" (`src/platform/unix/build_appimage.sh.in`). https://github.com/CrealityOfficial/CrealityPrint/issues/567 [verified issue + source; same root cause inferred] | Avoid pango ≥ 1.57 bases (Ubuntu resolute) until the bundled pango ships |
| Settings fields read-only (7.1.0–7.2.0) | Regression | Fixed in 7.2.1+. https://github.com/CrealityOfficial/CrealityPrint/issues/552, #576 [verified] | Do not ship 7.1.x–7.2.0 |
| Blank 3D plate under Wayland and/or NVIDIA (6.x) | GL/EGL vendor selection, webkit compositing | `GDK_BACKEND=x11`, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`, `__EGL_VENDOR_LIBRARY_FILENAMES=…/50_mesa.json`, `LIBGL_ALWAYS_SOFTWARE=1` (slow), or `vglrun`. Said fixed for Wayland+NVIDIA in 7.2.1 (commit 24b9395). https://github.com/CrealityOfficial/CrealityPrint/issues/473, #378, #451 [verified] | Under Selkies Wayland mode, force `GDK_BACKEND=x11` as orcaslicer does |
| Filament popup never appears under native GTK-Wayland (7.x) | `wxPopupTransientWindow` on Wayland | `GDK_BACKEND=x11`. Comment in #552 (2026-08-27) [verified] | Same: force X11 GDK |
| Dialogs clipped, OK button missing (temperature calibration) (7.2.x flatpak, Wayland) | Fixed-height, non-resizable dialogs | Fixed for the "upcoming release" per cpWzx on 2026-11-17. https://github.com/CrealityOfficial/CrealityPrint/issues/589 [verified] | Small Selkies browser viewports could hit this. Recommend ≥ 1080p |
| Wayland protocol error 71 / Mesa Zink deadlock (hybrid GPU) | WebKit subsurfaces, Zink | `unset WAYLAND_DISPLAY; GDK_BACKEND=x11; WEBKIT_DISABLE_DMABUF_RENDERER=1; WEBKIT_DISABLE_COMPOSITING_MODE=1`. #637 [verified] | Good default env set for our launcher |
| GPU hang after slicing on Intel iGPU, Mesa 26.0.x | iris CCS bug | `INTEL_DEBUG=noccs`. https://github.com/CrealityOfficial/CrealityPrint/issues/604 [verified] | Document as a DRI-passthrough tip |
| "Not connected to the internet" / TLS failures | No CA path | `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` (confirmed by Creality dev cpWzx, 2026-11-17). https://github.com/CrealityOfficial/CrealityPrint/issues/452 [verified] | Must set it (Stevoni and lsio already do) |
| Embedded WebKit Home/cloud panels blank, `WebKitWebProcess` CPU spin (2026-09-28, 1 day) | Cloudflare challenge rejected WebKitGTK. Bambu, Orca and Anycubic were hit too | Recovered by itself. https://github.com/CrealityOfficial/CrealityPrint/issues/623 [verified] | Outside our control. Worth knowing for support |
| `WebKitWebProcess` SIGABRT on quit | Heap corruption at exit | Open. https://github.com/CrealityOfficial/CrealityPrint/issues/615 [verified] | Harmless in a container, but autostart should relaunch cleanly |
| Hangs on startup instead of slicing, `--slice` ignored (7.3.0) | argv truncated before `wxEntry()` | Use `--cli`. https://github.com/CrealityOfficial/CrealityPrint/issues/634 [verified] | Only if we offer CLI slicing |
| AppImage won't mount | Missing `libfuse2` (`libfuse2t64` on Debian 13) | Install it, **or extract** with `--appimage-extract` | Extracting at build time avoids FUSE entirely (all lsio images do this) [verified] |

### 2.3 What upstream's AppRun does (source, master branch) [verified]

`src/platform/unix/BuildLinuxImage.sh.in` generates the launcher that becomes `AppRun`:

```bash
export LD_LIBRARY_PATH="$DIR/bin:$DIR/usr/lib"   # overwrites, does not append (PR #539 open)
export LC_ALL=C                                   # "segfault on systems where locale info is not as expected"
# if libGLX_nvidia is present and the boot VGA is not NVIDIA → export __GLX_VENDOR_LIBRARY_NAME=mesa
exec "$DIR/bin/CrealityPrint" "$@"
```

- `LC_ALL=C` is forced. The Creality ChromeOS wiki (below) says the AppImage takes its UI language from the host glibc locales and falls back to English without them. **[inferred]** The `LC_ALL=C` export may override the container's `LC_ALL`/`LANG`, so the in-app language setting is what matters. Worth testing.
- Master's `build_appimage.sh.in` now also bundles pango, `libmspack`, `libx264`, `libz`, `liblzma`, `libGLU`, `libOpenGL`, `libexpat`, `libLerc`, `libasound`, `libopus` and others. Future AppImages should need fewer host libraries. [verified source; effect on the released binary inferred]
- Upstream's own flatpak `entrypoint` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` when the NVIDIA GL extension is present, and `LC_ALL=C.UTF-8` (citing BambuStudio#3440). [verified, `flatpak/entrypoint`]

### 2.4 Creality's own Debian 13 instructions (closest to a container) [verified]

The Creality community wiki page "Creality Print on ChromeOS", verified on Crostini **Debian 13** with **V7.3.0** (2026-10): https://wiki.creality.com/en/software/6-0/chrome-os

- AppImage host deps: `libopengl0 libglu1-mesa libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libfuse2t64`. The page says "the -dev packages in older guides are unnecessary".
- GPU: the user must be in `render`/`video`, then use `GDK_BACKEND=x11` (applied with `flatpak override --nosocket=wayland --env=GDK_BACKEND=x11`). Without it, the app's Wayland window path falls back to llvmpipe.
- On first launch the app asks about the "SSL certificate store": tick "Remember my choice" and choose Yes. **[inferred]** This could be pre-seeded in the config so web users do not see it.
- Config lives in `~/.config/Creality/Creality Print/7.3/Creality.conf`, with `"language": "en_US"` as a JSON-ish key. Other paths: `~/.local/share/CrealityPrint` and `~/.cache/CrealityPrint`.
- The flatpak's AppStream metadata reports "6.2.0" for every version (stale), so do not use it for version detection.
- The wiki recommends the flatpak over the AppImage because it is self-contained.

### 2.5 Upstream stance on Linux, Docker and the web [verified]

- The README covers only "Linux(Ubuntu)", with `chmod +x` on the AppImage. There is no Docker, headless or web support statement. https://github.com/CrealityOfficial/CrealityPrint
- Linux builds are **GitHub-only**. Creality's download page offers only Windows and macOS (ChromeOS wiki; issue #388 comments).
- After a gap with no Linux build (v6.0, early 2025), the request issues followed: #325 "Linux AppImage", #360, a user-filed "Remove Linux Support." rant, and #409 asking for a flatpak. Creality then shipped AppImages and a flatpak from v6.1/v6.2 on.
- Since 2026-11, Creality staff (`cpWzx`, `wzx011011`, `hemiao2023`, `wen422`) have been actively triaging and fixing Linux issues (#400, #452, #552, #589, #650).
- No upstream issue or discussion asks for Docker or web delivery, beyond the build-in-Docker issue #389 and an "OrcaSlicer plugin" request (#628). Searches for "docker", "kasm", "selkies", "vnc" and "web browser" found nothing more.

---

## 3. Sibling lsio Selkies images

All of these are maintained by `thelamer` on `ghcr.io/linuxserver/baseimage-selkies:*`. All moved from KasmVNC to Selkies in mid-2025. The changelogs say "Rebase to Selkies, HTTPS IS NOW REQUIRED" (bambustudio, cura, blender and kicad on 2025-07-12, freecad on 2025-07-02, orcaslicer on 2025-09-15). Since then they have all added "Wayland init" (2025-12) and "Make Wayland default, disable with `PIXELFLUX_WAYLAND=false`" (2026-03/04). [verified, `readme-vars.yml` changelogs]

Why lsio moved: lsio's blog post "Sunsetting Legacy Images and Embracing a New Era" describes the Selkies stack's "hybrid VNC and Video Codec protocol" for "a true 60fps desktop experience over the web, efficiently achievable even on low-end x86 or ARM CPUs". The post lists the trade-offs: WebCodecs is needed, so HTTPS is required, and DRI3 GPU acceleration is temporarily unavailable. https://www.linuxserver.io/blog/spring-cleaning-new-images-and-rebasing [verified]

There is **no** `linuxserver/docker-prusaslicer`, `docker-superslicer` or `docker-crealityprint`. The lsio slicer and CAD set is orcaslicer, bambustudio, cura, freecad, blender and kicad. [verified, `gh repo list linuxserver`]

### 3.1 docker-orcaslicer (reference), with the history of fixes [verified, commits + issues]

https://github.com/linuxserver/docker-orcaslicer. Fixes in order, newest first:

- `c046e423` (2026-11-07): `find /opt/orcaslicer -type d -exec chmod 755 {} +`. Fixes issue #45, where the AppImage's dirs were not readable by the non-root user `abc`.
- `4dda4f71` (2026-10-18): `sed -i "1a export GDK_BACKEND=x11" /opt/orcaslicer/AppRun`, "to fix UI rendering issues under Wayland".
- Issue #43 (2026-10): broken menus on Intel with `-ls43`, fixed by Selkies 2.1.0. Takeaway: pin and track the base image.
- `bcbbf92a` (2026-06-20): adds aarch64 and runs `chmod +x /opt/orcaslicer/libexec/orca-slicer-env`, a "bad bin in appimage". It also dropped `NO_GAMEPAD=true`.
- `f604128f` (2026-05-11): **rebase to Debian trixie "to fix preferences menu"**, issue #36. Ubuntu resolute's pango 1.57 crashed in `libpangoft2` when Preferences opened. Noble had pango 1.52 and trixie has an older pango than resolute. thelamer: "I just likely need to start building from source I am tired of fighting all these appimages."
  - The same rebase replaced the xtradeb PPA with **Mozilla's apt repo** for Firefox, because PPAs are Ubuntu-only.
- `0c15d56f` (2026-03-29): `PIXELFLUX_WAYLAND=true` by default.
- `3d14cacf` (2026-03-23): added `libmspack0`. Without it the screen was black, issue #31.
- `66c83207` (2025-11-25): added `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` → `sleep infinity`, which disables the system dbus. It followed issue #24, where `org.freedesktop.hostname1 … Permission denied` hung startup on Ubuntu bases. [link between commit and issue inferred from timing]
- Issue #28: viewport plate buttons did not click after the Wayland changes. The cause was Selkies mouse-motion reporting, fixed in Selkies.
- Issue #13 (KasmVNC era): a segfault with `renderD128`. Fix: clear the stale config except `.config/OrcaSlicer`.
- Issue #19: no build plate with NVIDIA, closed stale.
- Issue #38: "Enable Dark Mode" is missing from Preferences in the AppImage. Workaround: `"dark_color_mode": "1"` in `OrcaSlicer.conf` plus `GTK_THEME=Adwaita:dark`.
- Issue #25: a Moonraker TLS chain error. It was the server's fault (it was not sending the full chain), not the image's.
- Readme recommendations: `shm_size: 1gb`, `show_nvidia: true`, and access at `https://yourhost:3001/`.

### 3.2 docker-bambustudio [verified]

https://github.com/linuxserver/docker-bambustudio. Base `selkies:ubunturesolute`.

- Installs `libosmesa6`, `fonts-dejavu`, `fonts-dejavu-extra`, `gstreamer1.0-nice`, `gstreamer1.0-plugins-*`, the gir gst typelibs, `libwebkit2gtk-4.1-0` and `libwx-perl`.
- Picks the AppImage with `jq 'first(.assets[].browser_download_url | select(test("BambuStudio_ubu24")))'`. It reads **`releases[0]`**, which includes pre-releases, because "stable has not had artifacts for months". It once had to handle a **zipped** AppImage.
- **Symlinks the app's bundled fonts system-wide**: `ln -s /opt/bambustudio/resources/fonts /usr/share/fonts/bambustudio && fc-cache -f`.
- Runs `find … -type d -exec chmod 755`.
- The **autostart is a script**, not a bare path:
  - A `DARK_MODE=true` env var writes `~/.config/gtk-3.0/settings.ini` with `gtk-application-prefer-dark-theme=1`, and removes it when unset.
  - `gio mime x-scheme-handler/http firefox.desktop` and the same for https, so that login and links open the in-container Firefox.
- History: in 2024 it switched to the **Fedora AppImage "for camera support"** (printer liveview).

### 3.3 docker-cura [verified]

https://github.com/linuxserver/docker-cura. Base `selkies:ubunturesolute`. Cura is a Qt AppImage, closer to old CP 4.x/5.x.

- Extracts the AppImage, then patches `AppRun.env`: `QT_QPA_PLATFORMTHEME=xdgdesktopportal` → `gtk3`, because there is no portal in the container.
- **Edits openbox `rc.xml` to start the app maximized**: `<application title="UltiMaker Cura" type="normal"><maximized>yes</maximized></application>`.

### 3.4 docker-freecad [verified]

https://github.com/linuxserver/docker-freecad. Base `selkies:debiantrixie`.

- Selects the AppImage by a precise regex (`Linux-x86_64-py311.AppImage`) and extracts it to `/opt/freecad`.
- Adds a `/usr/bin/freecad` wrapper that runs `xterm -e /opt/freecad/AppRun`, so console output is visible.
- No apt runtime libraries at all: it relies on the AppImage plus the base.

### 3.5 docker-blender and docker-kicad [verified]

- **blender**: base `selkies:ubunturesolute`. Uses the official tarball, not an AppImage. Installs `ocl-icd-libopencl1` and ships `root/etc/OpenCL/vendors/nvidia.icd` for NVIDIA OpenCL/CUDA. The autostart passes `--python-expr` to turn off `use_mouse_continuous`, which does not work through the web stream.
- **kicad**: base `selkies:alpine324`. Uses the distro package (`apk add kicad==…`), so the version comes from Alpine's APKINDEX.

### 3.6 Patterns common to all lsio Selkies app images [verified]

- `ENV TITLE=<App>`, `NO_GAMEPAD=true` (dropped in orcaslicer), `PIXELFLUX_WAYLAND=true`, `EXPOSE 3001`, `VOLUME /config`.
- Icon fetched to `/usr/share/selkies/www/icon.png`, for the PWA.
- `root/defaults/autostart` **and** `root/defaults/autostart_wayland`, plus `menu.xml` and `menu_wayland.xml` (xterm/foot, Firefox, app).
- `printf "Linuxserver.io version: …" > /build_version`, then cleanup of `/config/.cache`, `/var/lib/apt/lists/*` and `/tmp/*`.
- Version detection through the GitHub API with `jq` (switched from awk in 2026-08 across the images).

---

## 4. linuxserver request status for Creality Print

- **GitHub (linuxserver org)**: no issue, PR or discussion mentions "creality" or "crealityprint". Searches were `gh search issues "creality" --owner linuxserver`, the same for "crealityprint", and a GraphQL discussion search for `creality org:linuxserver`, all on 2026-11-21. There is no `docker-requests` repo. The only discussion repo is `meta-discussion`. [verified]
- **discourse.linuxserver.io**: the "Container Requests" category (384 topics) has no topics for "creality", "slicer", "prusa" or "cura". The only 3D-printing requests are Obico/Spaghetti Detective and Manyfold. The forum's latest activity is 2025-08-23, so it looks dormant, with requests now going through Discord (not searchable here). [verified API; "moved to Discord" inferred]
- **Conclusion**: there is no record that lsio was asked for, or declined, a Creality Print image. thelamer's comment in orcaslicer#36 ("tired of fighting all these appimages") suggests a hard-to-run AppImage would be a hard sell. [inferred]

---

## 5. Sources (primary)

- Existing images:
  - https://github.com/Stevoni/docker-crealityprint
  - https://github.com/gitsang/creality-print-docker
  - https://hub.docker.com/r/gitsang/creality-print
  - https://github.com/shaileshaanand/docker-crealityprint
  - https://github.com/rodriguezst/docker-slicers
  - https://hub.docker.com/r/hemiao2023/crealityprint
- Headless and helpers:
  - https://github.com/StevenNaliwajka/crealityprint-headless
  - https://github.com/tschd/creality-mcp
  - https://github.com/fronald/crealityprint_runner
  - https://github.com/caio-pellegrini/print-farm-openclaw-agent
  - https://github.com/hansegard/CrealityPrint-flatpak
- Upstream:
  - https://github.com/CrealityOfficial/CrealityPrint: issues #325, #360, #378, #388, #389, #393, #400, #409, #451, #452, #473, #522, #552, #567, #576, #589, #604, #607, #615, #621, #623, #634, #637, #650, #664
  - PRs #539 and #661
  - Files `Dockerfile`, `flatpak/entrypoint`, `flatpak/io.github.crealityofficial.CrealityPrint.yml`, `src/platform/unix/BuildLinuxImage.sh.in` and `src/platform/unix/build_appimage.sh.in`
- Creality wiki (ChromeOS/Debian 13): https://wiki.creality.com/en/software/6-0/chrome-os
- lsio images:
  - https://github.com/linuxserver/docker-orcaslicer: issues #13, #19, #24, #25, #28, #31, #36, #38, #43, #45
  - https://github.com/linuxserver/docker-bambustudio
  - https://github.com/linuxserver/docker-cura
  - https://github.com/linuxserver/docker-freecad
  - https://github.com/linuxserver/docker-blender
  - https://github.com/linuxserver/docker-kicad
- lsio blog: https://www.linuxserver.io/blog/spring-cleaning-new-images-and-rebasing
- lsio forum: https://discourse.linuxserver.io/c/container-requests/10

---

## Lessons for our image

- **Start from current `docker-orcaslicer`, not from Stevoni's fork.** Stevoni copied orcaslicer as of late 2025 and misses four later fixes: `GDK_BACKEND=x11` in AppRun, the `chmod 755` on directories, the trixie/pango fix and the Mozilla Firefox repo.
- **Base: `baseimage-selkies:debiantrixie`.** Avoid `ubunturesolute`: its pango 1.57 crashes the Orca-family Preferences dialog, and the same crash was reported in CP #567. Upstream is starting to bundle its own pango, so check this again on each CP release.
- **Extract the AppImage at build time** (`--appimage-extract` → `/opt/crealityprint`). Never extract in autostart (gitsang's mistake), and never depend on FUSE.
- **Select the asset deliberately.** Use a strict jq regex such as `^CrealityPrint-V[0-9.]+-x86_64-Release\.AppImage$`. Exclude `Ubuntu2004`, `ubuntu2204`, `wayland`, `Beta` and `flatpak` builds. Fail the build when there is not exactly one match.
  - v7.3.0 shipped three generic AppImages, so take the highest build number. Better still, pin `CREALITYPRINT_VERSION` and the asset name and verify a SHA-256, as caio-pellegrini does.
  - Do not ship 7.1.0–7.2.0, which have the read-only settings bug.
- **Patch AppRun after extraction**, as lsio does with `sed`:
  - Add `export GDK_BACKEND=x11` (Orca's fix, the popup and Wayland bugs in CP #552/#637, and Creality's own wiki advice).
  - Make `LD_LIBRARY_PATH` append the host value (PR #539).
  - Consider `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` for the embedded WebKit panels.
  - Re-check the forced `LC_ALL=C` and the `__GLX_VENDOR_LIBRARY_NAME` logic against DRI/NVIDIA passthrough.
- **Fonts are a real crash vector.** The CP binary exports a static FreeType and crashes on variable fonts (CP #607/#621/#637). Do not install `fonts-adwaita` or other variable UI fonts as the GTK default. Either ship a `FONTCONFIG_FILE` that rejects them, or set GTK's font to a static family (Noto Sans / DejaVu). Run a font smoke test on every bump.
- **Runtime apt set**, from orcaslicer plus Creality's Debian 13 list plus caio-pellegrini:
  - Libraries: `libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libopengl0 libglu1-mesa libosmesa6 libmspack0 libsoup-3.0-0 libsecret-1-0 libnss3 libthai0`.
  - GStreamer plugins: base/good/bad/ugly/libav/gtk3/gl, for printer camera liveview.
  - `libwx-perl` (lsio carries it).
  - After install, run `ldd /opt/crealityprint/bin/CrealityPrint | grep 'not found'` as a build-time check, as fronald's runner does.
- **Keep the orcaslicer `svc-dbus` → `sleep infinity` override**, against the `hostname1` hang. Also keep `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`: without it CP reports "not connected to the internet" (CP #452).
- **Borrow small UX tricks:**
  - From bambustudio: a `DARK_MODE` env (gtk `settings.ini`), `gio mime x-scheme-handler/http(s) firefox.desktop` so cloud login opens in-container Firefox, and `fc-cache` on the app's bundled fonts (only if they are static).
  - From cura: open the window maximized via openbox `rc.xml`.
  - Consider pre-seeding the "SSL certificate store" first-run answer in `Creality.conf`.
- **Document GPU expectations.** The CP viewport falls back to llvmpipe unless `/dev/dri` is passed and the X11 GDK backend is used. Note `INTEL_DEBUG=noccs` for the Intel Mesa 26 hang (CP #604), `shm_size: 1gb`, HTTPS on 3001, and a minimum 1080p viewport (clipped dialogs, CP #589).
- **x86_64 only**: there is no aarch64 AppImage. aarch64 would need the flatpak, which is out of scope.
- **Optional extras others found useful:**
  - `klipper_estimator` (shaileshaanand), for Klipper-based Creality printers.
  - A `--cli` entry point for headless slicing (`--slice` alone is broken, CP #634).
- **Licensing**: CrealityPrint is AGPL-3.0. Redistributing the unmodified AppImage is fine. If we ever patch the binary, we must publish the corresponding source.
- **Expect churn.** Creality changes asset naming nearly every release and is actively fixing Linux right now: libbz2/libthai bundling, pango bundling and the FreeType fix are all in flight. Version-check via jq, build in CI, and smoke-test that the app reaches its main window, not just that the image builds.
