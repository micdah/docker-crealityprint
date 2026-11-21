# 12 — Remaining hands-on tests (non-printer)

Date: 2026-11-21 · Author: research agent R (hands-on) · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, 16 cores, 31 GiB RAM, Intel UHD 630

This doc closes the non-printer items under "Still untested" in [09](09-roadblocks-and-risks.md): the upload watcher with unsaved work (risk R20), the clipboard, drag-and-drop onto the stream, and long-session stability (`/dev/shm` growth, base issue #142).

Legend: **[V]** = verified by running it or reading the source, **[I]** = inferred.

## Summary

| # | Test | Result | One-line finding |
|---|---|---|---|
| 1a | Original watcher (`crp-research:ft-watcher`) with unsaved work | **FAIL** | The watcher never forwards to the running app. Each upload starts a **second Creality Print process** whose window covers the dirty one. Nothing is lost, but it looks lost, and two app processes now share one config. Root cause: a word-splitting bug in the watcher. R7 in [06](06-file-transfer.md) misread this as "replaces the plate". |
| 1b | Forwarding to the running app (correct single-instance path) with unsaved work | **PASS** | An STL is **added to the current plate**. Dirty objects, moves and changed settings are kept. No prompt. |
| 1c | Saved project, then modified, then upload | **PASS** | Same: added to the plate, nothing lost. |
| 1d | 3MF upload into a non-empty project | **PASS (prompts)** | "Drop project file" dialog (Open as project / Import geometry only). "Open as project" then asks "The current project has unsaved changes. Would you like to save before continuing?" Cancel keeps everything. |
| 1e | Safer watcher `crp-research:ft-watcher2` (direct D-Bus call, no second process, no config edits) | **PASS** | Works whatever `single_instance` says, handles spaces in file names, queues while a modal dialog is open, and starts the app with the file when no app is running. |
| 2 | Clipboard, text, browser → app and app → browser | **PASS** | Over HTTPS (or `localhost`). The sync runs on the paste/copy keystroke (Ctrl+V / Ctrl+C on the stream). |
| 2 | Clipboard, image, browser → app | **PASS** | PNG lands on the session clipboard as `image/png`. |
| 2 | Clipboard, image, app → browser | **FAIL / not reproduced** | An `image/png` put on the X clipboard by `xclip` never reached the browser. Creality Print has no image-copy feature, so this doesn't matter for the image [I]. |
| 2 | Insecure context (plain `http://<lan-ip>`) | **FAIL (by design)** | `isSecureContext=false`, no `navigator.clipboard`, no `VideoDecoder`. The client shows "This application requires a secure connection (HTTPS)". |
| 3 | Drag-and-drop onto the stream | **PASS (automated)** | Chrome DevTools `Input.dispatchDragEvent` with real file paths goes through the browser's native drag pipeline. Files, several files and a folder all uploaded, and the watcher added them to the plate. A synthetic `DataTransfer` still fails (entry `null`), as R4 found. |
| 4 | 30-minute session, CPU rendering (llvmpipe + x264) | **PASS** (29 min) | `/dev/shm` flat at 44 MB (wlroots buffers), PIDs, selkies and app RSS flat after the first ~15 min. One bounded WebKit step of +240 MB around minute 12–17. Orbiting costs ~7 cores. |
| 4 | 30-minute session, `/dev/dri` (Intel UHD 630, VAAPI) | **PASS** (29 min) | `/dev/shm` flat at 0.13 MB, everything flat. Orbiting costs ~0.6 cores. No sign of #142. |

---

## Setup (shared by all tests)

Scratch dir: `$R` = `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-R`. All screenshots below are under `$R/shots/` (3200×1800 PNG unless named `small-*` or `crop-*`).

- Images: `crp-research:baseline` and `crp-research:ft-watcher` (from [07](07-hands-on-baseline.md) and [06](06-file-transfer.md) R7), plus the new `crp-research:ft-watcher2` (§1.5).
- Each container got a fresh copy of agent D's wizard-completed config (`cp -a …/agent-D/config-run2 $R/config-<name>`; Creality K2 Plus). For the watcher tests, `recent.last_opened_folder` and `app.last_export_path` were seeded to `/config/Desktop` with Python's `json` module, as [06](06-file-transfer.md) recommends.
- Container start (`$R/scripts/run.sh`):
  ```
  docker run -d --name crp-research-R-<name> -p 3700:3000 -p 3701:3001 --shm-size=1gb \
    -e PUID=1000 -e PGID=1000 -e TZ=Europe/Copenhagen -v $R/config-<name>:/config [extra] <image>
  ```
- Browser: Google Chrome 158 (`crp-research:pw-chrome`, Playwright 1.49 driver, `--network host`, `channel: 'chrome'`), headless, viewport 1600×900, `deviceScaleFactor: 2` (so the remote desktop is 3200×1800), `ignoreHTTPSErrors: true`. Wrapper `$R/scripts/pw.sh`, action runner `$R/scripts/act.js` (a copy of agent H's, plus `drag`, `evalFile`, HTTPS and clipboard permissions via `PERMS=1`).
- Models: `$R/models/first.stl` (20 mm cube), `block35.stl` (35 mm cube), `sphere.stl` (80 mm bumpy sphere, 4,680 triangles), `projb.3mf` (a project saved by the app).
- App log: `/config/.config/Creality/Creality Print/7.3/log/debug_*.log.0`. Every app process writes its own file, and the first lines show `GUI_Run: single_instance setting=…` and whether an instance check found another instance. That is how a second process is told apart from a forwarded file.

---

## 1. Upload watcher with unsaved work (risk R20)

### 1.1 Original watcher `crp-research:ft-watcher`: FAIL (second instance, not forwarding)

Steps (container `crp-research-R-w1`, config with `single_instance` unset, which the app writes as `false`):

1. Ctrl+I, Ctrl+L, `/config/Desktop/first.stl`, Enter. Cube on the plate, title "first". `$R/shots/W1a-imported.png`
2. Make it dirty: drag the cube to the back-right corner, and change *Layer height* 0.2 → 0.28. The preset turns into "* 0.20mm Standard …". `$R/shots/W1b-dirty.png`
3. Sidebar, Files, Upload Files, `block35.stl`. The watcher logged `opening /config/Desktop/block35.stl`.

Result [V]:

- After about 5 s the visible window was titled "block35" and showed **only** the 35 mm cube, the default camera, and layer height 0.2. No prompt was shown. `$R/shots/W1c-after-upload-7s.png`
- That looks like silent loss of the dirty work, but it isn't. `ps` showed **two** app processes: PID 456 (the original) and PID 966 `/opt/crealityprint/bin/CrealityPrint /config/Desktop/block35.stl`. `xwininfo -root -tree` on `:0` showed two 1600×874 top-level windows, `"block35"` on top and `"first"` (the dirty one) underneath.
- The new process's log: `GUI_Run: single_instance setting=false`, `instance_check returned false (no other instance)`, then `Not primary owner of DBus name - probably another CrealityPrint instance is running`. It is a full second app (+~0.8 GB RSS, plus its own WebKit processes [I, from per-process RSS in 07 §10]).
- `Creality.conf` still had `"single_instance": false` afterwards.

**Root cause (watcher bug) [V].** `crp-upload-watcher` sets the flag with:

```bash
app_config_glob="$HOME/.config/Creality/Creality Print/*/Creality.conf"
for config_file in $app_config_glob; do   # unquoted: splits on the space in "Creality Print"
```

The unquoted expansion splits on the space in `Creality Print` before globbing, so the loop sees `/config/.config/Creality/Creality` and `Print/*/Creality.conf`. Neither is a file, so `jq` never runs. Reproduced in isolation:

```
docker run --rm --name crp-research-R-globtest --entrypoint bash crp-research:ft-watcher -c '…same loop…'
loop item: [/tmp/h/.config/Creality/Creality] exists=no
loop item: [Print/*/Creality.conf] exists=no
```

An `inotifywait` on the config folder during an upload (container `crp-research-R-w3`) showed no `Creality.conf.watcher-tmp` write at all. The only writes were the app's own `Creality.conf.<pid>` temp files, followed by rename.

**R7 in [06](06-file-transfer.md) was misread [V].** Agent H's saved config (`agent-H/config-watcher`) has six app logs. The three made by the watcher (`watch-cube.stl`, `second.stl`, `big-cube60.stl`) all say `single_instance setting=false` / `instance_check returned false`. So each upload started a new app process, and the newest window covered the older ones. The plate was never "replaced". The manual pre-check in R7 (setting the flag by hand, then `AppRun <file>`) did forward correctly, but the service never did.

**Even with the glob fixed, editing `Creality.conf` while the app runs is fragile [V, I].** The running app rewrites the whole file through `Creality.conf.<pid>` plus rename whenever its config changes. Seven rewrites were seen within 3 s of a second instance starting, and imports change `recent.*`. A watcher edit can therefore be overwritten before the new process reads it [I: race not reproduced, because the glob bug hid it]. The flag is only read at process start (`GUI_Init.cpp:150`).

### 1.2 Correct forwarding (flag set before the app starts): PASS, nothing lost

Container `crp-research-R-w2`: the same image, but `"app": {"single_instance": true}` was seeded into `Creality.conf` **before** the first start. The app log showed `single_instance setting=true`.

Same steps as 1.1 (import `first.stl`, move it, layer height 0.28, upload `block35.stl`). Result [V], `$R/shots/W2a-after-upload.png`:

- Still one app process (PID 456). The forwarded process logged `Instance check: Another instance found. This instance will terminate.` The main log shows a second `load_files: load_model 1`.
- The plate holds **both** objects: the moved `first.stl` and the new `block35.stl` at the bed centre. Layer height is still **0.28** and the preset is still "* 0.20mm Standard…". The title stays "first" (the project name doesn't change). No dialog appeared.

### 1.3 What the source says (v7.3.1) [V]

- `InstanceCheck.cpp` `OtherInstanceMessageHandler::listen()` registers the D-Bus name `io.github.crealityofficial.CrealityPrint.InstanceCheck.Object<hash>` **unconditionally** in every first instance. The `single_instance` flag only decides whether a *new* process sends its argv there and exits (`instance_check()`, L311–L370).
- The message is the new process's argv, joined by **`;`** and quoted by `escape_strings_cstyle()` (`libslic3r/Config.cpp` L74). `handle_message()` (L497) skips argv[0], keeps arguments that are existing paths, and posts `EVT_LOAD_MODEL_OTHER_INSTANCE`.
- `Plater.cpp` L7723: that event runs `mainframe->Raise()` and `Plater::load_files(wxArrayString)` (L19923). This is the same entry point as drag-and-drop onto the window:
  - a single non-3MF file → `Plater::TakeSnapshot` ("Load File: …", so it can be undone) + `load_files(paths, LoadStrategy::LoadModel)`, which **adds to the current plate**;
  - a single 3MF → `open_3mf_file()`. If the plate isn't empty, the `ProjectDropDialog` asks "Open as project" or "Import geometry only". "Open as project" → `load_project()`, which asks to save unsaved changes;
  - G-code → `load_gcode()` (preview only); models mixed with G-code are refused with an info box.
- There's no CLI option to choose "import into plate" vs "open as project". Argv files given to a *first* instance open as the startup project. The `--single-instance` flag is rejected by the 7.3.1 CLI parser (06 R7). There's also a `crealityprintlink://open/` token in `process_command_line()` that forces sending, but it wasn't needed.

### 1.4 3MF into a dirty project: PASS (the app asks)

Container `crp-research-R-w4` (`ft-watcher2`, `AUTO_OPEN_PATTERN` including `3mf`). The project was saved as `/config/Desktop/proj1.3mf`, then modified. Uploading `projb.3mf`:

- The full-window dialog **"Drop project file"**: "Please select an action projb.3mf", ○ Open as project, ● Import geometry only (default), OK/Cancel. `$R/shots/W4c-after-3mf-upload.png`
- Choosing *Open as project* + OK gives **"Creality Print - Save: The current project has unsaved changes. Would you like to save before continuing?"** with Yes / No / Cancel and "Remember my choice". `$R/shots/W4d-after-ok.png`
- Cancel keeps all objects and the 0.28 layer height. `$R/shots/small-W4e-after-cancel.png`
- So a 3MF can only replace the project after two explicit clicks. The default ("Import geometry only") adds the 3MF's objects to the plate [I: default radio seen, the import itself not run].

### 1.5 Safer watcher: `crp-research:ft-watcher2` (prototyped, PASS)

**Design.** Don't start a second app process and don't touch `Creality.conf`. Call the running app's D-Bus method directly, exactly as a forwarding instance would:

```
dbus-send --session --type=method_call \
  --dest=io.github.crealityofficial.CrealityPrint.InstanceCheck.Object<hash> \
  /io/github/crealityofficial/CrealityPrint/InstanceCheck/Object<hash> \
  io.github.crealityofficial.CrealityPrint.InstanceCheck.Object<hash>.AnotherInstance \
  "string:/opt/crealityprint/bin/CrealityPrint;/config/Desktop/block35.stl"
```

- `<hash>` (the hash of the executable path) is found with `org.freedesktop.DBus.ListNames`.
- The session bus is the X11-autolaunched one on `:0` (`dbus-daemon --session`, PID 491 in w3). **`DISPLAY=:0` must be forced**: the container env has `DISPLAY=:1` (X11-mode default), and with that `dbus-send` fails with "failed to connect to X11 display" [V].
- The argument separator is `;`, not a space. A first attempt with a space-joined string was accepted on the bus but silently ignored (the whole string counted as argv[0]). `dbus-monitor` on a real forward showed `string "/opt/crealityprint/bin/CrealityPrint;/config/Desktop/block35.stl"` [V].

Files (in `$R/image-watcher2/`):

- `Dockerfile`: `FROM crp-research:baseline`, `+ inotify-tools`, `COPY /root /` (the same as agent H's).
- `root/etc/s6-overlay/s6-rc.d/svc-upload-watcher/` is unchanged (longrun, depends on `svc-de`, `exec s6-setuidgid abc /usr/local/bin/crp-upload-watcher`).
- `root/usr/local/bin/crp-open-in-running-app` (= `$R/scripts/dbus-open.sh`):

```bash
#!/bin/bash
# Ask the running Creality Print to load files, the same way a second instance would,
# without starting a second instance. usage: dbus-open.sh <file>...
# Why: the app listens on the session bus for "AnotherInstance" whatever single_instance says.
# The image ENV sets DISPLAY=:1 (X11 mode); in Wayland mode the app is on Xwayland :0.
export DISPLAY=:0
name_prefix="io.github.crealityofficial.CrealityPrint.InstanceCheck.Object"

find_bus_name() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.ListNames \
    | grep -o "${name_prefix}[0-9]*" \
    | head -1
}

# Quote one argument like the app's escape_strings_cstyle() (libslic3r/Config.cpp):
# quote when it holds ; space tab \ " CR or LF, and escape \ and " inside the quotes.
quote_argument() {
  local argument="$1"
  if [[ "$argument" =~ [\;[:space:]\"\\] ]]; then
    argument="${argument//\\/\\\\}"
    argument="${argument//\"/\\\"}"
    printf '"%s"' "$argument"
  else
    printf '%s' "$argument"
  fi
}

bus_name="$(find_bus_name)"
if [ -z "$bus_name" ]; then
  echo "Creality Print is not listening on the session bus" >&2
  exit 1
fi
instance_hash="${bus_name#"$name_prefix"}"

# Arguments are joined with ";" (not spaces); the first one (the executable) is skipped.
message="/opt/crealityprint/bin/CrealityPrint"
for file_path in "$@"; do
  message+=";$(quote_argument "$file_path")"
done

dbus-send --session --type=method_call \
  --dest="$bus_name" \
  "/io/github/crealityofficial/CrealityPrint/InstanceCheck/Object${instance_hash}" \
  "${bus_name}.AnotherInstance" \
  "string:${message}"
```

- `root/usr/local/bin/crp-upload-watcher`: the same inotify logic as agent H's (a `moved_from .selkies-upload-*` followed by `moved_to <model>`). What changed:
  - `open_in_app` calls `crp-open-in-running-app "$file"`. Only if that fails (no app on the bus) does it start `DISPLAY=:0 GDK_BACKEND=x11 /opt/crealityprint/AppRun "$file"`.
  - `enable_single_instance` and all config editing are gone.
  - The default pattern is `\.(stl|obj|step|stp|amf|ply|oltp)$`, **without 3mf**, overridable with `AUTO_OPEN_PATTERN`.

Build: `cd $R/image-watcher2 && docker build -t crp-research:ft-watcher2 .`

Results (container `crp-research-R-w4`, `single_instance` left at its default `false`, `-e 'AUTO_OPEN_PATTERN=\.(stl|3mf|obj|step|stp|amf|ply|oltp)$'`):

| Scenario | Result | Evidence |
|---|---|---|
| A. Unsaved dirty project (moved cube, layer height 0.28) + upload `block35.stl` | **PASS**: both objects, 0.28 kept, one app process, watcher logs `added /config/Desktop/block35.stl to the running app` | `$R/shots/W4a-dirty.png`, `$R/shots/W4a-after-upload.png` |
| B. Ctrl+S → `/config/Desktop/proj1.3mf` (title "proj1"), move a cube, upload `sphere.stl` | **PASS**: three objects, title still "proj1", 0.28 kept. Saving `proj1.3mf` did **not** trigger the watcher even with `3mf` in the pattern | `$R/shots/small-W4b-saved-then-modified.png`, `$R/shots/small-W4b-after-upload.png` |
| C. Upload `projb.3mf` into that project | **PASS**: dialogs as in §1.4, Cancel keeps everything | `$R/shots/W4c-after-3mf-upload.png`, `$R/shots/W4d-after-ok.png`, `$R/shots/small-W4e-after-cancel.png` |
| D. Upload while the app's GTK Import dialog is open | **PASS**: the dialog stays and lists the new file. The model is added after the dialog closes (Escape) | `$R/shots/small-W4f-dialog-after-upload.png`, `$R/shots/small-W4f-after-escape.png` |
| E. File name with a space (`my sphere.stl`, sent by hand with the script) | **PASS**: log `load_files start filename /config/Desktop/my sphere.stl` | `$R/shots/W3e-dbus-space-path.png` |
| F. No app running (container without host ports, app killed, upload via `curl … /api/upload` inside the container) | **PASS**: watcher logs `no running app found, starting it with /config/Desktop/fallback.stl`, and a window "fallback" appears. The next upload goes over D-Bus to that process (still one process) | `docker logs crp-research-R-fb` (container removed) |
| G. Drag-and-drop of 2 files + a folder (§3) | **PASS** for the 2 top-level files. `dropdir/in-folder.stl` was uploaded but not opened (the watcher isn't recursive) | `$R/shots/small-D3-after-drop.png` |

**Remaining behaviour to know [V]:**

- Forwarded models are placed at the **bed centre** and are not auto-arranged. They can overlap existing objects, and the app shows "<name> is too close to others; there may be collisions when printing". The user should press *Arrange* afterwards [I: Arrange not tested here].
- Each forwarded model is its own undo step ("Load File: …" snapshot) [V source, not clicked].
- The app raises its main window (`mainframe->Raise()`), so the plate comes to the front even if the user was on another tab [V source].

**Recommendation:** ship `ft-watcher2`'s approach as the opt-in `AUTO_OPEN_UPLOADS=true`, with mesh formats only by default. Leave `single_instance` alone (default `false`), so a user who launches a second app from the menu still gets a second window, as on the desktop. If 3MF auto-open is wanted, the app's own dialogs keep it safe (§1.4).

---

## 2. Clipboard

Container `crp-research-R-w4` (then `crp-research-R-c1` for the disabled case). URL `https://localhost:3701` (self-signed, `ignoreHTTPSErrors`), context permissions `clipboard-read` and `clipboard-write` granted for the origin. Selkies 2.2.1 defaults: `SELKIES_ENABLE_CLIPBOARD=true`, binary clipboard on, seamless on.

| Case | Steps | Result | Evidence |
|---|---|---|---|
| Text browser → app | `navigator.clipboard.writeText("0.16")` in the page, click the stream, double-click *Layer height*, Ctrl+A, **Ctrl+V**, Tab | **PASS**. Console: `Sent the local clipboard (text/plain) to the session`. `xclip -o -selection clipboard` on `:0` = `0.16`. The field shows 0.16 | `$R/shots/crop-C1-after-tab.png` |
| Text app → browser | Clipboard set to `BEFORE` in the page. In the app: Layer height, Ctrl+A, type `0.24`, Ctrl+A, **Ctrl+C**, wait 3 s, `navigator.clipboard.readText()` | **PASS**. Returns `"0.24"`. X clipboard = `0.24` | act.js output; `$R/shots/C2-after-copy.png` |
| Image browser → app | `navigator.clipboard.write([new ClipboardItem({'image/png': <64×48 PNG>})])`, click the stream, Ctrl+V | **PASS**. Console: `Sent the local clipboard (image/png) to the session`. `xclip -t TARGETS` = `TIMESTAMP TARGETS image/png`, 250 bytes (Chrome re-encodes the PNG) | act.js output (`$R/scripts/clip-img-write.js`) |
| Image app → browser | `xclip -selection clipboard -t image/png -i blue.png` as `abc` on `:0` while the page was connected, then click and Ctrl+C on the stream, then `navigator.clipboard.read()` | **FAIL**. The browser kept `text/plain`. `wl-paste --list-types` on `wayland-0` showed `image/png`, so the compositor had it, but Selkies didn't push it. 3 attempts. Not needed for Creality Print, which doesn't copy images [I] | act.js output |
| `SELKIES_ENABLE_CLIPBOARD=false` | Same text steps | Both directions blocked. Paste left the field unchanged, the browser kept `0.12`, the X clipboard kept `0.24`. Selkies log: `Skipping outbound clipboard service.`, `Rejecting clipboard read: outbound clipboard disabled.` | `$R/shots/crop-C11-paste-disabled.png` |
| Insecure context | `http://172.17.0.1:3700` (non-loopback host IP) | `isSecureContext:false`, `navigator.clipboard` missing, `VideoDecoder` undefined. Page: "Error: This application requires a secure connection (HTTPS). Please check the URL." Playwright can't even grant clipboard permissions there | `$R/shots/small-C9-insecure.png` |

What matters [V unless marked]:

- **Secure context is mandatory**, for the whole client and not just the clipboard. Use `https://<host>:3001` or a TLS reverse proxy. `http://localhost:3000` counts as secure, but only on the same machine.
- **When the sync happens:** browser → session runs when the client sees the paste keystroke (Ctrl+V on the stream) or regains focus. Session → browser runs when the client sends Ctrl+C (`REQUEST_CLIPBOARD`, `input_handler.py` ~L9530) or the server's clipboard monitor fires. So "copy in the app, paste on the laptop" works with the app's normal Ctrl+C. Copying through a context menu only would depend on the monitor [I].
- The browser must allow clipboard access. Chrome prompts once per origin for read. In Firefox, async clipboard read is limited [I], so expect browser differences. The sidebar's clipboard panel is the manual fallback (doc 01 §8).
- Settings: `SELKIES_ENABLE_CLIPBOARD` (`true`/`in`/`out`/`false`), `SELKIES_ENABLE_BINARY_CLIPBOARD`, `SELKIES_CLIPBOARD_SEAMLESS`. Only `false` was tested. The defaults are right for a slicer.
- The text route goes Selkies → `wayland-0` (labwc) data-control → Xwayland selection → the X11 app (CrealityPrint on `:0`). It worked in both directions with no extra packages.

---

## 3. Drag-and-drop onto the stream

Selkies frontend (`/usr/share/selkies/web/selkies-core.js`, copied to `$R/selkies-web/`):

- `dragover`/`drop` listeners sit on **`#overlayInput`**. It's an `<input>` covering the whole viewport (0,0 1600×900 at this size). They're not attached in shared/viewer mode.
- `handleDrop` uses `dataTransfer.items[i].webkitGetAsEntry()` whenever `items` exists. It only falls back to `dataTransfer.files` if `items` is missing. Directories are walked recursively. Every file goes through the normal chunked `POST /api/upload` with `X-Upload-Path` holding the relative path.

Script: `$R/scripts/drop.js <prefix> <url> cdp|synthetic <file>...`

| Method | Result |
|---|---|
| **Synthetic** (`new DataTransfer()` + `File`, `dispatchEvent('drop')` on `#overlayInput`) | **FAIL** (as R4): `webkitGetAsEntry()` returns `null`, so nothing is uploaded and no error is shown. `$R/shots/D2-after-drop.png` |
| **CDP** `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop` at 900,500, `data: {items: [], files: ['/abs/path'], dragOperationsMask: 1}`) | **PASS**. Chrome builds a real `DataTransfer` from the files on disk (the same path as an OS drag [I]), so `webkitGetAsEntry()` works. |

CDP results [V] (`crp-research-R-w4`, watcher2):

- `dropped-cube.stl`: `POST /api/upload` 200 (`X-Upload-Path: dropped-cube.stl`). It lands in `/config/Desktop/dropped-cube.stl` with sha256 `e32906e0…74a67b1`, the same as the source. The watcher added it to the plate. `$R/shots/D1-after-drop.png`
- Two files plus a folder in one drop: three POSTs (`multi-a.stl`, `multi-b.stl`, `dropdir%2Fin-folder.stl`). The folder structure was kept (`/config/Desktop/dropdir/in-folder.stl`). Both top-level STLs were added to the plate. `$R/shots/small-D3-after-drop.png`
- Headless worked, so Xvfb + headed Chrome was not needed.

Snippet (Playwright + CDP):

```js
const cdp = await context.newCDPSession(page);
const data = { items: [], files: ['/path/model.stl'], dragOperationsMask: 1 };
for (const type of ['dragEnter', 'dragOver', 'drop'])
  await cdp.send('Input.dispatchDragEvent', { type, x: 900, y: 500, data });
```

A real OS drag from Finder/Explorer is still worth one manual check, but it uses the same browser code path [I].

---

## 4. Long-session stability

### Method

- Containers: `crp-research-R-long1` (`crp-research:baseline`, no GPU, ports 3710/3711) and `crp-research-R-long2` (`crp-research:baseline` + `--device /dev/dri:/dev/dri`, ports 3700/3701). Both used `--shm-size=1gb` and a fresh copy of `config-run2`. The two runs overlapped in time (CPU 17:17–17:49, GPU 17:26–17:58).
- GPU run engaged the iGPU [V]: Selkies logged `[Wayland] Renderer: GL on /dev/dri/renderD128` and `Mode: H264 (VAAPI)`, and CrealityPrint held 10 fds on `renderD128`. The CPU run used `Renderer: software (Pixman)` and `Mode: H264 (x264)`.
- Driver `$R/scripts/longrun.sh <ctr> <port> <label>`:
  1. Loads `sphere.stl` into the running app through `dbus-open.sh` (§1.5), so no file dialog is involved.
  2. Starts the sampler.
  3. 60 s later, connects one client (`$R/scripts/longsession.js`, headless Chrome, 1600×900 at DPR 2, so the stream is **3200×1800 @ 60 fps**). The client sweeps the pointer over the 3D view every 20 s, orbits with a left-drag for 10 s every 3.4 min (8 orbits), and screenshots every 5 min.
- Sampler `$R/scripts/sample.sh` + `sample-in-container.sh`, once a minute:
  - `docker stats --no-stream` (memory, CPU, PIDs);
  - `df -k /dev/shm` and `du -sk /dev/shm`;
  - the number of distinct deleted `/dev/shm/*` files still mapped (from `/proc/*/maps`, which needs `docker exec --privileged` to read other users' maps);
  - summed RSS of `selkies`, `CrealityPrint`, all `WebKit*`, `Xwayland` and `labwc`;
  - process and thread counts.
- **Deviation:** both runs ended after **~29 min connected** instead of 30. The harness stops background jobs at 30 min, which killed the client (`PAGE CLOSED` at 17:47:14 and 17:56:08) and the sampler. Post-disconnect samples were taken by hand afterwards (`long-*-after.csv`). An earlier CPU attempt was thrown away because the session sat in a GTK file dialog instead of the 3D view (kept in `$R/logs/aborted/`).
- Data: `$R/logs/long-cpu.csv`, `$R/logs/long-gpu.csv`, `$R/logs/long-*-after.csv`, `$R/logs/long-*-docker.log`. Screenshots `$R/shots/long-cpu-m{00,05,11,16,21,26}.png` and `$R/shots/long-gpu-m*.png` all show the live plate with the sphere (`$R/shots/small-long-cpu-m26.png`). Summary script: `python3 -I $R/scripts/analyze.py <csv> 1 29`.

### Results (m0 = before connect, m1 = first sample after connect; values in MiB unless noted)

**CPU only (llvmpipe + x264)** [V]:

| Metric | m0 | m1 | m6 | m11 | m16 | m21 | m26 | m29 | after disconnect (+1 to +3 min) |
|---|---|---|---|---|---|---|---|---|---|
| `docker stats` memory | 1359 | 1608 | 1629 | 1678 | 1857 | 1920 | 1914 | 1914 | 1699 |
| `/dev/shm` used (`df`) | 6.1 | 44.1 | 44.1 | 44.1 | 44.1 | 44.1 | 44.1 | 44.1 | 44.1 |
| `/dev/shm` `du` (named files) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mapped deleted shm files | 5 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 |
| selkies RSS | 99 | 321 | 345 | 371 | 371 | 371 | 371 | 371 | 157 |
| CrealityPrint RSS | 712 | 733 | 737 | 753 | 756 | 756 | 756 | 756 | 756 |
| WebKit RSS (8 procs) | 1440 | 1439 | 1439 | 1439 | 1622 | 1679 | 1679 | 1679 | 1679 |
| Xwayland / labwc RSS | 73 / 45 | 81 / 82 | 81 / 87 | 86 / 92 | 81 / 87 | 86 / 92 | 81 / 87 | 81 / 87 | 81 / 87 |
| PIDs (docker) | 405 | 409 | 414 | 407 | 415 | 415 | 415 | 415 | 402 |
| CPU % | 0.9 | 113 | 7.5 | 695 (orbit) | 8.9 | 719 (orbit) | 4.4 | 8.1 | 3 |

**With `/dev/dri` (Intel UHD 630, iris + VAAPI)** [V]:

| Metric | m0 | m1 | m6 | m11 | m16 | m21 | m26 | m29 | after disconnect (+1/+2 min) |
|---|---|---|---|---|---|---|---|---|---|
| `docker stats` memory | 1450 | 1835 | 1801 | 1794 | 1821 | 1852 | 1826 | 1824 | 1628 |
| `/dev/shm` used (`df`) | 0.13 | 0.13 | 0.13 | 0.13 | 0.13 | 0.13 | 0.13 | 0.13 | 0.13 |
| mapped deleted shm files | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| selkies RSS | 179 | 190 | 191 | 191 | 218 | 218 | 218 | 218 | 207 |
| CrealityPrint RSS | 624 | 624 | 624 | 624 | 624 | 633 | 633 | 633 | 633 |
| WebKit RSS (8 procs) | 1315 | 1315 | 1315 | 1314 | 1316 | 1317 | 1316 | 1317 | 1316 |
| Xwayland / labwc RSS | 99 / 105 | 99 / 105 | 99 / 105 | 99 / 105 | 99 / 106 | 101 / 106 | 101 / 106 | 101 / 106 | 101 / 106 |
| PIDs (docker) | 298 | 301 | 293 | 293 | 292 | 301 | 293 | 301 | 290 |
| CPU % | 2.6 | 8.9 | 9.7 | 63 (orbit) | 9.5 | 60 (orbit) | 5.4 | 7.8 | 2–4 |

### Trend

- **`/dev/shm`: flat in both runs. No sign of base issue #142** [V].
  - CPU mode: it jumps once from 6 MB to 44 MB when the client connects. That's the wlroots/pixman frame buffers (six deleted `/dev/shm/wlroots-*` files mapped by labwc, selkies and Xwayland). It then stays at exactly 45,176 KiB for 29 minutes and after disconnect.
  - GPU mode: frames stay in GPU memory (dmabuf), so `/dev/shm` holds 136 KiB the whole time.
  - `du` is always 0 (nothing named accumulates there apart from the empty `audio.lock`).
  - #142 was about readback modes (4:4:4, JPEG, forced CPU encode) on iGPUs. Those weren't exercised here; the defaults were (H.264 4:2:0, VAAPI or x264).
- **Selkies RSS:** steps up when a client connects (+220 MB at 3200×1800 on x264, +12 MB on VAAPI). It grows a little more over the first ~10 min (+50 MB x264, +28 MB VAAPI in one step around m15), then stays flat. It drops back after disconnect (CPU: 371 → 157 MB). Not a leak [V], and in line with doc 07's note that Selkies RSS scales with stream resolution.
- **CrealityPrint RSS:** +20–40 MB over the session, all in the first ~15 min, then flat to the KiB [V].
- **WebKit:** in the CPU run, the four `WebKitWebProcess` processes grew about 60 MB each, **+240 MB in total between m12 and m17**, then stayed flat for 12+ min and after disconnect. Nothing like it happened in the GPU run. The likely cause is the embedded home/"online" web views refreshing content, rendered with llvmpipe in system memory [I]. That's a one-off step, not a slope, but a multi-hour idle run would be needed to rule out periodic steps.
- **PIDs/threads:** flat (405–416 CPU, 290–301 GPU). There are about 110 more threads without a GPU (llvmpipe worker threads) [I].
- **Container memory (`docker stats`):** CPU 1.36 → 1.91 GiB (connect + the WebKit step), then flat. GPU 1.45 → 1.82 GiB, flat. Both drop about 200 MB after disconnect.
- **CPU:** a connected but mostly idle session costs 4–10 % of the 16-core host in both modes. **Orbiting at 3200×1800 costs ~700 % (7 cores) on llvmpipe + x264, but only ~60 % with the iGPU** [V; sampled mid-orbit at m11 and m21]. This is the most important difference between the two modes for a user.
- No errors in either container's log apart from two harmless `[Clipboard] app-compositor watch ended: Broken pipe` lines at client disconnect in the CPU run. The app stayed up (same PID) through both runs.

**Result: PASS** for 29 minutes per mode. No unbounded growth in `/dev/shm`, PIDs, selkies or the app. One bounded WebKit step (+240 MB) on CPU rendering.


---

## New risks and corrections

| # | Risk / correction | Sev. | Mitigation |
|---|---|---|---|
| R20 (revised) | The watcher prototype in 06 R7 **starts a second app process per upload** (glob bug). The "replaces the plate" observation was a new window on top of the old one. Two processes then share `Creality.conf` and the data dir. | Medium → solved by design | Use the direct D-Bus call (`ft-watcher2`). Don't edit `Creality.conf` from a script while the app runs. |
| R22 (new) | Forwarded and dropped models are placed at the bed centre with no auto-arrange, so they can overlap existing objects (collision warning). | Low | Document "press Arrange after adding several files". Don't try to inject keystrokes from the watcher. |
| R23 (new) | `DISPLAY` in the container env is `:1`, but the app (Wayland mode) runs on Xwayland `:0`. Any helper that talks to the app's X display or its autolaunched session bus must set `DISPLAY=:0` explicitly. | Low | Hard-code `:0` in helpers, as `ft-watcher2` does. |
| R24 (new) | The clipboard and the whole client need a secure context. Plain `http://<lan-ip>:3000` gives a black page with an HTTPS error. | Low (documented upstream) | README: browse to `https://<host>:3001` or put the container behind a TLS proxy. |

## Open points

- A real OS drag (desktop Chrome/Firefox/Safari) and a Firefox clipboard check: manual, about 2 minutes, expected to work (§2, §3).
- Session → browser **image** clipboard did not work in this setup. Only relevant if a future app version copies images.
- `Arrange` after a multi-file drop or upload is not tested.
- The race between a script editing `Creality.conf` and the app rewriting it was inferred from file events, not reproduced (moot with `ft-watcher2`).

## Implications for the image

1. **Upload/drop auto-open:** ship it as opt-in `AUTO_OPEN_UPLOADS=true`, built the `ft-watcher2` way:
   - inotify on `FILE_MANAGER_PATH` for the `.selkies-upload-*` rename;
   - then a direct `dbus-send … InstanceCheck.Object<hash>.AnotherInstance "string:/opt/crealityprint/bin/CrealityPrint;<quoted path>"` on `DISPLAY=:0`;
   - fall back to starting `AppRun <file>` only when no instance is on the bus.

   Don't edit `Creality.conf` at runtime, don't depend on `single_instance`, and don't use agent H's `ft-watcher` (it spawns a second app per upload). With this, unsaved work is safe: STLs are **added** to the current plate, and 3MFs go through the app's own "Drop project file" and "save changes?" dialogs. Default pattern: meshes only (`stl|obj|step|stp|amf|ply|oltp`). Offer `3mf` as an option.
2. **Document the plate behaviour:** uploaded or dropped models appear at the bed centre and can overlap. Press *Arrange*. Each one can be undone.
3. **Drag-and-drop works with no extra image work.** It's the same upload API and lands in `/config/Desktop`, and with (1) it reaches the plate. For CI, test it with CDP `Input.dispatchDragEvent` (snippet in §3), not with a synthetic `DataTransfer`.
4. **Clipboard needs nothing extra in the image.** Keep the Selkies defaults. The README should say: use **HTTPS** (`https://<host>:3001` or a TLS proxy). Plain `http://<lan-ip>:3000` gives a black page. Paste with Ctrl+V on the stream, and allow the browser's clipboard prompt. `SELKIES_ENABLE_CLIPBOARD=false|in|out` is there for locked-down setups.
5. **GPU is worth recommending, but not for memory reasons.** Memory and `/dev/shm` were stable in both modes over 29 min (no #142 symptoms, `--shm-size=1gb` is plenty; CPU mode used 44 MB of it). But interaction costs about 7 cores on llvmpipe + x264 at 3200×1800 against about 0.6 cores with `/dev/dri`. Document `--device /dev/dri` as the recommended setup, and plan about 2 GiB RAM per running container, plus more during slicing.
6. **Helper scripts must use `DISPLAY=:0`** (the app's Xwayland display in Wayland mode), not the env's `:1`.
7. **Still manual before release:** one real OS drag-and-drop and one Firefox clipboard check. A multi-hour idle run would show whether the WebKit step (+240 MB on CPU rendering) repeats.

