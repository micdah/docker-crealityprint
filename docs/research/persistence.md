# Persistence

Where the app and the desktop keep their state, how it survives a restart, a re-create and an upgrade, and what the image does to `/config` at start (ownership repair, first-run seed).

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.
Verified against: Creality Print 7.2.1, 7.3.1, 7.3.2 (source at v7.3.2 and v7.2.1); base image `debiantrixie`.

- All state lives in `/config`, the linuxserver home directory and the image's only volume. The app's data dir is `/config/.config/Creality/Creality Print/7.3/` for 7.3.x [V].
- Settings, presets, printers and preferences survive `docker restart`, `docker rm` plus re-create, an upgrade and a downgrade within 7.3, and the 7.0 → 7.3 move, which the app migrates itself [V].
- The app writes every change to disk at once, so a hard kill loses no settings [V]. The only app state outside `/config` is the unsaved-project backup in `/tmp`. A re-create deletes it, and after a `docker restart` the app often doesn't offer it [V].
- At every start the image repairs ownership after a `PUID`/`PGID` change. On a fresh volume only, it seeds `privacyInfo.json` and a `Creality.conf` (folders, plus the printer when `CP_PRINTER` is set). Later starts never touch `Creality.conf`.
- The base image copies autostart and menus into `/config` once and rewrites a few desktop files every start. None of that touches the app's data.

## The app's data dir

- Path: `${XDG_CONFIG_HOME:-$HOME/.config}/Creality/Creality Print/<data version>/` (`GUI_App::init_app_config`, `set_data_dir`) [V]. `HOME=/config`; neither the base nor `AppRun` sets `XDG_CONFIG_HOME` [V].
- The data version is a CMake "data compatibility epoch" (`CREALITYPRINT_DATA_VERSION`), independent of the release version [V, source]:
  - `7.3` for 7.3.x; `7.0` for 7.0–7.2.x; `6.0` for 6.x (before 7.3 it was always `<major>.0`).
  - Builds whose `PROJECT_VERSION_EXTRA` contains "alpha" (the CMake default) add ` Alpha`. The official `…-Release.AppImage` doesn't.
- `--datadir X` still appends `/Creality Print/<data version>` and skips the app's migration. `XDG_CONFIG_HOME` is the only redirection that keeps the migration [V, source]. The launcher passes neither. Linux has no portable mode (Creality Print #590).
- Next to the version dirs: `.migration-7.3/` (`transaction.json`, `report.json`, `last-error.txt`) and `.migration-7.3.lock` [V].
- About 24 MB after the first run [V].

| Content | Where, inside the data dir |
|---|---|
| Main config (JSON): preferences, `region`, `language`, `models`, `presets`, `firstguide`, `recent_projects`, window geometry, the Creality Cloud token (`cloud.*`) | `Creality.conf` (+ `Creality.conf.bak`) |
| Cloud login | `user_info.json` |
| LAN printers and the selected one | `deviceInfo.json`, `current_device.json` |
| Telemetry answer | `privacyInfo.json` |
| User presets | `user/<account id or default>/{machine,filament,process,local_device}/` |
| Vendor profiles copied from the bundle | `system/`, `printers/` |
| Online downloads | `ota/`, `plugins/`, `cloud_download_data/` |
| Logs and crash dumps (the process `chdir`s here) | `log/` |
| Caches | `cache/` (instance lock, preset `.cereal` files), `thumbnail_cache/` |
| Migration bookkeeping | `migration/` (`manifest.json`, `report.json`, `quarantine/`, `preserve-user-presets`) |
| Other | `filament_mixing/`, `shapes/`, `extra_config.json`, `launchInfo.json`, … |

`recent_projects`, `download_path`, `last_export_path` and `last_backup_path` are stored as absolute paths [V]. Files kept outside `/config` therefore vanish from the recent list after a re-create.

## Other state

In `/config` [V]:

| Path | What |
|---|---|
| `.local/share/CrealityPrint/` | WebKitGTK storage of the app's web pages: `localstorage/`, `storage/`, `mediakeys/`, `hsts-storage.sqlite` |
| `.cache/CrealityPrint/` | WebKit caches. The app deletes this dir when it installs newer bundled vendor profiles |
| `.Creality/crealityprint_squirrel/<app version>/` | One empty dir per app version that has run (updater bookkeeping [I]) |
| `.cache/mesa_shader_cache_db/` | Mesa shader cache |
| `.dbus/session-bus/` | X11 D-Bus autolaunch state. It provides the app's session bus |
| `.config/labwc/`, `.config/pulse/`, `.local/bin/`, `.bashrc`, `.Xresources`, `ssl/` | Desktop and base image files (see below) |
| `.XDG/` | `XDG_RUNTIME_DIR`. The base deletes it every start |
| The upload folder (default `Desktop/`) | See [files.md](files.md) |

Selkies' stream settings are kept in the browser's localStorage, not in `/config`.

Outside `/config`, the app writes only to `/tmp` (`docker diff` after a first run) [V]:

| Path | What | `docker restart` | Re-create |
|---|---|---|---|
| `/tmp/crealityprint_model/<date>/<time>#<pid>#<id>/` | Backup of an unsaved project | Kept, but often not offered (below) | Lost |
| `/tmp/full_print_config.json` | Slicing temp file | Kept | Lost |
| `/run/…` | Runtime state (s6, the idle-quit FIFO and marker) | Kept | Lost |

- `/tmp` and `/run` are in the container's writable layer. s6-overlay's preinit mounts a tmpfs on `/run` only when `/run` isn't writable, and Docker's `/run` is writable [V]. The image's own runtime dirs in `/run` are therefore cleared at each start (see [idle-quit.md](idle-quit.md)).
- The app takes its temp dir from `$TMPDIR`, else `/tmp` [V, source]. The image doesn't set `TMPDIR`.
- **The backup and `docker restart`.** After a `docker restart` the app often skips it [V]. It finds the backup through `last_backup_path` in `Creality.conf` and ignores one whose `lock.txt` names a running process. A freshly booted container starts the app with the same PID every time, so the restarted app takes the backup for its own, skips it and points `last_backup_path` at a new empty folder. Work added during a container's first boot was offered after a restart; work added after one restart was not. Within a running container PIDs keep growing, so an app close (`IDLE_QUIT`, closing from the menu) is unaffected [I].

## What survives what

| Event | Result |
|---|---|
| A change in the app | Written at once. `Creality.conf` is rewritten through `Creality.conf.<pid>` plus rename on every change, not only at exit [V]. A snapshot right after `docker rm -f` equals one taken while running [V] |
| SIGTERM (`docker stop`, IDLE_QUIT) | The app exits in about 50 ms without asking to save. Settings are safe. The next start asks "Previously unsaved items have been detected. Do you want to restore them?", and Yes brings the unsaved plate back [V, across an app close]. Across a `docker restart` it often doesn't (above) |
| `docker rm` + re-create, same `/config` | No wizard; printer, presets, preferences and the printer list kept [V; CI: `persistence.spec.js`]. The unsaved-project backup is lost |
| Upgrade 7.3.1 → 7.3.2, and back | Same `7.3/` dir, settings kept both ways [V] |
| Upgrade 7.2.1 (`7.0/`) → 7.3.1 (`7.3/`) | Migrated by the app; the old dir is left as it was [V] |
| `PUID`/`PGID` change | Repaired at start [V; CI: `persistence.spec.js`] |

One exception: closing the app (SIGTERM) about 3.5 s into its very first start on a fresh `/config` once left a config the app called corrupt ("Detected corruption in the Creality Print configuration file, attempted to rebuild, please manually restart the software.") [V]. Closing it at 1, 2 or 4 s into a first start, or early in a later start, was harmless. The first start does one-off work (the migration check, about 2,000 vendor profile files, the first config rewrite) [I]. The idle timer never closes an app younger than 60 s; see [idle-quit.md](idle-quit.md).

## Printers and the cloud login after a re-create

- `deviceInfo.json` holds groups of printers: `{address, mac, model, connectType, secureConnection, wssPort, videoPort, …}` [V].
- A re-created container (new MAC and IP) lists the printer and connects at once: status, temperatures, camera. Settings the app learned, such as a switch to TLS on 443, are reused [V, K1C]. The container's own MAC and IP don't matter for LAN printers [V].
- Entries are keyed by the printer's IP. A printer that gets a new DHCP lease probably needs to be added again: the app's address correction uses mDNS, which doesn't work on the bridge network [I]. Use a DHCP reservation. See [printers.md](printers.md).
- The Creality Cloud login is in `user_info.json` and `Creality.conf`. Whether the cloud ties it to the container's MAC address, which changes on re-create, is untested [I]; see [decisions.md](decisions.md).

## Upgrades and the data version

### Same data version (e.g. 7.3.1 → 7.3.2)

- `DataMigration` finds a committed `migration/manifest.json` or a valid `Creality.conf` and does nothing [V, source and test].
- `PresetUpdater::check_installed_vendor_profiles` reinstalls a vendor only when the bundled profile version is newer ("Never downgrade installed profiles"). It also removes vendors no longer enabled (except `Custom`) and wipes `~/.cache/CrealityPrint` [V, source].
  - 7.3.1 → 7.3.2: `system/Creality.json` went from `26.11.03.15` to `26.11.13.15`, about 2,050 files rewritten. `Custom.json` stayed [V].
  - Back to 7.3.1: the newer profiles stayed and the older app started with settings intact. Slicing was not tested [V].
- `privacyInfo.json` is matched on the major version and rewritten to the exact version, so there is no new prompt within 7.x [V].
- `Creality.conf` changes only in `app.version`, `header` and a few new keys [V].
- A one-time preset-name migration (multi-extruder) runs unless `migration/preserve-user-presets` exists [V, source].

### A new data version (7.0 → 7.3)

`DataMigration` (`DataDirectoryMigration.cpp`), on the first start of 7.3 [V, source]:

1. It runs only when `7.3/` holds nothing but `log`, `cache` and `applock.data`.
2. Sources are tried in order `7.0`, then `6.0`. The first with a parseable `Creality.conf` (or `.bak`) that has a string `app.version` wins.
3. It waits up to 5 s for other `CrealityPrint` processes to exit.
4. In a staging dir `.7.3.staging-<ts>` it:
   - copies `Creality.conf` (+ `.bak`), `extra_config.json`, `deviceInfo.json`, `user_info.json`, `privacyInfo.json`, the user presets and `filament_mixing/`;
   - installs the bundled `system/` profiles for Creality and every vendor in the old `models`;
   - validates every preset with the native parser. Invalid presets move to `migration/quarantine/`; none are dropped;
   - renames staging to `7.3`, then writes `manifest.json` (`COMMITTED`) and `report.json`.
5. Logs, `ota/`, `plugins/`, `thumbnail_cache/`, `cloud_download_data/` and `shapes/` are not carried over. Cloud preset sync is held after a migration.
6. On failure, `preserve_user_directory` copies `user/` and the root files without overwriting, writes `migration/user-fallback.json`, and the app starts anyway. Diagnostics: `.migration-7.3/`.
7. `check_path` throws on a symlink in `Creality Print/`, in the version dir or in any file it walks. Symlinks above it (e.g. `/config/.config`) are not checked.

Tested 7.2.1 → 7.3.1 [V]: the manifest named `source_directory` `7.0`. The report listed `Creality.conf`, `deviceInfo.json`, `privacyInfo.json` and the user's process preset (1 valid, 0 quarantined). The app opened in Prepare with the K1C and that preset, with no wizard. No file in `7.0/` changed. `download_path` was re-pointed to `7.3/cloud_download_data` because the old folder didn't exist; had it existed, the key would keep pointing into `7.0/` [I].

### Later data versions and downgrades

- The rules are hard-coded for 7.3: any other data version throws "No migration rules registered for data version …", and the fallback copy also runs only for 7.3 [V, source]. A 7.4 or 8.0 data dir depends on Creality adding rules. Test that a 7.3 `/config` migrates before releasing such an image (see [decisions.md](decisions.md)).
- The seed derives the data dir from the release version (`<major>.<minor>`). That matches 7.3.x. If a release ever keeps an older data version (say 7.4 still on `7.3`), a fresh volume would get its seed in an unused `7.4/` and the wizard would run [I].
- An app with an older data version reads its own older dir and shows the state from before the upgrade [V, source].

## Ownership repair

Why: the base's `init-adduser` sets `abc` to `PUID`/`PGID` and then runs `lsiown abc:abc /app /config /defaults`, which without `-R` fixes only those dirs themselves [V]. After a `PUID` change everything inside keeps the old owner, and the whole desktop fails: a black page with "WebSocket disconnected", no compositor, and a log that ends at "Waiting for socket at /config/.XDG/wayland-1" [V].

What `init-crealityprint-config` does at every start [V, code]:

- It checks `/config/.config`, `.local`, `.cache`, `.Creality` and `.dbus` down to two levels (`find -maxdepth 2` for a uid or gid other than `abc`'s). Two levels because the base already re-owns the top-level dirs.
- If any path there has another owner or group, it logs "`<path>` is not owned by UID:GID; re-owning the desktop and app state in /config" and runs `lsiown -R abc:abc` on all five dirs.
  - `.Creality` holds the updater bookkeeping.
  - `.dbus` is mode 0700. If `abc` can't read it, the app gets no session bus, and the upload watcher can't hand files to it.
- The upload folder is re-owned at its top level only, so a NAS share mounted inside it is never chowned.

CI (`persistence.spec.js`) restarts an existing `/config` with `PUID`/`PGID` 4321. The desktop and app start, settings are kept, and an upload still reaches the app over D-Bus [V].

## First-run seed

`init-crealityprint-config` runs as root after the base's `init-config` and before `init-config-end`, so before the desktop starts [V, code].

- **When:** only if no `Creality Print/<digit…>/` dir exists. Any existing data dir means the user has settings, or the app has a migration to run, and a seeded `Creality.conf` would make the app treat `7.3/` as initialised and skip that import [V, source].
- **Where:** the full app version is parsed from the asset name in `/build_version` (e.g. `7.3.3.6461`); the data dir is `<major>.<minor>`. If the version can't be read, the init logs it and seeds nothing.
- **`privacyInfo.json`**, copied from `/defaults/crealityprint/`: `{"list":[{"check":false,"version":"7.3.0.0"}]}`. It answers the "User Experience Improvement Program" (telemetry) prompt with Cancel. `check` is the user's answer, so never ship `true`. Any 7.x version matches, and the app rewrites it to the exact version [V].
- **`Creality.conf`**, printed by `crealityprint-seed-config <version>`:
  - Always: `app.version`, plus `app.last_export_path` and `recent.last_opened_folder` set to the upload folder (`SELKIES_FILE_MANAGER_PATH`, else `FILE_MANAGER_PATH`, default `/config/Desktop`). The app's own setup wizard still runs.
  - With `CP_PRINTER` (and `CP_NOZZLE`, default `0.4`; `CP_REGION`, default `Europe`): it looks for `<printer> <nozzle> nozzle.json` in any vendor's `machine/` profiles in `/opt/crealityprint/resources/profiles`. It takes that profile's `default_print_profile` and first `default_filament_profile`, and checks that both preset files exist. Then it adds `app.region`, `app.is_first_install: "1"`, `firstguide.finish: "1"`, `models` and `presets`, which skips the wizard.
  - Unknown printer or missing preset: a warning ("no printer profile named '…'; leaving the first-run wizard on") and a config without the printer keys, so the wizard runs.
- If generation fails, the seeded dir is removed so the app starts clean. Either way `/config/.config/Creality` is re-owned to `abc`.
- Later starts never touch `Creality.conf`. `CP_*` and a changed upload folder affect only a fresh volume.

`CP_PRINTER="Creality K1C"` on 7.3.3 gives (checked by `seed.spec.js`, which also covers the plain and the unknown-printer seed) [V]:

```json
{
  "app": { "version": "7.3.3.6461", "last_export_path": "/config/Desktop",
           "region": "Europe", "is_first_install": "1" },
  "recent": { "last_opened_folder": "/config/Desktop" },
  "firstguide": { "finish": "1" },
  "models": [ { "vendor": "Creality", "model": "Creality K1C", "nozzle_diameter": "0.4" } ],
  "presets": { "machine": "Creality K1C 0.4 nozzle",
               "process": "0.20mm Standard @Creality K1C 0.4 nozzle",
               "filaments": [ "Hyper PLA @Creality K1C 0.4 nozzle" ] }
}
```

Why the seed looks like this:

- A seed with only `is_first_install` and `firstguide` but no `models` and `presets` opens without dialogs, but with an empty "Default Printer", no bed and no wizard to fix it [V].
- The seed must contain a string `app.version`. Without it `DataMigration` treats the config as needing recovery and takes its fallback path [V, source]. `AppConfig::set_defaults` fills every missing key, so a small seed is enough [V, source].
- With a valid seeded config, `DataMigration` returns early (no `migration/` dir), and the vendor profiles, `printers/` and `user/default/` are still installed [V].
- What the wizard itself writes: Region → `app.region`; a printer → `models` and `presets.machine`; telemetry Cancel → `privacyInfo.json` with `check: false`; the end → `app.is_first_install: "1"` and `firstguide.finish: true` [V]. Valid regions are `Europe`, `North America`, `Asia-Pacific`, `China` and `Others` [V, source].

## Files the base image manages in /config

The base's `init-selkies-config` [V; edits tested across re-creates]:

| File | At every start | Your edits |
|---|---|---|
| `.config/labwc/autostart` | Copied only if missing; owner and mode reset | Kept |
| `.config/labwc/menu.xml` | Copied once and backed up to `menu.xml.bak`, then restored from `menu.xml.bak` every start | Lost; edit `menu.xml.bak` instead |
| `.config/labwc/rc.xml` | Regenerated from `/defaults/labwc.xml` | Lost |
| `.XDG/` | Deleted and recreated | — |
| `.local/bin/proot-apps…` | Replaced when the bundled version differs | — |
| `.bashrc` | Lines appended if missing | Kept |
| `ssl/`, `.Xresources` | Created if missing | Kept |

A new image's autostart and menus never reach an existing volume, so they call one launcher path that never changes, `/usr/local/bin/crealityprint` (see [app.md](app.md) and [decisions.md](decisions.md)). None of these files touch the app's data dir.

## Storage notes

- Mount all of `/config`. Never mount only the versioned dir: the next data version would land outside the mount. Backup: copy the folder while the container is stopped (see the [user README](../../README.md)).
- Bind mount and named volume both work. The seed comes from `/defaults` plus the init, not from files baked into `/config`, so it doesn't depend on Docker copying image content into a new named volume. A bind-mounted dir must be writable by `PUID`/`PGID`.
- `/config` on NFS or SMB may break the app's locks: `flock` in `DataMigration`, `fcntl` in `InstanceCheck`, SQLite in WebKit [I]. SELinux hosts need `:z`/`:Z`.
- Keep projects under `/config` at a stable path, because the app stores absolute paths. Where uploads and saves land: [files.md](files.md).
- Upstream reports of lost settings are app bugs, not storage problems: user filament presets vanishing, possibly through cloud preset sync (Creality Print #492), and selected presets not remembered (#364).
