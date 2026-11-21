# 02 — How `linuxserver/docker-orcaslicer` works

Research date: **2026-11-21**. Scope: the LinuxServer.io (LSIO) OrcaSlicer image, which is our template for a Creality Print image.

**Verified** means I saw it in source at the commit listed. **Inferred** means my reading of the evidence, not checked by running anything. Nothing here was tested in a container.

## Sources (pinned)

| Repo | Commit / ref | Notes |
| --- | --- | --- |
| [linuxserver/docker-orcaslicer](https://github.com/linuxserver/docker-orcaslicer) | `4b114d95b04b4517e79d01cd6681b843bce10ef2` (2026-11-17, branch `master`) | Current release tag is `v2.5.1-ls52` (2026-11-17). 264 commits in total, about 30 of them by humans. |
| [linuxserver/docker-bambustudio](https://github.com/linuxserver/docker-bambustudio) | `d8329013cbb18a70cd971fefa804c905609408f3` | Used for comparison. |
| [linuxserver/docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies) | `a7d1dfd0cd98b6992786a4883382f1094d075534` (`master`, which is the Debian Trixie variant) | Read only to see how it uses `/defaults/autostart` and the `svc-dbus` service. |
| [OrcaSlicer/OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) | `5a1ffc6a631ead5886f1c22920deb341fc1a0106` (`main`) | Read to see how the AppImage and its `AppRun` launcher are built. |
| `linuxserver/docker-prusaslicer` | — | **Does not exist**: `git clone` returned "Repository not found". |

File paths below are relative to the docker-orcaslicer repo at the commit above, unless stated otherwise.

---

## 1. Dockerfile walkthrough (`Dockerfile`)

The x86_64 and aarch64 Dockerfiles are identical apart from two lines (see §1.1).

```dockerfile
# syntax=docker/dockerfile:1
FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie
```
- **Base tag: `ghcr.io/linuxserver/baseimage-selkies:debiantrixie`** (verified). The aarch64 file uses `ghcr.io/linuxserver/baseimage-selkies:arm64v8-debiantrixie`.
- History of the base image (verified from git): `baseimage-kasmvnc:debianbookworm` (2023-11) → `baseimage-selkies:ubuntunoble` (2025-09-15, commit `9e99a25`) → `ubunturesolute` (2026-04-19, `27bfa00`) → **`debiantrixie` (2026-05-11, `f604128`)**. The last move was made "to fix preferences menu"; see §5.

```dockerfile
ARG BUILD_DATE
ARG VERSION
ARG ORCASLICER_VERSION
LABEL build_version="Linuxserver.io version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="thelamer"
```
- CI passes three build args: `ORCASLICER_VERSION` (the upstream tag, e.g. `v2.5.1`), `VERSION` (the LSIO tag, e.g. `v2.5.1-ls52`) and `BUILD_DATE`. See §4.
- The `build_version` label matters: the external-trigger workflow reads it back from GHCR to find out which upstream version was last published (§4.2).

```dockerfile
ENV TITLE=OrcaSlicer \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PIXELFLUX_WAYLAND=true
```
- `TITLE`: the Selkies browser tab and PWA title.
- `SSL_CERT_FILE`: points the AppImage's bundled TLS stack (libcurl/OpenSSL) at the system CA bundle. Without it, HTTPS calls from inside the app, such as cloud login, profile sync and printer agents, can fail. The reason is **inferred**; the line has been there since the first commit.
- `PIXELFLUX_WAYLAND=true`: Wayland mode (the labwc compositor plus the zero-copy "pixelflux" encoder) has been the default since 2026-03-29 (`0c15d56`). Users can opt out with `PIXELFLUX_WAYLAND=false`, which switches to Xvfb and Openbox.
- `NO_GAMEPAD=true` was added during the Selkies rebase (2025-09) and removed again on 2026-06-20 (`bcbbf92`).

The rest of the build is one `RUN` chain:

1. **Icon**: `curl -o /usr/share/selkies/www/icon.png https://raw.githubusercontent.com/linuxserver/docker-templates/master/linuxserver.io/img/orcaslicer-logo.png`. Selkies uses this as the favicon and PWA icon.
2. **Mozilla apt repository**: adds `packages.mozilla.org` with a keyring and pins it at priority 1000, so that `firefox` installs as a real .deb rather than Debian's `firefox-esr` or Ubuntu's snap stub. This arrived with the Trixie rebase and replaced the earlier `add-apt-repository ppa:xtradeb/apps` used on Ubuntu.
3. **Packages** (`apt-get install --no-install-recommends -y`). The "why" column is inferred unless noted:

   | Package | Why |
   | --- | --- |
   | `firefox` | A browser inside the desktop. The slicer opens external links and OAuth login pages there, and users can reach printer web UIs (Fluidd/Mainsail/Creality web) from it. It also appears in the right-click menu. |
   | `gstreamer1.0-alsa`, `-gl`, `-gtk3`, `-libav`, `-plugins-bad`, `-plugins-base`, `-plugins-good`, `-plugins-ugly`, `-pulseaudio`, `-qt5`, `-tools`, `-x`, `libgstreamer-plugins-bad1.0` | WebKitGTK plays media through GStreamer, and the slicer uses GStreamer for printer camera streams (RTSP/MJPEG/H.264) in the Device tab. This is broad coverage: `-qt5`, `-alsa` and `-tools` are probably not strictly needed. The list has been unchanged since 2023. |
   | `libmspack0` | Added 2026-03-23 (`3d14cac`) after issue #31 (black screen: the app would not start). A newer OrcaSlicer AppImage linked against it and did not bundle it. **Verified**: the fix was a single line. |
   | `libwebkit2gtk-4.1-0` | **Required.** The OrcaSlicer AppImage treats WebKitGTK as a host library (see §1.2). Before the Selkies rebase this was `libwebkit2gtk-4.0-37`. |
   | `libwx-perl` | Odd for a binary AppImage. It pulls in the wxWidgets GTK3 shared libraries and their GTK dependencies (**inferred**; it has been there since the first version and is probably a leftover from PrusaSlicer-era packaging). The cost is small, so it is "copy as-is" unless the build shows it can go. |

   Not installed here, but provided by the Selkies base: mesa/GL (`libgl1`, `libopengl0`, `libegl1`), fonts, PulseAudio, labwc/openbox, xterm/foot and dbus. The upstream `AppRun` hard-fails without `libopengl0` ("missing host OpenGL runtime library libOpenGL.so.0"), so the base must provide it (**inferred**). BambuStudio adds `fonts-dejavu*` and `libosmesa6` itself (§6).

4. **Version resolution and download** (verified):

   ```sh
   if [ -z ${ORCASLICER_VERSION+x} ]; then
     ORCASLICER_VERSION=$(curl -sX GET "https://api.github.com/repos/OrcaSlicer/OrcaSlicer/releases/latest" | jq -r '.tag_name');
   fi
   RELEASE_URL=$(curl -sX GET "https://api.github.com/repos/OrcaSlicer/OrcaSlicer/releases/latest" | jq -r '.url')
   DOWNLOAD_URL=$(curl -sX GET "${RELEASE_URL}" | jq -r 'first(.assets[].browser_download_url | select(test("Ubuntu2404_V")))')
   ```
   - The asset is the GitHub release AppImage, e.g. `OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.5.1.AppImage`. On aarch64 the regex is `Ubuntu2404_aarch64`, which matches `OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.1.AppImage`.
   - **Bug, verified:** `ORCASLICER_VERSION` is computed but never used. The download always comes from `/releases/latest`, so the build arg does not pin anything. A release published between detection and build would be picked up silently, and you cannot rebuild an older version. **For our image, download from `/releases/tags/${CREALITYPRINT_VERSION}`.**
   - The `jq` version replaced `awk` field-splitting on 2026-08-15 (`c4a6371`). The `_V` suffix in the regex was added (`bcbbf92`) so that `Ubuntu2404` would not also match the new `Ubuntu2404_aarch64` asset.
   - Earlier history: until 2025-09 the URL was built by hand from the tag (`OrcaSlicer_Linux_AppImage_$(echo ${VERSION} | sed 's/\b\(.\)/\u\1/g').AppImage`). It broke whenever upstream renamed the asset (`300df35`, "update upstream artifact name"), and that is why it was replaced by API asset matching.
5. **Extract instead of mounting** (verified):
   ```sh
   cd /tmp && curl -o /tmp/orca.app -L "${DOWNLOAD_URL}" && chmod +x /tmp/orca.app
   ./orca.app --appimage-extract && mv squashfs-root /opt/orcaslicer
   ```
   Extracting avoids any need for FUSE inside the container. The app then runs through `/opt/orcaslicer/AppRun`.
6. **Locale**: `localedef -i en_GB -f UTF-8 en_GB.UTF-8`. OrcaSlicer/wx segfaults or misbehaves when its locale is missing (**inferred**; upstream `AppRun` even sets `LC_ALL=C` with a "segfault workaround" comment).
7. **Fixes to the AppImage contents** (verified; all added in 2026):
   - `chmod +x /opt/orcaslicer/libexec/orca-slicer-env` (`bcbbf92`, "chmod bad bin in appimage"). The upstream `AppRun` now `exec`s this wrapper, and in that release it shipped without the execute bit.
   - `sed -i "1a export GDK_BACKEND=x11" /opt/orcaslicer/AppRun` (`4dda4f7`, 2026-10-18, "Force OrcaSlicer to use the X11 GDK backend to fix UI rendering issues under Wayland"). Under labwc, the app runs as an XWayland client instead of a native Wayland GTK client. `AppRun` is a bash script, so the `sed` inserts the line straight after the shebang.
   - `find /opt/orcaslicer -type d -exec chmod 755 {} +` (`c046e42`, 2026-11-07, issue #45). The new AppImage format contains directories with mode `700`, so user `abc` could not run the app. The issue reporter blamed the `sed`, but the maintainer (thelamer) confirmed it was the directory modes.
8. `printf "Linuxserver.io version: ${VERSION}\nBuild-date: ${BUILD_DATE}" > /build_version`. This is standard LSIO; the init banner prints it.
9. **Cleanup**: `apt-get autoclean`, then `rm -rf /config/.cache /config/.launchpadlib /var/lib/apt/lists/* /var/tmp/* /tmp/*`. This also removes the downloaded AppImage.

```dockerfile
COPY /root /
EXPOSE 3001
VOLUME /config
```

### 1.1 `Dockerfile.aarch64`
Exactly two lines differ: `FROM ...:arm64v8-debiantrixie` and the asset regex `Ubuntu2404_aarch64`. aarch64 support was added 2026-06-20 (`bcbbf92`), once upstream started publishing an aarch64 AppImage.

### 1.2 Why the host packages matter: OrcaSlicer's AppImage bundling policy
`scripts/appimage_lib_policy.sh` in OrcaSlicer (verified at `5a1ffc6`) lists libraries that are deliberately **not bundled** and must come from the host: glibc, GL/EGL/GLX/drm/gbm, X11/xcb/wayland, **gtk, gdk, pango, cairo, atk, glib/gio, gstreamer (`libgst*`), libsoup, `libwebkit2gtk-*`, `libjavascriptcoregtk-*`**, fontconfig, freetype, harfbuzz, libstdc++, dbus and others.

The generated `libexec/orca-slicer-env` (`src/dev-utils/platform/unix/build_linux_image.sh.in`) does two things:
- If the AppImage does not bundle WebKitGTK, it **exits with an error** unless the host has `libwebkit2gtk-4.1.so.0` and `libjavascriptcoregtk-4.1.so.0`, and it always exits if `libOpenGL.so.0` is missing.
- It prepends `$APPDIR/lib/orca-runtime` and `$APPDIR/bin` to `LD_LIBRARY_PATH`.

The `AppRun` it generates:
```bash
export LC_ALL=C
# on Wayland + NVIDIA >555: __GLX_VENDOR_LIBRARY_NAME=mesa, MESA_LOADER_DRIVER_OVERRIDE=zink, GALLIUM_DRIVER=zink
exec "$DIR/libexec/orca-slicer-env" "$DIR/bin/orca-slicer" "$@"
```
The consequence is that **the container distro has to match the distro the AppImage was built against (Ubuntu 24.04)** closely enough on GTK, pango and webkit versions. This explains the Resolute (Ubuntu 26.04) breakage, where a newer libpango crashed Preferences, and the move to Debian Trixie (§5). Creality Print's AppImage probably follows a similar but older policy, since it forked from Orca earlier. **Check what it bundles** before choosing a base distro (`ldd` against the extracted tree).

---

## 2. The `root/` overlay (every file)

| File | Contents | Purpose |
| --- | --- | --- |
| `root/defaults/autostart` | `/opt/orcaslicer/AppRun` | Openbox (X11 mode) autostart. |
| `root/defaults/autostart_wayland` | `/opt/orcaslicer/AppRun` | labwc (Wayland mode) autostart. |
| `root/defaults/menu.xml` | Openbox right-click menu with three items: `xterm` → `/usr/bin/xterm`, `FireFox` → `/usr/bin/firefox`, `OrcaSlicer` (icon `/opt/orcaslicer/OrcaSlicer.png`) → `/opt/orcaslicer/AppRun` | Lets users relaunch the app after a crash or after closing it. Maintainers tell users to do exactly this in several issues. |
| `root/defaults/menu_wayland.xml` | The same menu with `foot` instead of `xterm` | Wayland-mode menu. |
| `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` | `#!/usr/bin/with-contenv bash` and `sleep infinity` | **Turns off the base image's system D-Bus daemon** by overriding its run script. Added 2025-11-25 (`66c8320`). See below. |

There are **no** wrapper scripts, `.desktop` files, custom init scripts or `GTK_THEME`/`LIBGL_*`/`WEBKIT_DISABLE_*` env vars in this image. The only launch tweak is the `GDK_BACKEND=x11` line patched into `AppRun`. That patch is part of the image, not of `/config`, so it applies to existing users as well.

**How the base image uses these files** (verified in `docker-baseimage-selkies` `root/etc/s6-overlay/s6-rc.d/init-selkies-config/run`):
- On every start, if `PIXELFLUX_WAYLAND=true` the init picks `CONF_DIR=$HOME/.config/labwc` and the `*_wayland` defaults; otherwise it picks `$HOME/.config/openbox`.
- It copies `autostart` and `menu.xml` into `CONF_DIR` **only if they do not already exist**. `$HOME` is `/config`. So **any later change to `/defaults/autostart` never reaches existing users.** This is why issue threads say "edit `/config/.config/openbox/autostart`". Keep the autostart file down to a bare launcher and put launch logic in an image-owned wrapper (e.g. `/usr/local/bin/crealityprint-launch`) so that fixes reach existing installs.
- `RESTART_APP=true` (a base-image feature) turns on `svc-watchdog`. The watchdog `pgrep`s `sh $HOME/.config/<wm>/autostart` and runs it again with `s6-setuidgid abc` if the app exits. The base also makes the autostart file read-only for `abc` in that mode.

**Why `svc-dbus` is overridden** (inferred). The base `svc-dbus` runs `dbus-daemon --system` as `messagebus`. Issue #24 (2025-11) showed OrcaSlicer asking the system bus to activate `org.freedesktop.hostname1`, which failed with "Permission denied" and was linked to a black screen on Ubuntu-based tags. Three weeks later the maintainer stubbed out the system bus. The **session** bus is unaffected, because the base starts the WM with `dbus-launch` (X11) or `dbus-run-session` (Wayland) in `startwm*.sh`. Without a system bus the app probably gets a quick "service unknown" and continues, rather than hanging on activation. Creality Print shares this code ancestry, so start with the same override and drop it only if testing proves it unnecessary.

---

## 3. Env vars, volumes and ports (from `readme-vars.yml` / README)

- **Ports**: `3000` serves HTTP and "must be proxied"; `3001` serves HTTPS with a self-signed certificate. HTTPS is mandatory since the Selkies rebase, because WebCodecs needs a secure context. Only `3001` is `EXPOSE`d.
- **Volume**: `/config` is the home directory of user `abc` and holds all settings. OrcaSlicer keeps its data in `/config/.config/OrcaSlicer/` (e.g. `OrcaSlicer.conf`, according to issue #38).
- **Recommended**: `--shm-size=1gb` / `shm_size: "1gb"`.
- **Standard LSIO vars**: `PUID`, `PGID`, `TZ`.
- **App-specific env vars: none.** `readme-vars.yml` has no `opt_param_env_vars`. Everything else comes from the Selkies base and is documented on docs.linuxserver.io:
  - `PIXELFLUX_WAYLAND`
  - `CUSTOM_USER`, `PASSWORD` (basic auth)
  - `AUTO_GPU`
  - `DRINODE`, `DRI_NODE`
  - `NO_DECOR`
  - `RESTART_APP`
  - `LC_ALL`
  - `SELKIES_*`
  - `CUSTOM_PORT`, `CUSTOM_HTTPS_PORT`
- **GPU** (README): use `--device /dev/dri` for Intel/AMD. For Nvidia, use `--runtime nvidia --gpus all --device /dev/nvidia-modeset` with host driver 580 or newer.
- **`readme-vars.yml` also contains**:
  - `selkies_blurb: true` and `show_nvidia: true`, which pull in the generated Selkies docs.
  - `available_architectures` for x86_64 and arm64.
  - An `init_diagram`.
  - A `changelogs` list.

  The README is generated from this file by `ghcr.io/linuxserver/jenkins-builder` and must never be edited by hand (`AGENTS.md` §2).

---

## 4. Build and CI pipeline

### 4.1 `jenkins-vars.yml` (verified)
```yaml
external_type: github_stable        # version = GitHub releases/latest .tag_name (prereleases ignored)
release_type: stable
release_tag: latest
ls_branch: master
external_artifact_check: |          # don't trigger until the aarch64 AppImage is uploaded
  assets=$(curl ... "https://api.github.com/repos/OrcaSlicer/OrcaSlicer/releases/tags/${EXT_RELEASE}" | jq -r '.assets[].browser_download_url')
  if grep -q "OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64" <<< "${assets}"; then artifacts_found="true"; else artifacts_found="false"; fi
repo_vars:
  - EXT_USER = 'OrcaSlicer'
  - EXT_REPO = 'OrcaSlicer'
  - BUILD_VERSION_ARG = 'ORCASLICER_VERSION'
  - MULTIARCH = 'true'
  - CI = 'true'
  - CI_WEB = 'true'
  - CI_PORT = '3001'
  - CI_SSL = 'true'
  - CI_DELAY = '120'
  - CI_WEB_SCREENSHOT_DELAY = '30'
  - CI_DOCKERENV = 'TZ=US/Pacific'
  - CI_AUTH = 'user:password'
  - DIST_IMAGE = 'ubuntu'           # stale: base is Debian now
```

### 4.2 How new upstream releases are detected
- `.github/workflows/external_trigger_scheduler.yml` runs **hourly** (cron `48 * * * *`). For each live branch it dispatches `external_trigger.yml`.
- `external_trigger.yml` (verified) does the following:
  1. Sets `EXT_RELEASE = GET /repos/OrcaSlicer/OrcaSlicer/releases/latest | .tag_name`.
  2. Sanitises the tag (`sed 's/[~,%@+;:/]//g'`).
  3. Fetches `ghcr.io/linuxserver/orcaslicer:latest` → manifest → config blob → `Labels.build_version` and takes the part before `-ls`. That gives the last published upstream version. **The registry itself is the state store; no version file is committed.**
  4. Exits if the two versions are equal, or if a Jenkins build is already running.
  5. Runs `external_artifact_check`. If the expected asset is not uploaded yet, it posts a Discord notice and retries on the next hourly run.
  6. Otherwise it calls Jenkins `buildWithParameters` and posts to Discord.
- `package_trigger_scheduler.yml` runs **weekly** (`57 11 * * 2`, Tuesdays). It triggers a rebuild to pick up distro and base-image package updates.

### 4.3 Jenkinsfile (generated; 1474 lines)
Key stages (verified line numbers):
- **"Set ENV github_stable"** (l.208): `EXT_RELEASE` comes from `releases/latest`.
- **"Sanitize tag"** produces `EXT_RELEASE_CLEAN`.
- **Tag scheme**:
  - Release builds: `${EXT_RELEASE_CLEAN}-ls${LS_TAG_NUMBER}`, e.g. `v2.5.1-ls52`.
  - Dev builds: `…-pkg-${md5(package_versions.txt)[0:8]}-dev-${COMMIT_SHA}`.
  - PR builds: add `-pr-N`.
  - Arch tags are prefixed `amd64-` and `arm64v8-`.
- **Build-Multi** (l.731): runs **two separate native `docker buildx build`s** with `--platform=linux/amd64` and `-f Dockerfile.aarch64 --platform=linux/arm64`. Both use `--no-cache --pull` and `--build-arg ORCASLICER_VERSION=${EXT_RELEASE} --build-arg VERSION=... --build-arg BUILD_DATE=...`. The OCI labels include `org.opencontainers.image.version`.
- **Update-packages** (l.948): runs **syft** (`ghcr.io/anchore/syft`) against the amd64 image with `-o table`, which produces `package_versions.txt`. The md5 of that file decides whether a weekly package-trigger build has anything new to push (`PACKAGECHECK-exit`). The bot commits the file back, which is why most commits are "Bot Updating Package Versions".
- **Test** (l.1032): `ghcr.io/linuxserver/ci` (`test_build.py`) starts the container, waits `CI_DELAY=120`s, checks the logs, and takes a **web screenshot** over HTTPS on port 3001 after 30s, logging in with basic auth `user:password`. Results go to `ci-tests.linuxserver.io`.
- **Push** goes to Docker Hub, GHCR, GitLab and Quay, with multi-arch manifests for `latest`, `${META_TAG}` and `version-${EXT_RELEASE_CLEAN}`.
- **Github-Tag-Push-Release** creates a GitHub release in the docker repo.
- **Update-Templates** regenerates README, Jenkinsfile, workflows and issue templates with `jenkins-builder`.

### 4.4 Replicating this in GitHub Actions for our repo (proposal)
LSIO's machinery (Jenkins, jenkins-builder, Discord) is far more than we need. A minimal equivalent:

1. **`check-upstream.yml`** runs on a cron schedule (e.g. every 6h) and on `workflow_dispatch`:
   - Upstream: `gh api repos/CrealityOfficial/CrealityPrint/releases/latest --jq .tag_name`. Note that `releases/latest` already skips prereleases. Creality marks some releases as prerelease (v7.3.2 is one), so decide whether to track them.
   - Published: read the `org.opencontainers.image.version` label from `ghcr.io/<us>/crealityprint:latest` using `docker buildx imagetools inspect --format '{{json .Image.Config.Labels}}'` or `skopeo inspect`. Another option is a committed `UPSTREAM_VERSION` file that a bot PR bumps; this gives an auditable history and lets a human review each bump, which suits our "review before merge" workflow.
   - Asset check: confirm the release has an asset matching `x86_64-Release\.AppImage$` before triggering, since uploads can arrive late.
   - If the version is new, dispatch `build.yml` with `version=<tag>`, or open a PR that bumps `UPSTREAM_VERSION`.
2. **`build.yml`**:
   - Use `docker/setup-buildx-action` and `docker/build-push-action` with `build-args: CREALITYPRINT_VERSION=${{ inputs.version }}`, `VERSION=${tag}-r${run_number}` and `BUILD_DATE`.
   - Push to GHCR with tags `latest`, `${tag}` and `${tag}-r${run_number}`, and set OCI labels through `docker/metadata-action`.
   - Build amd64 only for now: Creality publishes **no aarch64 AppImage**, only an aarch64 flatpak in v7.3.0.
3. **Weekly rebuild** (cron) picks up base-image and Debian security updates. Optionally do as LSIO does and run `anchore/sbom-action` (syft), skipping the push when the SBOM hash is unchanged.
4. **Smoke test** in CI:
   - Run the container, wait about 60–120 s, and `curl -k https://localhost:3001`.
   - Grep `docker logs` for `[ls.io-init] done.`.
   - Optionally take a screenshot of the page with Playwright.
5. Alternatively, Renovate (a `customManagers` regex rule with the `github-releases` datasource on the `ARG CREALITYPRINT_VERSION=` default) gives the same bump-PR flow with less custom code.

---

## 5. Git history: the problems they hit (chronological, verified)

| Date | Commit | Change | What it tells us |
| --- | --- | --- | --- |
| 2023-11-15 | `311fc2b` | First version on `baseimage-kasmvnc:debianbookworm`: AppImage extracted to `/opt/orcaslicer`, `libwebkit2gtk-4.0-37`, gstreamer set, `firefox-esr`. | The basic recipe has barely changed. |
| 2025-03-21 | `300df35` | Asset name changed upstream (`OrcaSlicer_Linux_` → `OrcaSlicer_Linux_AppImage_`). | Hand-built URLs break. Match assets through the API instead. |
| 2025-09-15 | `9e99a25` | Moved to **Selkies on Ubuntu Noble**. Switched to `libwebkit2gtk-4.1-0`, selected the `Ubuntu2404` AppImage, added `localedef en_GB.UTF-8`, port 3000 → 3001 (HTTPS required). | Match the base distro to the AppImage's build distro (24.04). The webkit 4.0 → 4.1 ABI switch came with it. |
| 2025-11-25 | `66c8320` | Upstream org renamed `SoftFever` → `OrcaSlicer`; **system dbus stubbed out**. | See §2. |
| 2026-01-01 | `45c9b4b` | Added `autostart_wayland` and `menu_wayland.xml`. | Wayland mode needs its own defaults. |
| 2026-03-23 | `3d14cac` | Added `libmspack0` (issue #31, black screen). | New upstream releases can add host dependencies. CI's screenshot test missed it, or ran before it showed up. |
| 2026-03-29 | `0c15d56` | `PIXELFLUX_WAYLAND=true` made the default. | The maintainer recommends Wayland mode; it fixed input lag on iGPUs (issue #23). |
| 2026-04-19 | `27bfa00` | Rebased to Ubuntu **Resolute**. | — |
| 2026-05-11 | `f604128` | Rebased to **Debian Trixie** "to fix preferences menu" (issue #36: segfault in `libpangoft2` from `wxCairoContext::GetTextExtent`; pango 1.57 on Resolute against 1.52 on Noble). | Host GTK/pango that is too new breaks the AppImage. The maintainer said he was "tired of fighting all these appimages" and considered building from source. Trixie's pango (1.56) works. |
| 2026-06-20 | `bcbbf92` | aarch64 added; `chmod +x libexec/orca-slicer-env`; regex narrowed to `Ubuntu2404_V`. | AppImage packaging bugs upstream (missing +x) need patching in the image. |
| 2026-08-15 | `c4a6371` | awk JSON parsing → `jq`. | Use `jq`. |
| 2026-10-18 | `4dda4f7` | `export GDK_BACKEND=x11` patched into `AppRun`. | Native Wayland GTK rendering had UI glitches under labwc. XWayland is safer. |
| 2026-11-07 | `c046e42` | `find /opt/orcaslicer -type d -exec chmod 755 {} +` (issue #45). | AppImage extraction can keep `700` directory modes, so the app is unrunnable as `abc`. Always normalise permissions. |

---

## 6. GitHub issues that matter

Every issue on the repo is closed; there were 29 issues and PRs in total.

**Rendering, GPU and black screens**
- **#13** (2024) — segfault or black screen when only `/dev/dri/renderD128` is passed. **Fix:** pass the whole `/dev/dri`. On some VPSs, LLVM/mesa crashes on misreported CPUs ("64-bit code requested on a subtarget that doesn't support it").
- **#19** (2025) — no build plate shown with Nvidia under KasmVNC. Closed as stale. A user's own image used `vglrun`/VirtualGL for Nvidia.
- **#23** (2025–26) — input stops or lags about 10 s on Intel iGPUs. **Cause:** Xvfb DRI3 with an oversized framebuffer; see baseimage-selkies issue #115 (cap the max resolution). **Fix:** use `PIXELFLUX_WAYLAND=true`. Wayland mode needs **AVX2**, which Proxmox's default VM CPU type hides. `MESA_LOADER_DRIVER_OVERRIDE=llvmpipe` works around it by forcing CPU rendering.
- **#28** (2025-12) — the plate's side buttons stopped responding to clicks after Wayland changes. **Cause:** a mouse-motion reporting bug in Selkies, fixed upstream in selkies `8f834f2`.
- **#31 and #35** — black screen after an update. The causes were the missing `libmspack0` (#31) and a user's leftover `DRINODE`/`PIXELFLUX_WAYLAND=false` settings (#35). Maintainer's advice: start minimal and add options one at a time.
- **#36** — Preferences crashes (the pango problem in §5). **Workaround:** pin the previous tag.
- **#43** (2026-10) — `v2.4.2-ls43` has broken menus on Intel; the fix waited on Selkies 2.1.0. This is an example of a base-image regression, and the reason to pin the base image by digest and test on Intel.

**Permissions**
- **#45** — directories with mode `700` inside the AppImage (§5).

**Login and webview**
- **#6 and #7** (2024) — Google/Gmail login for the Bambu cloud: the redirect spins forever in the in-container Firefox. One user worked around it by copying the link into a private window. These issues were closed as invalid/stale. **Relevant to Creality Cloud login, which also uses an external browser or webview.** Note that docker-bambustudio's autostart sets `gio mime x-scheme-handler/http(s) firefox.desktop` so that links open in Firefox; docker-orcaslicer does not.
- **#25** — "Unacceptable TLS certificate" in the Device tab with Moonraker over HTTPS. **Cause:** the server sent an incomplete certificate chain, which is not an image bug. Point for us: the app trusts the system CA store through `SSL_CERT_FILE`.

**Printer connectivity and LAN**
- **#8** — Bambu "Send to SD card" error 0. It also happens natively, so the cause is upstream.
- **#3** — Bambu webcam crash, caused by a libjpeg mismatch with the Ubuntu AppImage. docker-bambustudio worked around it by using the Fedora AppImage at the time.
- Nobody reported mDNS/SSDP printer discovery problems. Bridge networking blocks multicast discovery, so users can expect to enter the IP by hand or use `network_mode: host` (**inferred**; Creality Print discovers K1/K2-series printers on the LAN, so this will matter more for us).

**Usability and UI**
- **#9 and #38** — no dark mode option in the AppImage build. **Workaround:** set `"dark_color_mode": "1"` in `OrcaSlicer.conf` and `GTK_THEME=Adwaita:dark`. docker-bambustudio offers a `DARK_MODE=true` env var that writes `~/.config/gtk-3.0/settings.ini` (§7).
- **#29** — duplicate title bar; closing the app leaves a black screen. Answer: `NO_DECOR=true`, `Ctrl+Shift+D`, or relaunch from the right-click menu. `RESTART_APP=true` also helps.
- **#10** — file upload: use the Selkies sidebar file manager. **#17** — where to put STLs: mount extra paths under `/config` or anywhere, as in the users' compose files.
- **#15 and #16** — users asked for beta/prerelease builds, and PR #16 proposed `/releases/tags/${VERSION}`. Both were closed as stale; LSIO only tracks stable releases.

**Settings loss**
- No explicit issue. #13 shows users deleting everything under `/config` except `.config/OrcaSlicer`, so that directory is what matters to keep.

---

## 7. Sibling images (brief)

**docker-bambustudio** (`d832901`):
- **Base**: still `baseimage-selkies:ubunturesolute`; it was not moved to Trixie. It uses `add-apt-repository ppa:xtradeb/apps` for Firefox.
- **Packages**: `firefox`, `fonts-dejavu`, `fonts-dejavu-extra`, `gir1.2-gst-plugins-bad-1.0`, `gir1.2-gstreamer-1.0`, `gstreamer1.0-nice`, `gstreamer1.0-plugins-*` (wildcard), `gstreamer1.0-pulseaudio`, `libosmesa6`, `libwebkit2gtk-4.1-0`, `libwx-perl`.
- **Download**: takes the newest release *including prereleases*, via `releases | .[0].url`. It matches the asset `BambuStudio_ubu24` with `jq`, and `external_type: github_devel` in its jenkins-vars. It does not use a version build arg at all.
- **Fonts**: `ln -s /opt/bambustudio/resources/fonts /usr/share/fonts/bambustudio && fc-cache -f`, which exposes the app's bundled fonts system-wide (CJK and UI glyphs; **inferred**). The same chmod 755 fix applies.
- **Single-arch**: `MULTIARCH = 'false'`.
- **Autostart** (both X11 and Wayland variants):
  ```sh
  if [ "${DARK_MODE}" = "true" ] && [ ! -f "$HOME/.config/gtk-3.0/settings.ini" ]; then
    mkdir -p $HOME/.config/gtk-3.0
    echo '[Settings]' > $HOME/.config/gtk-3.0/settings.ini
    echo 'gtk-application-prefer-dark-theme=1' >> $HOME/.config/gtk-3.0/settings.ini
  elif [ "${DARK_MODE}" != "true" ] && [ -f "$HOME/.config/gtk-3.0/settings.ini" ]; then
    rm -f "$HOME/.config/gtk-3.0/settings.ini"
  fi
  gio mime x-scheme-handler/http firefox.desktop
  gio mime x-scheme-handler/https firefox.desktop
  /opt/bambustudio/AppRun
  ```
  It documents `DARK_MODE` as `opt_param_env_vars`. It has **no** `svc-dbus` override and **no** `GDK_BACKEND` patch.

**docker-prusaslicer**: does not exist under linuxserver. PrusaSlicer is available as a `proot-apps` app or a webtop mod, which another agent covers.

---

## 8. "Copy as-is" vs "Adapt for Creality Print"

### Copy as-is
- **Base image**: `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie`. Pin it by digest in our repo and let Renovate bump it. The choice should still be confirmed against the Creality AppImage's library needs; see Adapt.
- The `ENV` block shape: `TITLE=Creality Print`, `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, `PIXELFLUX_WAYLAND=true`.
- The icon download into `/usr/share/selkies/www/icon.png`, using our own PNG, for example from the AppImage's `.DirIcon`.
- The Mozilla apt repository plus pinning, and `firefox`, so login and links work.
- The apt set: the gstreamer list, `libgstreamer-plugins-bad1.0`, `libwebkit2gtk-4.1-0` and `libwx-perl`. Keep `libmspack0` until testing shows it is unneeded.
- The **extract-don't-mount** pattern: `--appimage-extract` → `/opt/<app>`, then `find /opt/<app> -type d -exec chmod 755 {} +`.
- `localedef -i en_GB -f UTF-8 en_GB.UTF-8` (consider also `en_US`).
- The `/build_version` file and the cleanup block.
- `root/defaults/{autostart,autostart_wayland,menu.xml,menu_wayland.xml}` with the paths changed.
- `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` → `sleep infinity`. Keep it until testing shows the system bus is harmless.
- `EXPOSE 3001`, `VOLUME /config`, and the `shm_size: 1gb` recommendation.
- The CI idea: wait until the release asset exists before building, then run a screenshot smoke test.

### Adapt for Creality Print
- **Download URL**: `CrealityOfficial/CrealityPrint`. Assets are named like `CrealityPrint-V7.3.1.6378-x86_64-Release.AppImage`, so match `x86_64-Release\.AppImage$`. **v7.3.0 shipped three AppImages with different build numbers (6149/6151/6157)**, and `first()` would pick the oldest. Pick the highest build number, e.g. `[...] | sort_by(capture("\\.(?<b>[0-9]+)-x86_64").b|tonumber) | last`.
- **Version pinning**: actually use the build arg (`/releases/tags/${CREALITYPRINT_VERSION}`); do not repeat LSIO's `releases/latest` bug. Allow the arg to default to "latest" for local builds.
- **Architecture**: amd64 only. There is no aarch64 AppImage, only a v7.3.0 aarch64 flatpak.
- **Prereleases**: Creality marks some releases (e.g. v7.3.2) as prerelease, and `releases/latest` skips them. Decide on a policy, perhaps a separate `beta` tag.
- **Host library check**: run `ldd` on `bin/CrealityPrint` and its bundled libraries after extraction to see what is missing (webkit 4.0 or 4.1? which GStreamer? `libOpenGL`?). Older Orca-derived AppImages bundled some libraries and needed `libwebkit2gtk-4.0-37`; Debian Trixie **does not ship webkit2gtk-4.0**. If Creality still links 4.0, the base distro choice changes (Ubuntu Noble still has 4.0) or we would need to bundle it.
- **Launcher patches**: check whether Creality's `AppRun` is a script, so the `sed` can inject `GDK_BACKEND=x11`, or an ELF binary, in which case we need our own wrapper script. Prefer an **image-owned wrapper** such as `/usr/local/bin/crealityprint` that exports `GDK_BACKEND=x11` (and `LC_ALL`/`LANG` if needed) and `exec`s `AppRun`. Point autostart and the menus at the wrapper so later fixes reach existing `/config` installs.
- **Locale**: upstream Orca's `AppRun` forces `LC_ALL=C`. Check whether Creality does the same, and whether it breaks non-English UI. The README promises `LC_ALL=xx_XX.UTF-8` support.
- **Fonts**: consider BambuStudio's `ln -s /opt/<app>/resources/fonts /usr/share/fonts/<app> && fc-cache -f`, and/or `fonts-noto-cjk`. Creality Print ships CN/JP/KR translations.
- **Dark mode / links**: consider BambuStudio's `DARK_MODE` and `gio mime ... firefox.desktop` autostart snippet, ideally in the wrapper rather than the autostart file.
- **Networking**: Creality Print finds K1/K2/Hi printers by LAN discovery (mDNS/SSDP/UDP broadcast; **inferred**) and streams cameras over WebRTC/HTTP. Document `network_mode: host`, or manual IP entry, for bridge networking. This is the most likely user-visible gap and has no OrcaSlicer precedent.
- **Config path**: probably `/config/.config/Creality/Creality Print/<major.minor>/` (inferred). Verify it, and document which directory to back up.
- **CI**: GitHub Actions instead of Jenkins (§4.4). Keep state in the registry label or a committed version file; build `--no-cache --pull`; run a weekly rebuild.
- **Docs**: write our README directly. There is no jenkins-builder templating.

---

## 9. Open questions for the build session
1. Does the Creality Print AppImage need host `libwebkit2gtk-4.0` or `4.1`? This decides between Debian Trixie and Ubuntu Noble. Which GTK, pango and gstreamer libraries does it bundle?
2. Is Creality's `AppRun` a script (patchable with `sed`) or a binary? Does it set `LC_ALL=C`?
3. Is the system-dbus stub needed for Creality Print? Test with and without it and watch for `hostname1` or `org.freedesktop.*` activation hangs.
4. Does Creality Cloud login (and printer binding) work inside the webview or in-container Firefox? Does it need `gio mime` handlers?
5. Does LAN printer discovery work in bridge mode, or must we document `network_mode: host`?
6. Do we track prereleases, and how do we pick between duplicate assets in one release?
7. Are the AppImage directory modes `700`? Apply the `chmod 755` fix anyway.
