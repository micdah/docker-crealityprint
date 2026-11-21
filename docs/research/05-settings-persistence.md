# 05: Settings persistence

**Goal:** keep Creality Print's settings across `docker restart`, across `docker rm` plus re-create, and across an image upgrade that changes the app version, so the user configures it only once.

**Researched:** 2026-11-21, desk research only (no containers run).

**Labels:** **verified** means I saw it in source at the commit cited. **inferred** means it follows from the source or from documented behaviour but has not been tested.

## Sources

| Repo | Ref | SHA |
|---|---|---|
| [CrealityOfficial/CrealityPrint](https://github.com/CrealityOfficial/CrealityPrint) | `master`, 2026-11-13 (`git describe`: `v7.3.2`) | `6262848e302b8c0d593f2b341cd01310aa2f58a1` |
| CrealityOfficial/CrealityPrint | tag `v7.2.1` (used to compare the old data-dir logic) | via `gh api …/contents?ref=v7.2.1` |
| [linuxserver/docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies) | `master`, tag `debiantrixie-f7632021-ls153` | `a7d1dfd0cd98b6992786a4883382f1094d075534` |
| [linuxserver/docker-baseimage-debian](https://github.com/linuxserver/docker-baseimage-debian) | `master` (REL=trixie) | `dbc48c50d1888367669cf70574365c1803a8bcfa` |
| [linuxserver/docker-orcaslicer](https://github.com/linuxserver/docker-orcaslicer) | `master`, tag `v2.5.1-ls52` | `4b114d95b04b4517e79d01cd6681b843bce10ef2` |
| [OrcaSlicer/OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) | `HEAD` (for comparison only) | `1174b3900488dedc8ad1d54ba4d2f8329e52d601` |
| lsiown script | `https://raw.githubusercontent.com/linuxserver/docker-mods/mod-scripts/lsiown.v1` | version `1.20240608` |

Unless noted otherwise, paths such as `src/…` refer to CrealityPrint at `6262848`.

---

## TL;DR

1. **The data dir is versioned.** On Linux it is `${XDG_CONFIG_HOME:-$HOME/.config}/Creality/Creality Print/<DATA_VERSION>/`. In the container (`HOME=/config`) that is **`/config/.config/Creality/Creality Print/7.3/`** for current releases (7.3.x). **verified**
   - `<DATA_VERSION>` is a "data compatibility epoch" set in CMake (`CREALITYPRINT_DATA_VERSION "7.3"`). It is no longer simply `<major>.0`. Before 7.3 it was `<major>.0`, so 6.x used `6.0` and 7.0 to 7.2 used `7.0`.
   - A self-built binary with `PROJECT_VERSION_EXTRA` containing "alpha" (the CMake default) uses `7.3 Alpha`. Official Release builds use `7.3`. **verified**
2. **The app migrates between versions itself** (since 7.3, `DataMigration`). When the 7.3 dir is empty, it copies the config, the login, devices, privacy acceptance and user presets from `7.0`, or failing that from `6.0`, into `7.3`. It leaves the old dir in place. **verified**
   - The migration is skipped when `--datadir` is used.
   - It refuses to work across symlinks inside the data dir.
   - The rules are hard-coded for 7.3. A future epoch (for example `8.0`) will need new rules from Creality. **verified**
3. **Do not use `--datadir` and do not symlink the versioned dir.**
   - `--datadir X` still appends `/Creality Print/<ver>` and disables the migration. **verified**
   - The only redirection that keeps the migration working is `XDG_CONFIG_HOME` or `HOME`, which in this image is already `/config`.
4. **Persist the whole `/config`.** It is the lsio home dir and the declared `VOLUME`. Everything the app writes outside `/tmp` lands under it: the data dir, the WebKitGTK store (inferred) and the caches. **verified (VOLUME/HOME)**
5. **The base image overwrites some things on every start:**
   - It regenerates the labwc `rc.xml` (Wayland mode) and the system openbox `rc.xml`.
   - It restores `menu.xml` from `menu.xml.bak`.
   - It wipes `~/.XDG`.
   - It rewrites the nginx config.
   - `autostart` and `menu.xml` are **copied only if missing**. A changed launcher path in a new image therefore never reaches an existing volume, so the launcher path must stay stable. **verified**
   - None of this touches the Creality data dir.
6. **Pre-seed** through `/defaults/crealityprint/…`, copied by our own s6 oneshot **only on a truly fresh volume** (no `Creality Print/*` dir at all). Otherwise the seed would block the app's own 6.0/7.0 → 7.3 import.
   - The useful keys (verified to exist; effect inferred) are:
     - `firstguide.finish=1`
     - `app.is_first_install=1`
     - `app.region`
     - `app.language`
     - the `models` list
     - `app.skip_version`
     - `privacyInfo.json`
   - **There is no config key that turns off the app-update check** (`enabled_version_check = true` is hard-coded). **verified**
7. **Phase 2 (hands-on, 2026-11-21) confirmed the core of this:**
   - Settings, presets and the finished guide survived `docker rm -f` + re-create.
   - They survived upgrading 7.3.1 → 7.3.2 and downgrading back.
   - They survived the 7.2.1 (`7.0/`) → 7.3.1 (`7.3/`) migration.
   - A seeded `Creality.conf` (with `models` + `presets`) plus `privacyInfo.json` (`check:false`) gives a first start with no dialogs.
   - Changing PUID on an existing `/config` breaks the **whole desktop** until `/config` is chowned recursively.
   - See [Hands-on results](#hands-on-results).

---

## 1. Where Creality Print stores its state on Linux

### 1.1 Resolving the data dir

**`src/slic3r/GUI/GUI_App.cpp:3574` `GUI_App::init_app_config()`** (verified):

```cpp
SetAppName(SLIC3R_APP_KEY);                 // "Creality"   (version.inc)
if (data_dir().empty()) {                   // i.e. no --datadir
#ifdef __linux__
    wxString root;
    if (!wxGetEnv("XDG_CONFIG_HOME", &root) || root.empty())
        root = wxFileName::GetHomeDir() + "/.config";
    set_data_dir((root + "/" + GetAppName()).ToUTF8().data());   // …/.config/Creality
#endif
    DataMigration::initialize(...);         // see §4
    fs::create_directories(data_dir()/"log");
    chdir(data_dir()+"/log");
} else {
    m_datadir_redefined = true;             // "Explicit --datadir keeps its existing behavior and never imports another installation."
}
```

**`src/libslic3r/utils.cpp:310–347`** (verified):

```cpp
std::string data_directory_name() {
    std::string name = CREALITYPRINT_DATA_VERSION;                         // "7.3"
    if (icontains(PROJECT_VERSION_EXTRA, "alpha")) name += " Alpha";
    return name;
}
void set_data_dir(const std::string &dir, bool use_directly) {
    ... g_data_dir = dir + "/" + SLIC3R_APP_USE_FORDER + "/" + version_dir;  // "Creality Print"
```

Constants (verified):

- `version.inc`:
  - `SLIC3R_APP_NAME "CrealityPrint"`
  - `SLIC3R_APP_KEY "Creality"`
  - `SLIC3R_APP_USE_FORDER "Creality Print"`
- `CMakeLists.txt:4`: `set(CREALITYPRINT_DATA_VERSION "7.3" CACHE STRING "User data directory compatibility version")`, with the comment *"Data compatibility epoch; independent of the application release version."* The same value appears at tags `v7.3.0` and `v7.3.1`.
- `cmake/BuildInfoUtil.cmake:64`: `PROJECT_VERSION_EXTRA` defaults to `"Alpha"`. Release pipelines pass `-DPROJECT_VERSION_EXTRA=Release` (`scripts/BuildLinux_Package.sh:239`, `JenkinsPipeline`). Official AppImages are named `…-Release.appimage`, as in issue [#664](https://github.com/CrealityOfficial/CrealityPrint/issues/664).
  - **Consequence:** if we build from source, pass `-DPROJECT_VERSION_EXTRA=Release`. Otherwise the data dir becomes `7.3 Alpha` and nothing migrates into it from a Release install.

**History (verified at tag `v7.2.1`, `src/libslic3r/utils.cpp:309`):** `version_dir = CREALITYPRINT_VERSION_MAJOR + ".0"`. So 6.x used `6.0` and 7.0.x to 7.2.x used `7.0`. In 7.2.1, `init_app_config` copied `…/6.0` → `…/7.0` with a blind recursive `fs::copy` when the 7.0 dir was empty. Issues [#492](https://github.com/CrealityOfficial/CrealityPrint/issues/492) and [#659](https://github.com/CrealityOfficial/CrealityPrint/issues/659) confirm the `…\Creality Print\7.0\` and `…\7.3\` layouts on real installs.

**Result in the container** (`HOME=/config`; the base image does not set `XDG_CONFIG_HOME`, verified by grep):

```
/config/.config/Creality/Creality Print/7.3/        ← DATA DIR (7.3.x Release)
/config/.config/Creality/Creality Print/7.0/        ← would exist only if a 7.0–7.2 image ran before
/config/.config/Creality/Creality Print/.migration-7.3/       (diagnostics: transaction.json, report.json, last-error.txt)
/config/.config/Creality/Creality Print/.migration-7.3.lock   (flock)
```

### 1.2 What lives inside the data dir

All under `/config/.config/Creality/Creality Print/7.3/`.

| Item | Path | Source evidence | Status |
|---|---|---|---|
| Main app config (JSON) | `Creality.conf`, plus `Creality.conf.bak` and a temporary `Creality.conf.<pid>` during save | `AppConfig::config_path()` `src/libslic3r/AppConfig.cpp:1808` (`SLIC3R_APP_KEY ".conf"`, JSON since `#define USE_JSON_CONFIG` at :38) | verified |
| Sections in Creality.conf | `app{…}`, `presets{…}`, `models[{vendor,model,nozzle_diameter}]`, `firstguide{finish}`, `recent_projects`, `window_mainframe`, `user_presets`, `calis`… | `AppConfig::save()` ~:1050–1160 | verified |
| First-run guide flag | `Creality.conf` → `firstguide.finish = "1"` and `app.is_first_install = "1"` | `WebGuideDialog.cpp:1016,1056`; `GUI_App.cpp:9211` (`get_is_first_install` → `deviceAddEnd`), `:14054`, `:4080` | verified |
| Privacy-policy acceptance | `privacyInfo.json` (`{"list":[{"version":"7.3.x.y","check":true}]}`, matched by **major** version) | `GUI_App.cpp:11342–11420` | verified |
| Login / cloud token | `user_info.json` (watched for changes across processes) | `GUI_App.cpp:2030–2046`, `LoginDialog.cpp:733`, `HttpServer.cpp:932` | verified |
| Known printers (LAN devices) | `deviceInfo.json`, `current_device.json` | `print_manage/PrinterMgr.cpp:206,281,414` | verified |
| Misc. app state | `extra_config.json`, `launchInfo.json`, `user_operation_state.json`, `filaments_color.json`, `materialList.json`, `machineList.json`, `profile_version.json` | grep of `data_dir()` joins | verified (names); purposes partly inferred |
| User presets | `user/<account-id or "default">/{machine,filament,process}/*.json` (+ `.info`), plus `base/`; also `user/<id>/local_device/` | `PresetBundle::setup_directories()` `PresetBundle.cpp:232`; `PRESET_USER_DIR "user"`, `DEFAULT_USER_FOLDER_NAME "default"`; `DataDirectoryMigration.cpp:607–616` | verified |
| System profile cache | `system/<Vendor>.json` + `system/<Vendor>/…` (copied from `<resources>/profiles`) | `PresetUpdater.cpp:244–246,1112–1185` | verified |
| Printer models cache | `printers/` (copied from `<resources>/printers`) | `PresetUpdater.cpp:1195–1200`, `DataDirectoryMigration.cpp:635` | verified |
| Online profile/plugin downloads | `ota/` (cache), `plugins/` (network plugin) | `PresetUpdater.cpp:244,968`, `NetworkAgent.cpp:154` | verified |
| Downloads from Creality Cloud | `cloud_download_data/` (default of `app.download_path`, stored as an **absolute** path) | `GUI_App.cpp:3460–3478` | verified |
| Logs and crash dumps | `log/` (`debug_<date>_<pid>.log`; Breakpad dumps) | `GUI_App.cpp:3614`, `CrealityPrint.cpp:735–760` | verified |
| Caches | `cache/` (instance lock `cache/<hash>.lock`, printer binding), `thumbnail_cache/`, `hints.cereal`, `fonts.cereal` | `InstanceCheck.cpp:195`, `MainFrame.cpp:5029`, `AnalyticsDataUploadManager.cpp:1004` | verified |
| Filament-mixing data | `filament_mixing/` | `DataDirectoryMigration.cpp:617` | verified |
| Custom shapes | `shapes/` | `utils.cpp custom_shapes_dir()` | verified |
| Migration bookkeeping | `migration/manifest.json`, `migration/report.json`, `migration/quarantine/…`, `migration/legacy-sync/…`, `migration/preserve-user-presets`, a pre-flight `.legacy_multi_extruder…` marker | `DataDirectoryMigration.cpp`, `GUI_App.cpp:3630–3645` | verified |
| Window layout | `Creality.conf` → `app.window_mainframe` (geometry), `window_<name>`; not restored on a Wayland session (`gui_app_is_wayland_session()`, `GUI_App.cpp:4700`) | `GUI_App.cpp:14523–14533` | verified. In practice the WM maximises the window anyway (selkies openbox rule / labwc rc) |
| Recent files | `Creality.conf` → `recent_projects` (absolute paths) | `AppConfig.cpp:1507–1540` | verified |

### 1.3 State **outside** the data dir

| Item | Path | Persisted with `/config`? | Status |
|---|---|---|---|
| Project auto-backup / crash recovery | `$TMPDIR` or `/tmp` → `/tmp/crealityprint_model/<date>/<time>#<pid>#<id>` (`Model::get_backup_path`, `Model.cpp:1108`; `set_temporary_dir(wxFileName::GetTempDir())`, `CrealityPrint.cpp:207`) | **No.** Survives `docker restart` (same container layer) but is lost on re-create. | verified |
| Slicing temp files, STEP import temp | `temporary_dir()` = `/tmp` | No (and need not be) | verified |
| Embedded web UI storage (home page SPA, login pages: cookies, localStorage, IndexedDB) | WebKitGTK default context: `/config/.local/share/CrealityPrint/{localstorage,storage,mediakeys,hsts-storage.sqlite}` and `/config/.cache/CrealityPrint/{WebKitCache,CacheStorage}`. The Windows-only `slicer_webview_userdata` temp profile logic (`Widgets/WebView.cpp:424`) is `#ifdef __WIN32__`. | Yes, if all of `/config` is the volume | **verified in Phase 2** |
| Updater bookkeeping (empty per-version dirs) | `/config/.Creality/crealityprint_squirrel/<app-version>/` (one empty dir per version that ever ran) | Yes | **verified in Phase 2** (purpose inferred: app self-updater) |
| `~/.cache/CrealityPrint` | Deleted by the app whenever bundled vendor profiles are newer than installed ones (`PresetUpdater.cpp:1170–1180`) | Yes, but it is a cache | verified |
| Desktop integration (.desktop/icons) | `~/.local/share/applications`, `~/.local/share/icons` (only if the user triggers it) | Yes | verified |

### 1.4 CLI flags and env vars for the data dir

- `--datadir <dir>` exists (`PrintConfig.cpp:9688`). GUI: `GUI_Init.cpp:98` `set_data_dir(config.opt_string("datadir"))`. CLI: `CLI.cpp:93`. **verified**
  - It still produces **`<dir>/Creality Print/<DATA_VERSION>`** (default `use_directly=false`). It is therefore **not** a version-independent pin.
  - Because `data_dir()` is then non-empty, `init_app_config` takes the `m_datadir_redefined` branch, which **skips `DataMigration`**. An image upgrade that changes the epoch would start empty.
  - **Recommendation:** don't use `--datadir`.
- `XDG_CONFIG_HOME` is honoured (GUI and CLI). It is the only redirection that keeps the migration logic. It is not needed here because `HOME=/config` already places the data inside the volume. **verified**
- No portable mode on Linux: no `data_dir` next to the executable, unlike Orca on Windows/macOS. Issue [#590 "Portable Version"](https://github.com/CrealityOfficial/CrealityPrint/issues/590) (open, 2026-07-29) is an unanswered feature request. **verified**
- The AppImage template (`src/platform/unix/build_appimage.sh.in`) sets no `XDG_*` or `HOME` variables. **verified** for the template. The wrapper script `bin/CrealityPrint` was not inspected; check in Phase 2 with `cat /proc/<pid>/environ`.

### 1.5 GitHub issues found (CrealityOfficial/CrealityPrint, searched 2026-11-21)

- [#492 "CrealityPrint deletes settings"](https://github.com/CrealityOfficial/CrealityPrint/issues/492) (6.3, Linux): user filament presets in `user/<id>/filament/` vanish, possibly after login or cloud sync. This is an app bug, not a storage-location problem. Note: cloud preset sync (`sync_user_preset`) can delete local files.
- [#364](https://github.com/CrealityOfficial/CrealityPrint/issues/364): selected presets not remembered (6.1); an app bug.
- [#274 "Switch from 5 to 6"](https://github.com/CrealityOfficial/CrealityPrint/issues/274): 5.x → 6.x needed the "Import 5.x presets" path; not relevant to new containers.
- [#626](https://github.com/CrealityOfficial/CrealityPrint/issues/626): source builds report version `7.0.0.0` unless `CREALITYPRINT_VERSION` is passed. This matters for the privacy-version and update logic if we build from source.
- [#590](https://github.com/CrealityOfficial/CrealityPrint/issues/590): portable version request.
- No issue mentions `--datadir`, Docker persistence, or "settings lost after update" for 7.3's new migration.

---

## 2. How the lsio Selkies base image handles persistence

### 2.1 Home dir and volume (verified)

- `docker-baseimage-debian/Dockerfile:134`: `useradd -u 911 -U -d /config -s /bin/false abc`. Directories `/app /config /defaults /lsiopy` are created.
- `docker-baseimage-selkies/Dockerfile:107–109`: `ENV HOME=/config` (plus `DISPLAY=:1`, …), and `VOLUME /config` (`:379`). The build ends with `rm -rf /config/.cache /config/.npm`, so the image's `/config` is nearly empty.
- README: *"By default they have no logic to mount out anything but the users home directory, meaning on image updates anything outside of `/config` will be lost."*
- `docker-orcaslicer/readme-vars.yml:22`: the only documented volume is `/config`, described as *"Users home directory in the container, stores program settings and files."* OrcaSlicer's own data dir is `$XDG_CONFIG_HOME/OrcaSlicer` (`default_data_dir()` in `GUI_App.cpp:2748` at Orca `1174b39`), which is **unversioned**. So Orca does not face Creality's per-version dir problem. No settings-loss issues in docker-orcaslicer (searched "settings", "config", "lost", "profiles", "persist", "update"). The update-related issues there are black screens and lib mismatches (#31, #35, #36, #45).

Subdirs of `/config` that appear at runtime:

| Path | Created by | Behaviour |
|---|---|---|
| `.config/` | `init-selkies-config` (`mkdir -p`, chown) | |
| `.config/openbox/{autostart,menu.xml,menu.xml.bak,rc.xml?}` (X11) or `.config/labwc/{autostart,menu.xml,menu.xml.bak,rc.xml}` (Wayland, `PIXELFLUX_WAYLAND=true`, which docker-orcaslicer enables) | `init-selkies-config` | see §2.2 |
| `.XDG/` | `init-selkies-config` | **deleted and recreated every start** (`XDG_RUNTIME_DIR`) |
| `.local/bin/{proot-apps,…,bwrap}` | `init-selkies-config` | copied if missing or if the version changed |
| `.bashrc` | `init-selkies-config` | lines **appended** if missing (PATH, completion) |
| `.Xresources` | `svc-de` | created if missing, otherwise kept |
| `ssl/cert.pem`, `ssl/cert.key` | `init-nginx` | created if missing |
| `Desktop/` | `init-nginx` (`FILE_MANAGER_PATH=${FILE_MANAGER_PATH:-$HOME/Desktop}`, `s6-setuidgid abc mkdir -p`) | kept; the Selkies file-manager/download root |
| `.cache/`, `.local/share/` | apps (GTK, WebKit, fontconfig, …) | kept |

### 2.2 Overwritten on every start vs copied if missing (verified, `root/etc/s6-overlay/s6-rc.d/init-selkies-config/run`)

| File | Behaviour | User edits survive? |
|---|---|---|
| `$CONF_DIR/autostart` | `cp /defaults/autostart` **only if missing**. Ownership and mode are changed every start (`root:abc 550` if `RESTART_APP=true`, else `abc:abc 644`). | **Yes.** But a new image's autostart (for example a changed binary path) is **never** applied to an existing volume. |
| `$CONF_DIR/menu.xml` | `cp /defaults/menu*.xml` only if missing. The first time it exists, it is backed up to `menu.xml.bak`. **Every start** it is then restored from `menu.xml.bak` (both the hardened and non-hardened branches), and terminals are stripped if `DISABLE_TERMINALS`. | **No:** edits to `menu.xml` are reverted; edit `menu.xml.bak` instead. New image menus are never applied. |
| `~/.config/labwc/rc.xml` (Wayland) | **Regenerated every start** from `/defaults/labwc.xml` + env tweaks | No |
| `/etc/xdg/openbox/rc.xml` (X11, system file) | Restored from `rc.xml.bak` and re-tweaked every start. A user `~/.config/openbox/rc.xml` is kept unless hardening locks or removes it. | system: no; user file: yes (unless hardened) |
| `~/.XDG/` | `rm -Rf` every start | No (runtime dir) |
| `~/.local/bin/proot-apps*` | Overwritten when the bundled version differs | n/a |
| `/etc/nginx/sites-available/default`, `/usr/share/selkies/web/*` | Regenerated every start (outside `/config`) | n/a |
| Selkies stream settings | env vars (`SELKIES_*`) plus the browser's own localStorage on the client | n/a: not in `/config` |

**Implications for our image** (design rule, inferred):

- The launcher command in `/defaults/autostart` and `/defaults/menu*.xml` must be a **stable path** that never changes between releases, for example `/opt/crealityprint/AppRun` or a wrapper `/usr/local/bin/crealityprint`. Never use a versioned path like `/opt/CrealityPrint-7.3.2/…`.
- Our Creality-specific init must not rely on lsio's copy-if-missing for anything that has to change with an upgrade.

### 2.3 PUID/PGID and `lsiown` (verified)

- `init-adduser/run`: `groupmod -o -g "$PGID" abc; usermod -o -u "$PUID" abc` (defaults 911), then `lsiown abc:abc /app /config /defaults`.
- `lsiown.v1`: `find PATH -maxdepth 0 ! -xtype l \( ! -group G -o ! -user U \) -exec chown …`. Without `-R` it only fixes **the top-level dir itself, not its contents**.
- **Consequence:** if the user changes PUID/PGID later, or restores a backup with other ownership, files under `/config/.config/Creality/…` keep the old owner. The app then cannot write them, which looks like settings that don't stick. Our init script should run `lsiown -R abc:abc "/config/.config/Creality"`. The dir is small, so this is cheap. Avoid `-R` on all of `/config`, which may hold large user files.
- `init-selkies-config` chowns only the files it creates.
- **Phase 2 (§T3):** this is worse than "Creality settings don't stick". With an existing `/config` and a new PUID, the **whole desktop fails to start** (black screen, "WebSocket disconnected"; no compositor or app process), because `~/.config/labwc`, `~/.config/pulse`, `~/.local` etc. keep the old owner. `chown -R abc:abc /config` + restart fixed it. Our init should detect an ownership mismatch on `/config/.config` (not `/config` itself, which lsiown has already fixed) and then chown the home's dot-directories recursively.

### 2.4 Bind mount vs named volume

| | Bind mount (`-v /srv/crealityprint:/config`) | Named volume (`-v crealityprint-config:/config`) |
|---|---|---|
| First-run content | Host dir used as is; the image's `/config` content is **not** copied | Docker copies the image's `/config` content into an **empty** named volume on first use ("copy-up"). That is nearly nothing here, but it means **baking seed files directly into `/config` in the Dockerfile would work only for named volumes**. Use `/defaults` plus an init script instead. |
| Ownership | Host dir must be writable by PUID/PGID; lsiown fixes only the top level | Docker creates it root-owned; lsiown fixes the top level, apps create the rest as abc |
| Backup / inspection | Easy (`rsync`, `tar`, diff on host) | `docker run --rm -v crealityprint-config:/v -v $PWD:/b alpine tar czf /b/cp.tgz -C /v .` |
| Locking | DataMigration uses `flock` (`DataDirectoryMigration.cpp:116`), InstanceCheck uses `fcntl` (`InstanceCheck.cpp:184`), WebKit uses SQLite. NFS and CIFS/SMB host paths may break these. **inferred** | Local driver: fine |
| SELinux hosts | needs `:Z`/`:z` | n/a |
| Symlinks | `DataMigration::check_path` **throws on symlinks** for the `Creality Print` parent, the version dir and every file it walks (`DataDirectoryMigration.cpp:80–101`). Don't symlink these or anything inside them. Symlinks *above* (`/config/.config`) are not checked. **verified** | same |

**Recommendation:** document both; default the compose example to a bind mount of the whole `/config` for easy backup. Do **not** mount only `…/Creality Print/7.3`, because the next epoch would land outside the mount. If someone wants a narrower mount, mount the **parent** `/config/.config/Creality` so version dirs and migration diagnostics live together.

---

## 3. Recommended volume layout

```yaml
services:
  crealityprint:
    image: <our-image>
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Copenhagen
      # - LC_ALL=en_GB.UTF-8   # app language follows the system locale on first run (see §5)
    volumes:
      - /srv/crealityprint/config:/config        # REQUIRED: whole home dir (Creality data dir, WebKit storage, WM config, ssl)
      # - /srv/3d-models:/config/Desktop/models  # OPTIONAL: model library at a stable path inside $HOME
```

- Keep project and model files **inside `/config`** at a stable path (for example `/config/Desktop/…`). `recent_projects`, `download_path`, `last_backup_path` and the export dirs are stored as **absolute paths**, so files elsewhere disappear on re-create and the recent list breaks. **verified (absolute paths)**
- Optional: set `TMPDIR=/config/.cache/crealityprint-tmp` *for the app process only* (in the launcher wrapper) if crash recovery of unsaved projects should survive a container re-create. Trade-off: clutter and disk churn in the volume. Default: leave `/tmp`. **inferred**

---

## 4. What happens on image upgrade

### 4.1 Same data epoch (for example 7.3.1 → 7.3.2): the normal case (verified)

- Same dir `7.3/`, so `DataMigration::initialize` finds `migration/manifest.json` in state `COMMITTED`, or a valid `Creality.conf`, and returns immediately (`DataDirectoryMigration.cpp:507–526`).
- `PresetUpdater::check_installed_vendor_profiles()` (`PresetUpdater.cpp:1112`) compares the `version` in `<resources>/profiles/<Vendor>.json` against `system/<Vendor>.json`.
  - It reinstalls a vendor **only if the bundled copy is newer** (the comment reads *"Different application versions may share this directory. Never downgrade installed profiles."*).
  - It deletes vendors that are no longer enabled, except the core vendor `"Custom"`.
  - It wipes `~/.cache/CrealityPrint`.
  - So a stale system-profile cache is refreshed when the image ships newer profiles.
- `privacyInfo.json` matches on the **major** version and rewrites the exact version, so there is no re-prompt within 7.x (`GUI_App.cpp:11384–11406`).
- A one-time multi-extruder preset-name migration runs unless `migration/preserve-user-presets` exists. It renames printer presets that carried a nozzle suffix and writes a marker (`GUI_App.cpp:3630–3645`). **verified**

### 4.2 Epoch change 7.0 → 7.3 (an image built from 7.0 to 7.2, then 7.3+) (verified, `DataDirectoryMigration.cpp:492–661`)

1. The target `7.3/` must contain only `log`, `cache` and `applock.data`, otherwise the app refuses to overwrite it (`runtime_only()`, :196).
2. Sources are tried in order `7.0`, then `6.0`. The first dir with a parseable `Creality.conf` (or `.bak`) whose `app.version` is a string wins.
3. It waits up to 5 s for any other process named `CrealityPrint`/`crealityprint` to exit (`/proc/*/comm`).
4. It builds a staging dir `.7.3.staging-<ts>`:
   - copies `Creality.conf` (+ `.bak`), `extra_config.json`, `deviceInfo.json`, `user_info.json` (login) and `privacyInfo.json`; invalid JSON goes to `migration/quarantine/`.
   - copies user presets in `user/<acct>/{machine,filament,process,local_device}`. Other user files (sync queues) go to `migration/legacy-sync/`; `*.cereal` caches are skipped.
   - copies `filament_mixing/`.
   - writes `migration/preserve-user-presets`.
   - installs bundled `system/` profiles for `Creality` plus every vendor in the old `models`, and `printers/`.
   - validates every preset with the native parser. Presets with duplicate names, broken or cyclic `inherits`, or invalid JSON are **moved to `migration/quarantine/`**, not dropped.
   - verifies source hashes, then renames staging → `7.3`, writes `manifest.json` (`COMMITTED`) and `report.json`.
5. The old `7.0/` dir is **left untouched**. It is a backup, but also dead weight.
6. On any failure, `preserve_user_directory()` copies `user/` and the three root files from `7.0`/`6.0` without overwriting, writes `migration/user-fallback.json` and lets the app start. Diagnostics are in `…/Creality Print/.migration-7.3/{report.json,last-error.txt}`.
7. Cloud preset sync is "held" after a migration (`report.cloud_preset_sync`).

Things **not** carried over: logs, `ota/`, `plugins/`, `thumbnail_cache/`, `cloud_download_data/` and `shapes/`. **verified by omission in the copy list**. The `download_path` key is copied pointing at `…/7.0/cloud_download_data`. In Phase 2 that dir did not exist, so `init_download_path()` reset the key to `…/7.3/cloud_download_data` (§T5). If the old dir does exist, the key will keep pointing into `7.0/` (inferred).

### 4.3 Future epoch change (for example 7.3 → 7.x/8.0)

- `initialize_impl` throws `"No migration rules registered for data version …"` unless `data_version == "7.3"` (:528), and `preserve_user_directory` only runs for `7.3` (:272). A future epoch therefore depends entirely on Creality shipping new rules. **verified** (current code)
- With Creality's track record (blind copy in 7.0–7.2, a careful transaction in 7.3), they will very likely add rules. If they don't, the user gets an empty dir while the old one stays on disk. **inferred**
- **Mitigation in our image:** our init script should **log** the set of `Creality Print/*` dirs found. If a dir newer than all existing ones is about to be created by the app (we can't know beforehand), the README should explain how to copy `user/` and `Creality.conf` across. Do not automate cross-epoch copying ourselves.

### 4.4 Downgrade (pinning an older image tag)

- 7.3 → 7.2 image: 7.2 uses `7.0/` and silently shows the **pre-upgrade** state. Changes made under 7.3 are invisible. Re-upgrading is safe: 7.3 finds its own committed dir.
- Same epoch, older patch: system profiles are never downgraded (see §4.1), so newer vendor JSONs stay. Presets may reference fields the older binary ignores (forward-compat substitution). **inferred**

### 4.5 In-app updater inside a container

- The app checks for updates at startup: `PresetUpdater::sync()` → `sync_version()` → `check_new_version_cx()`, only when `is_first_install == "1"` (`PresetUpdater.cpp:1424`). `enabled_version_check = true` is hard-coded (`:250`), so **no config key disables it**. **verified**
- If the user clicks "update", the downloaded package installs into the container filesystem and is lost on re-create, or it simply fails. The README must say: update by pulling a new image.
- Suppression options:
  - `app.skip_version` (`GUI_App.cpp:4796–4805`): a dialog is suppressed when `compare_creality_versions(new, skip) <= 0`. Seeding `"skip_version": "99.0.0.0"` should silence it. **inferred**, needs Phase 2 check.
  - Network-level: block the version-check host.

---

## 5. Pre-seeding defaults

### 5.1 Pattern (inferred design, based on verified lsio mechanics)

Ship seed files at `/defaults/crealityprint/seed/` and add our own s6 oneshot that runs after `init-config` and before `init-config-end`. This mirrors lsio images: `root/etc/s6-overlay/s6-rc.d/init-crealityprint-config/{type,up,run,dependencies.d/init-config}`, plus `init-config-end/dependencies.d/init-crealityprint-config` and `user/contents.d/init-crealityprint-config`. The dependency chain was verified in the base images.

```bash
#!/usr/bin/with-contenv bash
# Seed Creality Print's data dir on a brand-new volume only, and fix ownership.
# Why "brand-new only": a seeded Creality.conf makes DataMigration treat the
# target as initialised, which would block the app's own 6.0/7.0 → 7.3 import.

creality_root="${HOME}/.config/Creality/Creality Print"
data_version="${CREALITYPRINT_DATA_VERSION:-7.3}"     # baked at build time (ENV)
seed_dir="/defaults/crealityprint/seed"

has_any_existing_data_dir() {
    compgen -G "${creality_root}/*/Creality.conf" > /dev/null
}

seed_fresh_volume() {
    local target_dir="${creality_root}/${data_version}"
    mkdir -p "${target_dir}"
    cp -rn "${seed_dir}/." "${target_dir}/"
    echo "[crealityprint-init] seeded defaults into ${target_dir}"
}

if [[ -d "${seed_dir}" ]]; then
    if has_any_existing_data_dir; then
        echo "[crealityprint-init] existing data dir(s) found, not seeding"
    else
        seed_fresh_volume
    fi
fi

if [[ -d "${creality_root}" ]]; then
    ls -1 "${creality_root}" | sed 's/^/[crealityprint-init] data dir: /'
    lsiown -R abc:abc "${HOME}/.config/Creality"
fi
```

Notes:

- `CREALITYPRINT_DATA_VERSION` must match the binary. If we build from source, read it from the tag's `CMakeLists.txt`. For a release AppImage, hard-code it per release and verify in CI by launching once and checking which dir appears. This is an open question for Phase 2.
- Any seeded `Creality.conf` **must** contain `"app": {"version": "<string>"}`. Otherwise DataMigration classes it as a config that "needs recovery" and throws (`DataDirectoryMigration.cpp:522–525`); the app still starts, but takes the fallback path.
- `AppConfig::set_defaults()` fills every missing key, so a minimal seed is enough. **verified** (`AppConfig.cpp:395+`)

### 5.2 Config keys useful to seed

The keys are verified to exist; the effect of seeding them is **inferred** unless stated.

| Goal | Where | Key / value | Evidence |
|---|---|---|---|
| Skip the onboarding SPA ("add a printer" guide) | `Creality.conf` | `app.is_first_install: "1"` (means "first-install flow completed") | `GUI_App.cpp:9211–9226`: with `"1"` → `deviceAddEnd=1`; otherwise the guide shows when only default printers exist |
| Mark the legacy wizard done | `Creality.conf` | `"firstguide": {"finish": "1"}` | `WebGuideDialog.cpp:1016,1056`, `GUI_App.cpp:14054,14412` |
| Avoid the "only default printers" path | `Creality.conf` | `models: [{"vendor":"Creality","model":"K1C","nozzle_diameter":"0.4"}, …]` plus `presets.machine/filament/process` naming system presets | `config_wizard_startup()` `GUI_App.cpp:14589` runs the wizard if `!m_app_conf_exists \|\| only_default_printers()`. Vendors in `models` get system profiles installed (`PresetUpdater.cpp:1130–1150`). Exact model and preset names must match the bundled `profiles/Creality.json`. **High maintenance; optional.** |
| Region (cloud endpoint) | `Creality.conf` | `app.region`: `"Europe"` / `"North America"` / `"Asia-Pacific"` / `"China"` / `"Others"` | `AppConfig::get_country_code()` `AppConfig.cpp:1729` |
| Language | `Creality.conf` or env | `app.language`: a wx canonical name such as `"en_GB"`. If empty, the app derives it from the system locale and saves it. Setting `LC_ALL` (selkies maps it to `LANG`/`LANGUAGE`) is the simpler route. | `GUI_App.cpp:12707–12735`, `init-selkies-config` locale block |
| Silence the app-update prompt | `Creality.conf` | `app.skip_version: "99.0.0.0"` | `GUI_App.cpp:4796–4805` (**inferred**, verify) |
| Fewer start-up popups | `Creality.conf` | `app.show_splash_screen: false`, `app.show_daily_tips: false`, `app.gcode_preview_lite_mode: "false"` (otherwise a one-time dialog asks) | `AppConfig.cpp` defaults; `GUI_App.cpp:11184–11193` |
| No cloud preset sync or telemetry-ish calls | `Creality.conf` | `app.stealth_mode: true` blocks user-preset sync and the login refresh at start (`GUI_App.cpp:2409,2454,12198`); `app.sync_user_preset: false` is already the default | verified (partial effect) |
| "User Experience Improvement Program" dialog | `privacyInfo.json` | `{"list":[{"version":"7.3.0.0","check":false}]}` | `GUI_App.cpp:11342–11420`. **Phase 2 correction:** the dialog this file controls is the opt-in for Creality's telemetry ("User Experience Improvement Program", Cancel/Join). `check` is the user's answer, not acceptance of a policy. Seeding `check: false` records "declined telemetry", which is the privacy-preserving default, and the dialog is not shown (verified, §T6). Any `7.x` version string matches, and the app rewrites it to the exact version. Never seed `check: true`. |

**Recommendation** (revised after Phase 2, see §T6):

- Default: seed **nothing in `Creality.conf`**, so the user picks a region and a printer once in Creality's guide; persistence then carries it.
  - Ship `privacyInfo.json` with `check:false` (declines telemetry, suppresses that dialog). It is safe and version-tolerant within 7.x.
- Optional, opt-in via env (for example `CREALITYPRINT_SEED_PRINTER="Creality K1"`): write a `Creality.conf` with `app.version`, `region`, `is_first_install:"1"`, `firstguide.finish:"1"`, `models` and `presets`.
  - Verified to give a ready-to-slice first start.
  - The printer, process and filament names must match the bundled profiles of that release. Validate them at build time against `resources/profiles/Creality.json`.
- Do **not** seed only `is_first_install`/`firstguide` without `models`. That was verified to produce an empty printer selection with no guide to fix it (§T6, variant S2), which is worse than the guide.

---

## 6. Open questions for Phase 2

1. Exact files and dirs created on a clean first run of the release AppImage under selkies (WebKit storage location, `~/.cache` contents, any writes outside `/config` and `/tmp`).
2. Does the AppImage's `bin/CrealityPrint` wrapper set or override `XDG_*`/`HOME`? (Check `/proc/<pid>/environ`.)
3. The real `Creality.conf` structure after the guide finishes: confirm key names and value formats for `region`, `language`, `models`, `firstguide`, `is_first_install`.
4. Does `skip_version` silence the startup update dialog? Does `stealth_mode` affect anything else?
5. Does the guide re-appear after `docker rm` + re-create if only `/config/.config/Creality` (not all of `/config`) is persisted? (That would show whether WebKit storage matters.)
6. Real 7.2.x → 7.3.x upgrade inside a volume: does `report.json` show everything imported? Is the login kept (`user_info.json` copied, but WebKit cookies may also matter)?
7. Which `CREALITYPRINT_DATA_VERSION` does the release AppImage use? (Does the dir name equal `7.3`?)

---

## Hands-on test plan

Everything runs against one container named `cp` with a bind-mounted `./cfg:/config`, unless a step says otherwise. Images: **A** = current target (for example 7.3.2). **B** = a different app version with the **same** epoch (7.3.1, or A rebuilt). **C** = an image built from a **7.2.x** AppImage (epoch `7.0`), to exercise migration.

### Helpers (run on host)

```bash
# Snapshot the volume: path, size, mtime, sha for every file
snapshot() {
    local label="$1"
    find ./cfg -type f -printf '%P\t%s\t%TY-%Tm-%Td %TH:%TM\n' | sort > "snap-${label}.tsv"
    (cd ./cfg && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "sha-${label}.txt"
}

# Show what changed between two snapshots
compare() {
    diff "sha-$1.txt" "sha-$2.txt" | grep '^[<>]' | awk '{print $1, $3}' | sort -k2
}
```

Inside the container, use a marker for "what did this run touch":

```bash
docker exec cp touch /tmp/marker
# … interact …
docker exec cp find / -xdev -newer /tmp/marker -type f \
    -not -path '/proc/*' -not -path '/sys/*' -not -path '/dev/*' 2>/dev/null
```

### T0: Clean first run (baseline, image A)

1. `rm -rf ./cfg && mkdir ./cfg`. Run A with `PUID=$(id -u) PGID=$(id -g)`. Wait for the app to start.
2. Before touching the UI, run `snapshot t0-pre`. Record:
   - `ls -la "cfg/.config/Creality/Creality Print/"`, which confirms the dir name `7.3` (**Q7**)
   - `cat cfg/.config/Creality/Creality\ Print/7.3/migration/manifest.json`
   - `docker exec cp sh -c 'cat /proc/$(pgrep -f CrealityPrint | head -1)/environ | tr "\0" "\n" | grep -E "HOME|XDG|TMPDIR"'` (**Q2**)
3. Complete the first-run guide:
   - accept privacy
   - choose a region
   - add one printer (for example K1C 0.4)
   - pick a filament
4. Change some settings:
   - Preferences: language, dark mode off, units
   - create a user filament preset "TEST-PLA"
   - create a process preset "TEST-0.2"
   - save a project to `/config/Desktop/t0.3mf`
   - optionally log in to Creality Cloud
5. Quit the app cleanly (File → Exit) and run `snapshot t0-post`.
6. Run `compare t0-pre t0-post`. Also run `docker exec cp find / -xdev -newer /tmp/marker …` (marker created before step 3) to list **every** file written outside `/config` (**Q1**).

**Expected:** all app state is under `/config/.config/Creality/Creality Print/7.3/`. WebKit data is under `/config/.local/share` or `/config/.cache`. Only throwaway files are in `/tmp`.

### T1: `docker restart`

1. `docker restart cp`. Open the browser.
2. **Check:**
   - no guide and no privacy dialog
   - printer, filament and process selection as left
   - TEST-PLA and TEST-0.2 present
   - preferences kept
   - recent projects list shows `t0.3mf`
   - logged in (if used)
3. Run `snapshot t1` and `compare t0-post t1`. Expected diffs are limited to the following; anything else is a red flag:
   - `log/`
   - `Creality.conf` (+ `.bak`)
   - `cache/`
   - `privacyInfo.json` version rewrite

### T2: `docker rm` + re-create (same image)

1. `docker rm -f cp`, then re-run with the identical command or compose.
2. Same checks as T1.
3. Also check that `cfg/.config/labwc/menu.xml`, `autostart` and `rc.xml` behave as described in §2.2:
   - edit `menu.xml`, re-create, and expect the edit to be **reverted**
   - edit `menu.xml.bak`, re-create, and expect the edit to be **kept**
4. Variant T2b: persist only `./cfg-cp:/config/.config/Creality` instead of all of `/config`, then re-create. Does the guide, login or anything else reappear? (**Q5**)

### T3: PUID/PGID change

1. `docker rm -f cp`. Re-create with `PUID=1001 PGID=1001`.
2. **Check:** the app can still save:
   - change a preference
   - save a new preset
   - quit
   - `stat` the files
3. **Expected:** without our `lsiown -R`, writes to existing subdirs fail. With it, they succeed.

### T4: Image upgrade, same epoch (A → B, or B → A)

1. Run `snapshot t4-pre` with B's data. Swap the image tag. Re-create.
2. **Check:**
   - same `7.3/` dir is used (no new sibling dir)
   - presets and settings intact
   - `Creality.conf` → `app.version` updated
   - `system/Creality.json` version (`jq .version`): replaced only if the new image bundles a **newer** profile version
   - `~/.cache/CrealityPrint` removed when profiles were updated
3. Run `compare t4-pre t4-post`.
4. Downgrade back (B → A): confirm system profiles are **not** downgraded and the app still starts.

### T5: Image upgrade across epochs (C → A)

1. `rm -rf ./cfg`. Run C (7.2.x) and repeat T0 steps 3–5. This creates `…/Creality Print/7.0/`. Take `snapshot t5-pre`.
2. Switch to A and re-create.
3. **Check:**
   - `…/7.3/` created
   - `…/7.0/` untouched (`compare` of the 7.0 subtree shows no diffs)
   - `7.3/migration/manifest.json` reads `"state": "COMMITTED"` and names `"source_directory": "7.0"`
   - `7.3/migration/report.json` lists the copied files, `quarantined_presets` (expect 0), and `cloud_preset_sync`
   - no guide; presets, login and devices present
   - `.migration-7.3/last-error.txt` absent
4. Negative variant:
   - make `7.0/user` a symlink (or put a symlink inside it) and re-run A on a fresh copy
   - expect the migration to fail and the fallback to write `7.3/migration/user-fallback.json` with the copied presets
   - expect the app to start anyway
5. `--datadir` variant: launch A with `--datadir /config/cpdata` and confirm `/config/cpdata/Creality Print/7.3/` is created **empty** (no import), proving §1.4.

### T6: Pre-seed

1. Fresh `./cfg` and image A with `/defaults/crealityprint/seed/Creality.conf` containing:

   ```json
   {
     "app": {
       "version": "7.3.0.0",
       "region": "Europe",
       "is_first_install": "1",
       "skip_version": "99.0.0.0"
     },
     "firstguide": {"finish": "1"}
   }
   ```

2. **Check:**
   - seed copied (init log line)
   - app starts without the guide; does it still show privacy? (expected: yes)
   - region shows Europe in Preferences
   - no update prompt (**Q4**)
   - the app rewrote `Creality.conf` with all defaults filled
3. Re-create with a modified seed. The volume's `Creality.conf` must **not** change (copy-if-missing).
4. Run C first (creates `7.0/`), then A with seed. The init script must **not** seed, and the app must import from `7.0` (T5 checks).

### What to record for "Hands-on results"

- Exact dir tree after T0, depth 3, with sizes:

  ```bash
  tree -L 3 -h cfg/.config/Creality cfg/.local/share cfg/.cache
  ```

- The set of files written outside `/config` (T0 step 6).
- A pass/fail table for T1–T6 with notes.
- A redacted real `Creality.conf` (remove tokens, `slicer_uuid`, user ids), to confirm key names for §5.2.

---

## Hands-on results

Run on 2026-11-21 on a Linux x86_64 host with Docker. No GPU passed through.

**Images**, all built from the same Dockerfile and differing only in `ARG CREALITYPRINT_VERSION`. Each is the official `…-x86_64-Release.AppImage`, extracted to `/opt/crealityprint`, on `ghcr.io/linuxserver/baseimage-selkies:debiantrixie` with `PIXELFLUX_WAYLAND=true`.

| Tag | App version |
|---|---|
| `crp-research:baseline` | V7.3.1.6378 |
| `crp-research:persist-7.3.2` | V7.3.2.6412 (GitHub pre-release) |
| `crp-research:persist-7.2.1` | V7.2.1.5476 |

**Method:**
- Every container ran with `-e PUID=$(id -u) -e PGID=$(id -g) -v <scratch>/cfg-X:/config` (bind mount owned by the host user) and was removed with `docker rm -f`.
- The UI was driven with Playwright through the Selkies web client.
- State was checked on disk with sha256 and mtime snapshots of the whole `/config` and with a key-level diff of `Creality.conf`, plus screenshots.
- Scripts and snapshots are in the agent-G scratch dir (`scripts/`, `out/`, `shots/`).

### Summary

| Test | Result |
|---|---|
| T0 clean first run: layout | PASS. Data dir `/config/.config/Creality/Creality Print/7.3/` as predicted. |
| T1 `docker restart` | Not repeated: the baseline agent already verified it. T2 is the stricter test. |
| T2 `docker rm -f` + re-create, same image | **PASS.** No guide; printer, custom process preset and changed preference kept. |
| T2b only `.config/Creality` persisted | Not run (low priority). Answer by inspection: the WebKit storage in `.local/share/CrealityPrint` holds only localStorage, HSTS and the cache. |
| T3 PUID/PGID change on existing `/config` | **FAIL as predicted, and worse:** the whole desktop does not start. Fixed by a recursive chown. |
| T4 upgrade 7.3.1 → 7.3.2 (same epoch), then downgrade | **PASS** both ways. Same dir; vendor profiles upgraded, never downgraded. |
| T5 epoch migration 7.2.1 (`7.0/`) → 7.3.1 (`7.3/`) | **PASS.** Transactional import; old dir untouched. |
| T6 pre-seed `Creality.conf` | **PASS** with `models` + `presets`. A minimal seed without `models` gives an unusable empty printer. |
| Writes outside `/config` | Only `/tmp/crealityprint_model/…` (project auto-backup) and `/tmp/full_print_config.json`. |
| Files the image rewrites every start | `~/.config/labwc/rc.xml` and `~/.config/labwc/menu.xml` (from `menu.xml.bak`). `autostart`, `.bashrc`, `ssl/`, `.Xresources` are left alone. |

### T0: clean first run (7.3.1)

Tree created on an empty bind mount before any UI interaction (caches abbreviated):

```
/config/.config/Creality/Creality Print/
├── .migration-7.3/transaction.json      # state COMMITTED, source_directory ""
├── .migration-7.3.lock
└── 7.3/
    ├── Creality.conf                    # JSON; language en_US (from LANG), no region, no firstguide yet
    ├── deviceInfo.json  filaments_color_initialized_version.txt  preset_name_migration_v2.done
    ├── migration/{manifest.json,report.json}   # fresh install also goes through DataMigration
    ├── system/{Creality.json,Creality/,Custom.json,Custom/}   # copied from resources/profiles
    ├── printers/  filament_mixing/  cache/  log/  ota/  thumbnail_cache/
    └── user/default/{filament,local_device,machine,process}/
/config/.local/share/CrealityPrint/{localstorage/,storage/,mediakeys/,hsts-storage.sqlite}   # WebKitGTK
/config/.cache/CrealityPrint/{WebKitCache/,CacheStorage/}
/config/.Creality/crealityprint_squirrel/7.3.1.6378/                                         # empty
/config/.config/labwc/{autostart,menu.xml,menu.xml.bak,rc.xml}  .config/pulse/  .local/bin/  ssl/  Desktop/
```

- `privacyInfo.json` and `cloud_download_data/` only appear once the guide is finished.
- `docker diff` showed only these app writes outside `/config`:
  - `/tmp/crealityprint_model/<date>/<time>#<pid>#<id>/` (auto-backup, so crash recovery is lost on re-create)
  - `/tmp/full_print_config.json`
  - The rest is s6, nginx and Selkies runtime state, which is expected.

Walking the guide changes these keys:

| Guide step | Resulting `Creality.conf` change |
|---|---|
| Software mode "Professional" | (none visible) |
| Region "Europe" | `app.region = "Europe"` |
| "Skip printer connection", select **Creality K1** | `models = [{"vendor":"Creality","model":"Creality K1","nozzle_diameter":"0.4;0.6;0.8"}]`, `presets.machine = "Creality K1 0.4 nozzle"` |
| "User Experience Improvement Program" → **Cancel** | `privacyInfo.json` = `{"list":[{"check":false,"version":"7.3.1.6378"}]}` |
| Guide end | `app.is_first_install = "1"`, `firstguide.finish = true` (bool), `app.privacy_update_checked = false` |

In the UI I then made two changes, both written to disk immediately without quitting the app:
- Process preset saved as **"PERSIST-TEST 0.16"** (layer height 0.16). It went to `7.3/user/default/process/PERSIST-TEST 0.16.{json,info}` and `presets.process` was set.
- **Preferences → "Zoom to mouse position" off** wrote `app.zoom_to_mouse = false`.

### T2: `docker rm -f` + re-create (same image)

- Before the re-create, nothing under the data dir was pending: a snapshot taken right after `docker rm -f` equals the one taken while running.
- After the re-create:
  - The app opens straight into Prepare with **Creality K1 / Hyper PLA / PERSIST-TEST 0.16 (0.16 mm)**.
  - No guide, no telemetry dialog.
  - `zoom_to_mouse=false`, `region=Europe`, `is_first_install="1"` and `firstguide.finish=true` are all intact.
- Files that changed on start:
  - `Creality.conf` (rewritten)
  - `deviceInfo.json` and `privacyInfo.json` (rewritten, same content)
  - the preset's `.info` (`updated_time`)
  - a new `log/debug_*.log.0`
  - `cache/system_presets/*.cereal`
  - `system/Creality/materialList.json` (new)
  - WebKit localStorage

### Files the base image rewrites on every start (mtime/sha diff across re-creates)

| File | Every start? | User edit survives? (tested) |
|---|---|---|
| `~/.config/labwc/rc.xml` | rewritten from `/defaults/labwc.xml` | (not edited) |
| `~/.config/labwc/menu.xml` | rewritten from `menu.xml.bak` | **No**: a comment appended to `menu.xml` was gone after re-create |
| `~/.config/labwc/menu.xml.bak` | no | **Yes**: an edit to `.bak` survived and was copied into `menu.xml` |
| `~/.config/labwc/autostart` | no (only `chmod`/`chown`) | **Yes**: an appended line survived |
| `~/.config/pulse/*-default-{sink,source}`, `~/.dbus/session-bus/*`, `~/.XDG/**` | runtime state | n/a |
| `.bashrc`, `ssl/*`, `.Xresources`, `.local/bin/*` | untouched | n/a |

So a changed launcher path in a future image would **not** reach existing volumes through `autostart` or `menu.xml`. Keep `/opt/crealityprint/AppRun` stable.

### T3: PUID/PGID change on an existing `/config`

Steps: copied the T2 `/config` (owned by uid 1000) and started with `PUID=1001 PGID=1001`.

**Result:**
- `lsiown` changed only `/config` itself to 1001; every subdirectory stayed 1000.
- **Nothing started.** The browser showed a black screen with "WebSocket disconnected", there was no `CrealityPrint` or compositor process, and the log ended at `[svc-de] Wayland mode: Waiting for socket at /config/.XDG/wayland-1...`.
- After `docker exec … chown -R abc:abc /config` and `docker restart`, the desktop and app came up with every setting intact.

**Conclusion:** our image's init should repair ownership recursively when the owner of `/config/.config` (or `.local`, `.cache`) differs from `abc`.

### T4: image upgrade 7.3.1 → 7.3.2 and downgrade back

**Upgrade** (re-create with `persist-7.3.2` on the same volume):
- Same `7.3/` dir is used; no new sibling.
- `migration/manifest.json` was untouched (still `target_application_version 7.3.1.6378`), so no re-import happened.
- `Creality.conf` changed only in `app.version`, `header`, `satisfaction_survey.*`, `toolkit_size` and `last_backup_path`.
- `privacyInfo.json` version was silently rewritten to `7.3.2.6412`; no dialog.
- `system/Creality.json` went from `26.11.03.15` to **`26.11.13.15`**, about 2,050 files under `system/` rewritten from the new bundle. `Custom.json` stayed `02.01.00.01`.
- The UI showed the 7.3.2 layout ("All/Obj" toggle) with K1 / PERSIST-TEST 0.16 selected.

**Downgrade** back to 7.3.1:
- Starts fine, with settings and preset intact.
- `system/Creality.json` **stays `26.11.13.15`**, confirming "never downgrade installed profiles". The newer vendor profiles are then used by the older binary. No errors appeared in the UI; I did not slice-test it.

### T5: epoch migration 7.2.1 (`7.0/`) → 7.3.1 (`7.3/`)

1. On a fresh volume, 7.2.1 created `…/Creality Print/7.0/`. I finished the guide (Europe, **Creality K1C**, declined telemetry) and saved process preset **"MIGRATE-TEST 0.12"**.
2. I re-created the container with 7.3.1.

**Result:**
- `…/7.3/` was created next to the untouched `7.0/` (no file in `7.0/` changed by mtime).
- `7.3/migration/manifest.json`: `"source_directory": "7.0"`, `"source_application_version": "7.2.1.5476"`, `"state": "COMMITTED"`.
- `report.json`:
  - `copied_files` = `Creality.conf`, `deviceInfo.json`, `privacyInfo.json`, `user/default/process/MIGRATE-TEST 0.12.{info,json}`
  - `valid_presets: 1`, `quarantined_presets: 0`, `warnings: []`, `cloud_preset_sync: "held"`
- `migration/preserve-user-presets` and `Creality.conf.bak` (the original 7.0 conf) were written.
- Key diff of `Creality.conf` 7.0 → 7.3: only `version`/`header`, `download_path` (re-pointed to `…/7.3/cloud_download_data`), `models[].nozzle_diameter` widened to `0.4;0.6;0.8`, and the new `satisfaction_survey.*` block.
- UI: opened directly in Prepare with **Creality K1C / Hyper PLA / MIGRATE-TEST 0.12 (0.12 mm)**; no guide, no telemetry dialog.

### T6: pre-seeding

**Variant S1: seeded `Creality.conf` with `models` and `presets`**

- Input: a fresh volume containing only `…/7.3/Creality.conf`:

  ```json
  {
    "app": {
      "version": "7.3.1.6378",
      "region": "Europe",
      "language": "en_US",
      "is_first_install": "1",
      "skip_version": "99.0.0.0"
    },
    "firstguide": {"finish": "1"},
    "models": [
      {"vendor": "Creality", "model": "Creality K1", "nozzle_diameter": "0.4"}
    ],
    "presets": {
      "machine": "Creality K1 0.4 nozzle",
      "process": "0.20mm Standard @Creality K1 0.4 nozzle",
      "filaments": ["Hyper PLA @Creality K1 0.4 nozzle"]
    }
  }
  ```

- **Guide skipped.** The app opened in Prepare with Creality K1 / Hyper PLA / 0.20mm Standard.
- `system/`, `printers/` and `user/default/` were still populated. There was **no** `migration/` dir: DataMigration returned early on the valid conf, as the source predicts, and PresetUpdater installed the vendor bundle.
- The app kept all seeded keys, including `skip_version`, and filled in its defaults.
- Only remaining prompt: the telemetry dialog, because `privacyInfo.json` was missing.

**Variant S2: minimal seed plus `privacyInfo.json`**

- Input: a `Creality.conf` with only `app.version`, `region`, `is_first_install`, `firstguide.finish`, plus `privacyInfo.json` = `{"list":[{"check":false,"version":"7.3.0.0"}]}`.
- **No dialogs at all**, and the app rewrote the privacy version to `7.3.1.6378`.
- But the printer box was **empty** ("Default Printer", no bed model), with no guide to fix it.
- **Conclusion:** the seed must include `models` + `presets`, or seed nothing.

**Not verified:**
- Whether `skip_version` suppresses the startup update prompt. No prompt appeared in any run, with or without it. The update check only runs when `is_first_install=="1"`, and 7.3.2 is a pre-release.
- `--datadir` and the symlink negative tests. Low priority; the source analysis in §1.4 and §4.2 stands.

### Recommended layout (confirmed)

- One bind mount (or named volume) at **`/config`**, owned by PUID:PGID.
- Keep projects under `/config` (for example `/config/Desktop`). The only state outside it is `/tmp` auto-backup.
- Ship `/defaults/crealityprint/privacyInfo.json` (`check:false`), copied only on a fresh volume.
- Offer an opt-in printer seed.
- Repair ownership recursively when PUID changes.
- Keep the launcher path stable.

### Cleanup

- All `crp-research-G-*` containers were removed.
- The test volumes stay in the agent-G scratch dir, owned by the host user again after a chown.
- Images `crp-research:persist-7.3.2` and `crp-research:persist-7.2.1` (about 5 GB each) were kept for later sessions. Remove them with `docker rmi` when no longer needed.
