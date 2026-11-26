# Getting files in and out

How models get from the user's device into Creality Print, and how G-code and projects get back out: Selkies' upload and download, the app's own file dialogs, auto-open of uploads, drag-and-drop, the clipboard, and how to lock the file API down.

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.
Verified against: Selkies 2.2.1 on `baseimage-selkies:debiantrixie`, Creality Print 7.3.1, headless Chrome; plus the e2e tests that run on every build.

- The app's "Open file" dialog sees only the container. Files move through Selkies' web file API instead: sidebar **Files → Upload Files** (or a drop onto the page) and **Files → Download Files**. Both use one folder, `/config/Desktop` by default [V].
- On first run the image points the app's Import and G-code export dialogs at that folder. Save Project (3MF) still opens in the app's log folder [V].
- Opt-in `AUTO_OPEN_UPLOADS=true` hands each finished upload to the running app over its single-instance D-Bus method. Meshes are added to the current plate, and unsaved work is kept [V].
- A drop onto the page is an upload, not a drop into the app. The clipboard carries text both ways, never files [V].
- Without `PASSWORD`, anyone who can reach the port can use the file API. `SELKIES_FILE_TRANSFERS=none` turns it off; `HARDEN_DESKTOP=true` does not [V].
- The web client needs a secure context: `https://<host>:3001`, a TLS proxy, or `http://localhost` [V].

## The upload folder

- Selkies' `file_manager_path`: `SELKIES_FILE_MANAGER_PATH`, else `FILE_MANAGER_PATH`, else `$HOME/Desktop`. lsio sets `HOME=/config`, so the default is `/config/Desktop` [V].
- Uploads land there, and the Files dialog serves the same tree. Upload and download always share this one root [V].
- The first-run seed, the init script and the upload watcher resolve the folder in the same order [V, code; `seed.spec.js` checks it for the seed]. Selkies creates it at start if it is missing, and so does the watcher.
- At start the image re-owns the folder itself to `abc`, never recursively, so the contents of a mounted share are left alone. See [persistence.md](persistence.md) [V, code].

## Uploads

Entry points [V, source; the sidebar button also by e2e]:

- The sidebar (the handle on the left edge, or Ctrl+Shift+M) → **Files** → **Upload Files**. It opens the browser's own file picker (multi-select) and uploads to the root of the folder.
- The **Upload** button inside the **Download Files** dialog uploads into the subfolder being browsed.
- A drop onto the stream (see Drag-and-drop below).

How an upload travels (Selkies web core `lib/file-upload.js`, server `stream_server.py`) [V]:

- `POST <subfolder>/api/upload` with an `application/octet-stream` body. The destination, relative to the folder, is URL-encoded in the `X-Upload-Path` header. Missing subfolders are created.
- Files over 64 MiB go up in 64 MiB slices (`X-Upload-Id`, `X-Upload-Offset`, `X-Upload-Total`, and `X-Upload-Final: 1` on the last), so no single request exceeds a proxy's body limit. A 150 MiB file went up as 3 POSTs in about 2.3 s over localhost, sha256 intact.
- The server writes to a hidden `.selkies-upload-<random>.part` file in the target folder, then renames it into place in one step. Abandoned slices expire after an hour. A finished upload leaves no `.part` file.
- One upload runs at a time. A toast reports "Successfully uploaded <name>" or "Failed to upload <name>: …".
- Files are owned by `abc` (PUID/PGID), mode 644.
- There is no delete or rename endpoint. Uploads pile up in the folder until removed on the host side of the volume.
- lsio's nginx proxies `/api` with `client_max_body_size 0` and request buffering off: no size limit, and Selkies has no quota.

## Downloads

- Sidebar → **Files** → **Download Files** opens a small file manager for the folder: subfolders (never above the root), *New Folder*, *Upload*, a show-hidden toggle, and a **Download** button on each row. Clicking a name does nothing [V].
- A file comes from `GET /api/files/<path>` as an attachment. Range requests work (206), so downloads can resume [V].
- A folder comes as a zip from `GET /api/file-manager/zip?path=<path>`. The root itself can't be zipped (404) [V].
- `GET /api/files/<dir>/` returns an HTML listing [V, source]. The old nginx `/files/` page that older guides describe (e.g. baseimage-selkies#131) no longer exists.
- The server can't push a download to the browser. The only server-initiated path is the CUPS printer "Selkies", which delivers PDFs, so it's no use for G-code [V, source].
- Uploads and downloads share an adaptive pacer, so a big transfer doesn't starve the video. `SELKIES_FILE_TRANSFER_LIMIT_MBPS` adds a fixed cap [V, source].
- The panel is meant for single files, not as a full file explorer (lsio, baseimage-selkies#192).
- For most users the main output path is sending G-code from the app straight to the printer, so nothing has to come back to the browser. See [printers.md](printers.md).

## The app's own file dialogs

- They list the container's file system, as `abc`. Selkies 2.2.1 has no remote file chooser and no xdg-desktop-portal bridge (open request selkies#516; see also selkies#594) [V, source]. wxGTK uses a plain `GtkFileChooserDialog`, so a portal wouldn't be used unless forced [I].
- The GTK3 chooser's sidebar shows *Recent, Home, Desktop, log, Other Locations*. "Desktop" is there without a bookmarks file [V].
- Without a remembered folder, the dialogs start in the app's working directory, its log folder (`/config/.config/Creality/Creality Print/<version>/log`) [V].
- On a fresh volume the image seeds `recent.last_opened_folder` and `app.last_export_path` with the upload folder (how and when: [persistence.md](persistence.md)). With that:

| Dialog | Opens in |
|---|---|
| Import (Ctrl+I) | the upload folder [V] |
| Export G-code (*Slice plate*, then the arrow next to *Send print*, then *Export G-code*) | the upload folder, with a name such as `cube_PLA_12m35s.gcode` [V] |
| Save Project (Ctrl+S, 3MF) | **the log folder**, even when the keys are seeded [V] |

- For Save Project, click *Desktop* in the dialog's sidebar or type the full path (`/config/Desktop/name.3mf`).
- After an import, the app writes `recent.last_opened_folder` itself [V].
- The GTK chooser follows symlinks inside the folder; the file API refuses those that leave it (see Security) [V].

## Auto-open of uploads

Opt-in with `AUTO_OPEN_UPLOADS=true` (case-insensitive). Otherwise the s6 service `svc-crealityprint-upload-watcher` only sleeps, and the log has no `[crealityprint-upload-watcher] watching` line [V, e2e]. Rejected designs are recorded in [decisions.md](decisions.md).

### How the watcher works [V, code]

- The service runs `crealityprint-upload-watcher` as `abc`, after the desktop (`svc-de`) is up.
- `inotifywait` watches the top level of the upload folder for renames. A `moved_to` that directly follows a `moved_from` of `.selkies-upload-*` is a finished web upload.
- Files the app saves into the folder don't arrive that way, so they never trigger, even a 3MF with `3mf` in the pattern [V].
- Only names matching `AUTO_OPEN_PATTERN` (a regex, case-insensitive) are opened. The default, `\.(stl|obj|step|stp|amf|ply|oltp)$`, is meshes only: a 3MF would replace the project (the app asks first).
- Not recursive: files uploaded into a subfolder, or inside a dropped folder, are uploaded but not opened [V].

For each finished upload:

1. If `crealityprint-idle is-quit` says the idle timer closed the app, log it and leave the file in the folder. The app stays closed (see With IDLE_QUIT below).
2. Hand the file to the app with `crealityprint-open`. Success logs `added <path> to the running app`. The model starts loading about 2 s after the upload finishes: the hand-over takes under 20 ms, the rest is inside the app [V, three uploads].
3. If that fails while a `CrealityPrint` process runs (still starting, not yet on the bus), retry once a second for about 10 s. If it still fails, log that the app isn't reachable and leave the file for a manual import.
4. If no app runs, start the launcher `/usr/local/bin/crealityprint <file>` on `DISPLAY=:0`, detached the same way the idle daemon starts the app (`setsid --fork` from `$HOME`, so s6 never signals it). The file opens as the startup project, and later uploads go over D-Bus to that process [V].

It never starts a second app next to a running one, and never edits `Creality.conf`.

### `crealityprint-open` and the app's single-instance call

`crealityprint-open <file>...` asks the running app to load files the way a second app instance would, without starting one. It exits 1 when no app is on the bus. It also works by hand inside the container, run as `abc` [V, e2e].

- Every first app instance registers `io.github.crealityofficial.CrealityPrint.InstanceCheck.Object<hash>` on the session bus, where `<hash>` is a hash of the executable path. It does so whatever `single_instance` says. That flag only decides whether a *new* process forwards its arguments and exits (`InstanceCheck.cpp`) [V, source]. More in [app.md](app.md).
- The helper finds the name with `org.freedesktop.DBus.ListNames`. It calls `AnotherInstance` on `/io/github/crealityofficial/CrealityPrint/InstanceCheck/Object<hash>` with one string: `/opt/crealityprint/bin/CrealityPrint;<file>;<file>…`. The app skips the first entry.
- Arguments are joined with `;`, not spaces. Each is quoted like the app's `escape_strings_cstyle()`: wrapped in `"` when it holds `;`, whitespace, `"` or `\`, with `\` and `"` escaped inside. A space-joined string is accepted on the bus but ignored, because it all counts as the first entry [V]. A file name with a space loads correctly [V, e2e].
- A successful `dbus-send` doesn't prove the file loaded: the app silently drops arguments that aren't existing paths. The e2e test therefore checks the app log for `load_files start filename …` [V].
- The session bus is the one X11 autolaunch starts on `:0`. The helpers force `DISPLAY=:0`, because the container env says `:1`, with which `dbus-send` can't connect [V]. So auto-open relies on Wayland mode, the image default ([decisions.md](decisions.md)); X11 mode would need a different display and bus [I].
- `abc` must be able to read `/config/.dbus`; the image re-owns it at start ([persistence.md](persistence.md)).
- The 7.3.1 command line rejects `--single-instance` ("Invalid option") [V].

### What the user sees [V, hands-on unless marked]

| Upload | Result |
|---|---|
| A mesh into an unsaved, or saved-then-modified, project | Added to the current plate. Moved objects and changed settings are kept, no prompt, the window title (project name) stays, still one app process |
| A 3MF (only with `3mf` in the pattern) into a non-empty plate | "Drop project file": *Open as project* or *Import geometry only* (the default). *Open as project* then asks to save unsaved changes, and Cancel keeps everything. A 3MF replaces the project only after two explicit clicks |
| While a modal dialog is open (e.g. Import) | The dialog stays and lists the new file. The model is added once it closes |
| Several files at once | Each top-level model is added |
| G-code | Opens as a preview only; models mixed with G-code are refused [V, source] |

- Forwarded models land at the **bed centre** without arranging, so they can overlap ("… is too close to others"). Press *Arrange* afterwards [I: Arrange not tested].
- Each forwarded model is its own undo step ("Load File: …"), and the app raises its main window [V, source].

### With IDLE_QUIT

- While the idle timer has the app closed, the watcher skips uploads and leaves the app closed. Otherwise it would start the app for a file nobody is looking at, and the timer would close it again and drop the plate [V, code].
- Only uploads through the file API with no browser connected (e.g. `curl`) hit this. The file stays in the folder; import it after reconnecting. Uploads from the sidebar or a drop always have a browser connected, so the app is running.
- If the user closed the app themselves, there is no idle marker, and the watcher starts the app with the file. With no browser connected, the timer closes it again after `IDLE_QUIT_AFTER`, and the app's unsaved-project backup offers the plate back on the next start. See [idle-quit.md](idle-quit.md).

## Drag-and-drop onto the stream

- Selkies listens for `dragover` and `drop` on `#overlayInput`, the transparent input layer over the whole video. Not in shared/viewer mode [V, source].
- A drop never reaches the app under the cursor. The browser turns it into normal chunked uploads to the root of the folder. Dropped folders are walked recursively and keep their relative paths [V].
- With auto-open, dropped top-level models reach the plate; files inside a dropped folder don't [V].
- To automate it, use Chrome DevTools `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop`, with real file paths in `data.files`). It works headless, because Chrome builds a real `DataTransfer` from the files on disk [V].
- A synthetic `new DataTransfer()` dispatched from page script fails silently: `webkitGetAsEntry()` returns `null`, and the handler only falls back to `dataTransfer.files` when `items` is missing [V].
- A real OS drag (Finder, Explorer) hasn't been checked by hand. It uses the same browser path [I]. It is an open question in [decisions.md](decisions.md).

## Clipboard

Text works both ways over HTTPS in Chrome, and CI tests it [V, e2e].

- Browser → session: when the client sees the paste keystroke (Ctrl+V on the stream), or when the page regains focus [V; focus from source].
- Session → browser: when the client sends Ctrl+C on the stream, or when Selkies' clipboard monitor sees a change. So the app's normal Ctrl+C works [V]. Copying through a context menu only relies on the monitor [I].
- The route is Selkies → labwc data-control on `wayland-0` → the Xwayland selection → the app on `:0`. No extra packages are needed [V].
- Images: browser → session works (`image/png`; Chrome re-encodes it) [V]. Session → browser did not arrive, although the compositor had the image [V]. That doesn't matter, because Creality Print doesn't copy images [I].
- Files never travel over the clipboard. The sidebar's clipboard panel rejects anything but images [V, source].
- The browser must allow clipboard access; Chrome asks once per origin for read. Firefox limits async clipboard reads and is untested [I].
- The sidebar's Clipboard section shows the text received from the session, and is the manual fallback [V, e2e].
- `SELKIES_ENABLE_CLIPBOARD=false` blocks both directions [V]. `in` and `out` are untested.

## Secure context

- The whole web client needs a secure context (WebCodecs `VideoDecoder`, `navigator.clipboard`). On plain `http://<lan-ip>:3000` the page says "This application requires a secure connection (HTTPS)", and the user sees a black page [V].
- Use `https://<host>:3001` (self-signed certificate) or a TLS reverse proxy. `http://localhost:3000` counts as secure, but only on the same machine [V].

## NAS and other folders

- Bind-mount a share under the folder (`-v /mnt/nas/3d:/config/Desktop/nas`), or mount it elsewhere and point the folder at it (`-v /mnt/nas/3d:/models -e FILE_MANAGER_PATH=/models`). Both work for upload, browse, download and zip [V]. With the second, `/config/Desktop` still exists but the web UI no longer uses it.
- A `:ro` mount can be browsed and downloaded. An upload into it fails with 400 "Read-only file system" [V].
- Use a bind mount, not a symlink: the file API refuses symlinks that leave the folder [V].
- PUID/PGID must match the share's owner, or uploads fail with permission errors [I]. Anyone who reaches the UI can download the whole mounted tree.
- lsio recommends an extra volume for model libraries (docker-orcaslicer#17, selkies#195).
- Without Selkies at all: reach the same share from the laptop over SMB/NFS, or run a file-browser sidecar on the volume (adds delete and rename, and a second login to secure) [I].

## Security

**No auth by default.** Without `PASSWORD`, anyone who reaches port 3000 or 3001 can list, download and upload in the folder, and control the desktop. `PASSWORD` (user `abc`, or `CUSTOM_USER`) puts nginx basic auth on the whole server, `/api/*` included [V, e2e]. lsio calls basic auth adequate for a trusted home LAN only; anything reachable from the internet belongs behind a proxy with real auth.

**Turning transfers off** [V; the first two rows and `PASSWORD` also by e2e]:

| Setting | Upload | Browse, download | Files section |
|---|---|---|---|
| defaults | 200 | 200 | shown |
| `SELKIES_FILE_TRANSFERS=none` | 403 | 403 | hidden |
| `SELKIES_FILE_TRANSFERS=upload` | 200 | 403 | Upload only |
| `HARDEN_DESKTOP=true` | 200 | 200 | hidden |
| `SELKIES_UI_SIDEBAR_SHOW_FILES=false` | 200 | 200 | hidden |
| `PASSWORD` set, no credentials | 401 | 401 | (page 401) |

- `HARDEN_DESKTOP=true` writes an **empty** `SELKIES_FILE_TRANSFERS`. s6 treats an empty env file as unset, so Selkies falls back to `upload,download` [V, base build ls153]. Selkies itself would treat an empty value as off (selkies#239), but it never receives one. Set `SELKIES_FILE_TRANSFERS=none` explicitly.
- View-only and shared viewers are always refused [V, source]. Hiding the Files section is not a security control.

**Scope.** The API reaches the whole folder tree, hidden files included. **Never set the folder to `/config`**: that would expose the app config, cloud tokens and `ssl/cert.key`.

**Paths** [V]:

- `..` and NUL are rejected (400). A leading `/` in `X-Upload-Path` is stripped, so `/etc/x` lands in `<folder>/etc/x`.
- The resolved path must stay under the root. The folder walk is checked step by step through `/proc/self/fd`, the staging file opens with `O_NOFOLLOW`, and zips don't follow symlinks.
- nginx normalises `../` and `%2e%2e` in URLs before proxying (404).
- Symlinks out of the root are refused: download 403 "Directory Traversal detected", browse 400, upload 400 "path escape rejected". The listing still shows the link. Bind mounts under the root pass.

**Size and proxies.**

- There is no upload size limit and no quota, so a logged-in user can fill the disk [V].
- A reverse proxy in front must accept request bodies of at least 64 MiB on `/api` (or no limit), with request buffering off and long timeouts, as lsio's own nginx does. A smaller limit breaks uploads larger than it, and nginx's 1 MiB default breaks nearly all of them [I: expected 413, not tested].

**Cross-site requests.**

- An upload needs a custom header and an `application/octet-stream` body, so a cross-site page triggers a CORS preflight. The server sends no CORS headers, so the preflight fails [I].
- Zip downloads refuse cross-site requests (`Sec-Fetch-Site`, 403 "Forbidden origin") [V]. A plain `GET /api/files/…` has no such check, but a cross-origin page can't read the response [I].
- lsio sets `SELKIES_ALLOWED_ORIGINS=*`, which relaxes only the WebSocket origin check. Set it to your own origin when exposed [V, source].

**Audit.** `SELKIES_AUDIT_WEBHOOK_URL` sends one JSON POST per upload, download or clipboard event, metadata only [V, source].

## Settings

| Variable | Default | Effect |
|---|---|---|
| `SELKIES_FILE_MANAGER_PATH`, `FILE_MANAGER_PATH` | `/config/Desktop` | The upload and download folder; the first one set wins |
| `SELKIES_FILE_TRANSFERS` | `upload,download` | Allowed directions; `none` blocks the API |
| `SELKIES_FILE_TRANSFER_LIMIT_MBPS` | `0` (off) | Fixed cap shared by both directions |
| `SELKIES_UI_SIDEBAR_SHOW_FILES` | `true` | Shows the Files section; `false` only hides it |
| `AUTO_OPEN_UPLOADS` | `false` | Hand finished uploads to the running app |
| `AUTO_OPEN_PATTERN` | `\.(stl\|obj\|step\|stp\|amf\|ply\|oltp)$` | File names to open (case-insensitive) |
| `SELKIES_ENABLE_CLIPBOARD` | `true` | `true`, `in`, `out` or `false` |
| `SELKIES_ENABLE_BINARY_CLIPBOARD` | `true` | Images and rich text on the clipboard |
| `SELKIES_CLIPBOARD_SEAMLESS` | `true` | Automatic sync, without the clipboard panel |
| `PASSWORD`, `CUSTOM_USER` | unset, `abc` | Basic auth on the UI and the file API |
| `SUBFOLDER` | `/` | URL prefix; the client builds `api/…` URLs relative to the page [V, source; untested] |

A `|locked` suffix (e.g. `SELKIES_ENABLE_CLIPBOARD=in|locked`) stops the user from changing the setting in the UI [V, source]. The user-facing summary is in [../../README.md](../../README.md).

## What CI covers

The e2e tests in `tests/e2e/` run on every build [V]:

- `transfer.spec.js`: a sidebar upload lands intact in `/config/Desktop`; the Files dialog downloads a file intact; `SELKIES_FILE_TRANSFERS=none` gives 403 and no Files section; `PASSWORD` gives 401 without credentials and 200 with them.
- `watcher.spec.js`: an API upload of `e2e watch.stl` reaches the running app (watcher log and app log), with still one app process; a `.txt` upload is ignored; the watcher is off by default.
- `clipboard.spec.js`: text both ways over HTTPS.

Not covered by CI: drag-and-drop, chunked uploads, bind mounts and symlinks, the 3MF dialogs, `HARDEN_DESKTOP`, and the image clipboard.
