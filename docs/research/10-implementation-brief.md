# 10 — Implementation brief (kickoff for the build session)

Date: 2026-11-21. Read this first in the build session. It turns docs 01–09 into a concrete starting point. Everything marked **[V]** was run in the throwaway `crp-research:*` images. Everything marked **[new]** is a design proposal that hasn't been built yet.

## 1. Goal and scope for v1

The goal is a self-contained `amd64` image that runs **Creality Print** (start at v7.3.1) in the browser through Selkies, built like `linuxserver/docker-orcaslicer`. It should:

- start straight into the app, with optional pre-seeding that skips the first-run wizard;
- keep all settings across restart, re-create and image updates (one `/config` volume);
- use the GPU when `/dev/dri` is passed (Intel/AMD), and work without one (llvmpipe);
- move files through the Selkies Files panel (upload/download via `/config/Desktop`), with an opt-in "auto-open uploads" feature;
- track upstream releases automatically in CI (GitHub Actions + GHCR).

Out of scope for v1: arm64 (no upstream binary), NVIDIA validation, patching the app.

## 2. Proven baseline [V]

This is the throwaway Dockerfile that works (from [07](07-hands-on-baseline.md); source at `scratchpad/agent-D/image/`):

```dockerfile
FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie
ARG CREALITYPRINT_VERSION=v7.3.1
ENV TITLE=CrealityPrint SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt PIXELFLUX_WAYLAND=true
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
      gstreamer1.0-gl gstreamer1.0-libav gstreamer1.0-plugins-bad gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good gstreamer1.0-tools gstreamer1.0-x libwebkit2gtk-4.1-0 && \
    apt-get autoclean && rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/*
RUN DOWNLOAD_URL=$(curl -sX GET "https://api.github.com/repos/CrealityOfficial/CrealityPrint/releases/tags/${CREALITYPRINT_VERSION}" \
      | jq -r 'first(.assets[].browser_download_url | select(test("x86_64-Release\\.AppImage$")))') && \
    cd /tmp && curl -o crp.app -L "${DOWNLOAD_URL}" && chmod +x crp.app && \
    ./crp.app --appimage-extract > /dev/null && mv squashfs-root /opt/crealityprint && \
    sed -i "1a export GDK_BACKEND=x11" /opt/crealityprint/AppRun && \
    find /opt/crealityprint -type d -exec chmod 755 {} + && rm -rf /tmp/*
COPY /root /
EXPOSE 3001
VOLUME /config
```

It also uses `root/defaults/{autostart,autostart_wayland,menu.xml,menu_wayland.xml}` → `/opt/crealityprint/AppRun`, and `root/etc/s6-overlay/s6-rc.d/svc-dbus/run` = `sleep infinity`.

**Change from the baseline:** drop the optional gstreamer packages and install only `libwebkit2gtk-4.1-0`. Both K1C camera paths work without them ([11 §4](11-printer-tests.md)) [V], and the image shrinks to 4.77 GB.

Measured (baseline):

| Measure | Value |
|---|---|
| Build time | 1m14s |
| Image size | 5.02 GB |
| Time to the app's main window | about 4 s |
| Idle | about 2–3 % CPU, about 2.2 GiB RAM |

`seccomp=unconfined` is **not** needed.

## 3. Changes for the real image [new]

1. **Pin the base** to a release tag or digest (e.g. `debiantrixie-f7632021-ls153`) and let Renovate bump it (R7).
2. **Asset selection** (R3): strict regex, take the highest build number, fail when nothing matches, verify the sha256 against the release asset's `digest`:
   ```bash
   jq -r --arg re '^CrealityPrint-V[0-9.]+-x86_64-Release\.AppImage$' '
     [.assets[] | select(.name | test($re))]
     | if length == 0 then error("no matching asset") else . end
     | sort_by(.name | capture("V(?<v>[0-9.]+)-").v | split(".") | map(tonumber))
     | last | "\(.browser_download_url) \(.digest)"'
   ```
3. **Build-time guard:** `ldd /opt/crealityprint/bin/CrealityPrint | grep 'not found'` must print nothing, or the build fails.
4. **A stable wrapper** `/usr/local/bin/crealityprint` that never moves (R2). It's the only thing autostart and the menus call:
   ```bash
   #!/bin/bash
   # Image-owned launcher: autostart in /config is copied once and never refreshed,
   # so every launch-time fix must live here, not in /defaults/autostart.
   export GDK_BACKEND=x11
   exec /opt/crealityprint/AppRun "$@"
   ```
   Then drop the `sed` into AppRun, or keep both. Point `/defaults/autostart{,_wayland}` and both menus at `/usr/local/bin/crealityprint`.
5. **Init oneshot `init-crealityprint-config`.** s6 wiring follows the lsio pattern: `dependencies.d/init-config`, and add it to `init-config-end/dependencies.d/`. `user/contents.d/init-crealityprint-config`, `type`=`oneshot`, `up`=path to `run`. It should:
   - **Fix ownership** (R1): if `stat -c %u /config/.config` ≠ `$(id -u abc)`, `chown -R abc:abc` `/config/.config /config/.local /config/.cache`.
   - **First-run seed** (only when **no** `/config/.config/Creality/Creality Print/*/` exists; otherwise we would block the app's own migration):
     - Always: `privacyInfo.json` = `{"list":[{"check":false,"version":"7.3.0.0"}]}`. This is the telemetry opt-out, which removes the dialog [V].
     - Always: a minimal `Creality.conf` with `recent.last_opened_folder` and `app.last_export_path` set to `/config/Desktop` [V, 06].
     - Opt-in via env (e.g. `CP_REGION=Europe`, `CP_PRINTER="Creality K1"`): a full seed with `app.region`, `app.is_first_install="1"`, `firstguide.finish`, `models[]` and `presets{}`. **A seed without `models` + `presets` leaves an unusable empty printer** [V, 05 T6]. Sample JSON is in [05 T6](05-settings-persistence.md).
   - On later starts: if `recent.last_opened_folder` is missing, add it with `jq` (keep the user's value otherwise).
6. **Opt-in upload watcher** (`AUTO_OPEN_UPLOADS=true`), using the **`ft-watcher2` design** [V, [12 §1.5](12-remaining-hands-on.md)]. Source at `scratchpad/agent-R/image-watcher2/`; the design is also documented in doc 12. Do *not* use the first `ft-watcher` prototype, which is broken (R20).
   - It's an s6 longrun depending on `svc-de`, using `inotify-tools`.
   - It watches `${FILE_MANAGER_PATH:-/config/Desktop}` for a `.selkies-upload-*` → final-name rename.
   - It then calls the running app's single-instance D-Bus method (`dbus-send … InstanceCheck.Object<hash>.AnotherInstance "string:/opt/crealityprint/bin/CrealityPrint;<quoted path>"`, arguments joined with `;`) with `DISPLAY=:0` forced.
   - It starts the app with the file only when no instance is on the bus.
   - It does not edit `Creality.conf` at runtime.
   - Default pattern: meshes only (`stl|obj|step|stp|amf|ply|oltp`). Offer `3mf` as an option (the app asks before replacing a dirty project).
   - Result: STLs are added to the current plate, and unsaved work survives.
7. **Icon:** extract `.DirIcon`/`CrealityPrint.png` from the AppImage to `/usr/share/selkies/www/icon.png`.
8. **Labels:** `org.opencontainers.image.version=${tag}`, `source=<our repo>`, plus a `crealityprint.upstream=https://github.com/CrealityOfficial/CrealityPrint/releases/tag/${tag}` label (AGPL, R21).
9. **Don't add:** the optional gstreamer packages (not needed for the camera, see §2), `vainfo` (R8), `fonts-adwaita`/variable UI fonts (R6), `libwx-perl`, or a `localedef` (`AppRun` forces `LC_ALL=C`). Firefox only if we decide to support third-party OAuth login (R10).
10. **Optional:** `mesa-utils` for `glxinfo` diagnostics. It's harmless [V].

## 4. Proposed repo layout [new]

```
Dockerfile
root/
  defaults/autostart                  # /usr/local/bin/crealityprint
  defaults/autostart_wayland          # /usr/local/bin/crealityprint
  defaults/menu.xml, menu_wayland.xml # terminal + "Creality Print" → wrapper
  defaults/crealityprint/privacyInfo.json
  defaults/crealityprint/Creality.conf.tmpl
  usr/local/bin/crealityprint         # stable wrapper (0755)
  usr/local/bin/crp-upload-watcher    # opt-in
  etc/s6-overlay/s6-rc.d/svc-dbus/run                   # sleep infinity (from orcaslicer)
  etc/s6-overlay/s6-rc.d/init-crealityprint-config/{type,up,run,dependencies.d/init-config}
  etc/s6-overlay/s6-rc.d/init-config-end/dependencies.d/init-crealityprint-config
  etc/s6-overlay/s6-rc.d/svc-upload-watcher/{type,run,dependencies.d/svc-de}
  etc/s6-overlay/s6-rc.d/user/contents.d/{init-crealityprint-config,svc-upload-watcher}
.github/workflows/{check-upstream.yml,build.yml}
docker-compose.example.yml
README.md
```

(Follow the user's shell-script style: small named functions, descriptive variables, multi-line `if`s, and a *why* comment per section.)

## 5. docker-compose example [V except where noted]

```yaml
services:
  crealityprint:
    image: ghcr.io/<owner>/crealityprint:latest
    container_name: crealityprint
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Copenhagen
      # - PASSWORD=change-me              # basic auth on UI *and* file API (R9)
      # - SELKIES_FILE_TRANSFERS=none     # really disables upload/download (R9)
      # - AUTO_OPEN_UPLOADS=true          # [new] opt-in watcher
    volumes:
      - ./config:/config                  # all settings, presets, login, projects
      # - /mnt/nas/3d:/config/Desktop/nas # NAS folder visible in Files panel + app
    ports:
      - 3001:3001                         # HTTPS (required for full client features)
    devices:
      - /dev/dri:/dev/dri                 # Intel/AMD GPU; omit for CPU-only
    shm_size: "1gb"
    # Default bridge networking is fine: add the printer by IP (status, upload,
    # MJPEG + WebRTC camera all verified with a K1C).
    # network_mode: host                  # only for printer auto-discovery (R5); needs a host
    #                                     # firewall rule for UDP 5353 replies [unverified]
    # mac_address: 02:42:ac:11:00:99      # stable cloud device id (R11) [inferred]
    restart: unless-stopped
```

NVIDIA (desk only, see [04 §5](04-gpu-acceleration.md)): `runtime: nvidia` plus `deploy.resources.reservations.devices: [{driver: nvidia, count: all, capabilities: [compute,video,graphics,utility]}]` plus `/dev/nvidia-modeset`, with host driver ≥ 580.

## 6. CI / version tracking [new], from [02 §4.4](02-docker-orcaslicer.md) and [03 §2.3](03-creality-print.md)

- `check-upstream.yml` (cron every 6 h plus manual):
  1. `gh api repos/CrealityOfficial/CrealityPrint/releases/latest --jq .tag_name`. Require `^v\d+\.\d+\.\d+$`.
  2. Confirm a matching asset exists.
  3. Compare with the `org.opencontainers.image.version` label on `ghcr.io/<owner>/crealityprint:latest`, or open a PR bumping `ARG CREALITYPRINT_VERSION` (Renovate `github-releases` custom manager is the low-code option). The PR route fits the review-before-merge workflow.
- `build.yml`: buildx `linux/amd64`, build-arg `CREALITYPRINT_VERSION`, tags `latest`, `<ver>` and `<ver>-r<run>`. Run a weekly rebuild for base/security updates.
- **Smoke test in CI**:
  1. Run the container.
  2. Wait for `[ls.io-init] done.`.
  3. `curl -k https://localhost:3001` returns 200.
  4. `docker exec … pgrep -u abc CrealityPrint`.
  5. Optionally take a Playwright screenshot. On hosts without a browser, use `mcr.microsoft.com/playwright:v1.49.0-noble --network host`. Use Google Chrome, not Chromium, if the test inspects the H.264 stream ([04](04-gpu-acceleration.md)).
- Prerelease policy (open decision): stable only via `releases/latest`, or an extra `:beta` tag for prerelease builds.

## 7. Acceptance test checklist for v1

Run on a fresh `/config` **and** an existing one. The scripts and expectations in docs 04–06 can be reused.

- [ ] The main window appears with no wizard when seeded; the wizard appears when not seeded.
- [ ] Persistence: printer, custom preset and a preference survive `docker rm -f` + re-create ([05 T2](05-settings-persistence.md)).
- [ ] Upgrade: same-epoch image bump keeps settings ([05 T4](05-settings-persistence.md)).
- [ ] PUID change on an existing `/config` still starts (R1 fix).
- [ ] With `/dev/dri`: `glxinfo -B` on `:0` reports the Intel GPU, the log says `Zero-copy … VAAPI`, CPU while orbiting is ≪ the no-GPU run ([04](04-gpu-acceleration.md)).
- [ ] Without `/dev/dri`: llvmpipe, x264, the app still usable.
- [ ] Upload an STL via the Files panel → it lands in `/config/Desktop`, and Import opens there. Export G-code → download through the Files panel, sha256 matches ([06](06-file-transfer.md)).
- [ ] `SELKIES_FILE_TRANSFERS=none` → 403; `PASSWORD` → 401 on the file API.
- [ ] The right-click menu relaunches the app after killing it; `RESTART_APP=true` auto-relaunches.
- [ ] Preferences dialog opens (pango regression check, R7); slice + Preview works.
- [ ] Clipboard over HTTPS: text both ways ([12 §2](12-remaining-hands-on.md)). Plain HTTP on a LAN IP gives a black page (documented, not a bug).
- [ ] Drag-and-drop via CDP `Input.dispatchDragEvent` lands in `/config/Desktop`. With the watcher on, the model appears on the plate and unsaved work is kept ([12 §1, §3](12-remaining-hands-on.md)).
- [ ] With a real printer, **upload-only**: add by IP, status, "Send Only" G-code upload, camera view, printer still listed after re-create ([11](11-printer-tests.md)). **Never start a print as a test** (R5b).
- [ ] Manual: email/QR cloud login; host-network discovery on a host without a firewall; one real OS drag-and-drop; Firefox clipboard.

## 8. Decisions to make at the start of the build session

1. Image name/registry and repo layout (`ghcr.io/<owner>/crealityprint`?).
2. Prerelease policy (R3): stable only, or a `:beta` tag?
3. Firefox in the image for third-party login and external links (+~250 MB) (R10)?
4. Pre-seed UX: env-driven printer seed (`CP_PRINTER`, `CP_REGION`) or wizard-only?
5. Upload watcher (`ft-watcher2` design): ship in v1 as opt-in, or defer?

(Settled since the first pass: drop the optional gstreamer packages; bridge networking + add-by-IP is the default.)

## 9. Research artefacts still on disk

These are in the session scratchpad (they can be lost on reboot) and in Docker. They're useful for reference and safe to remove:

- Scratchpad: `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-{A..H,P,R}/`, including the baseline Dockerfile (`agent-D/image/`), the no-gstreamer variant (`agent-P/image-no-gst/`), the working watcher (`agent-R/image-watcher2/`), test scripts and screenshots.
- Docker images:
  - `crp-research:{baseline,no-gst,gpu-diag,persist-7.3.2,persist-7.2.1,ft-watcher,ft-watcher2,pw-chrome}` (about 5 GB each, mostly shared layers)
  - `ghcr.io/linuxserver/baseimage-selkies:debiantrixie`
  - `lscr.io/linuxserver/orcaslicer:latest`
  - `mcr.microsoft.com/playwright:v1.49.0-noble`

  Remove them with `docker rmi` when done.
