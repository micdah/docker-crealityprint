# 06: File transfer (getting models in, getting G-code/3MF out)

Research date: **2026-11-21** (desk research, Phase 1; no containers were run).

Question: the app runs in a container and is streamed to a browser tab. How does a user get an STL from
their laptop into Creality Print, and how do they get sliced G-code/3MF back out? Can the app's own
"Open file" dialog reach the laptop's disk?

Markers: **verified** means I read it in source or official docs at the SHAs below. **Inferred** means
reasoning or general knowledge that still needs a hands-on check.

## Sources and versions

| Source | Ref | Notes |
| --- | --- | --- |
| `linuxserver/docker-baseimage-selkies` | `master` @ `a7d1dfd0cd98b6992786a4883382f1094d075534` (2026-11-21) | `Dockerfile`, `root/defaults/default.conf`, `root/etc/s6-overlay/s6-rc.d/{init-nginx,init-selkies-config,svc-selkies}/run` |
| `selkies-project/selkies` | tag `2.2.1` = `d6b9351421bd503ffa89bdee78e2bce758b1ffe5` (2026-11-04) | The version lsio pins (`ARG SELKIES_RELEASE=2.2.1`, Dockerfile L4/L41/L100). Python server `src/selkies/`, web core `addons/selkies-web-core/`, dashboard `addons/selkies-dashboard/` |
| `linuxserver/docker-orcaslicer` | `master` @ `4b114d95b04b4517e79d01cd6681b843bce10ef2` (2026-11-17) | `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie`, `PIXELFLUX_WAYLAND=true` |
| `CrealityOfficial/CrealityPrint` | `master` @ `6262848e302b8c0d593f2b341cd01310aa2f58a1` | `src/libslic3r/AppConfig.cpp`, `src/slic3r/GUI/InstanceCheck.cpp` |
| lsio docs | <https://docs.linuxserver.io/selkies/user-guide/web-client/>, <https://docs.linuxserver.io/selkies/user-guide/configuration/>, <https://docs.linuxserver.io/selkies/user-guide/security/> | Fetched 2026-11-21 |

**How lsio builds Selkies (verified, Dockerfile):** lsio no longer uses a fork. It clones upstream
`selkies-project/selkies` at tag `2.2.1`, applies two small UI patches (`patches/keyboard-drag.patch`,
`patches/ios-keyboard.patch`, neither about files), builds `addons/selkies-web-core` and
`addons/selkies-dashboard` (L19-L37), copies the build to `/usr/share/selkies` (L371), and pip-installs the
upstream server wheel `selkies-2.2.1-py3-none-any.whl` (L283).

**History (verified):** up to 2026-09-12, the lsio nginx config had a `location SUBFOLDERfiles` block that
served the download folder with `fancyindex` (see `root/defaults/default.conf` at `bf839c0`). Commit
`c28cd61` ("master selkies v2", 2026-09-12) removed it. Downloads now go through the Selkies Python server
at `/api/files/`. Older blog posts, issues (for example
[baseimage-selkies#131](https://github.com/linuxserver/docker-baseimage-selkies/issues/131)) and
screenshots describe the old nginx `/files/` page. The `libnginx-mod-http-fancyindex` package is still
installed (Dockerfile L189), but no location uses it any more.

## 1. How uploads work (laptop to container)

### UI entry points (verified)

1. **Sidebar, "Files" section, "Upload Files" button.** To open the sidebar, click the handle on the left
   edge (`div.toggle-handle[role=button]`, aria-label "Show toolbar") or press **Ctrl+Shift+M**
   (`addons/selkies-dashboard/src/layouts/sidebar.tsx` L8-L9, L140-L145). The Files section
   (`panels/catalog.ts` L113-L114) holds two buttons (`panels/catalog-bodies.tsx` L21-L38):
   - **Upload Files** dispatches the `requestFileUpload` event. The web core then clicks a hidden
     `<input type="file" id="globalFileInput" multiple>` (`selkies-wr-core.js` L3018-L3024;
     `selkies-ws-core.js` ~L4305). The browser's own native file picker opens on the laptop.
   - **Download Files** opens the file-manager dialog (see section 2). That dialog also has an
     **Upload** button (aria-label "Upload"). It uploads into the folder you are browsing
     (`panels/file-manager.tsx` L308: `requestFileUpload` with `detail.directory = cwd`).
2. **Drag and drop onto the stream.** Both transports attach `dragover`/`drop` handlers to
   `#overlayInput`, the transparent input layer over the video (`selkies-wr-core.js` L3075-L3076,
   `selkies-ws-core.js` L5145-L5146). Dropped files, and whole folder trees, are uploaded one after another.
   The relative path is kept (`lib/file-upload.js` L177-L212). The lsio docs say: "drag and drop files
   anywhere on the session window, or use the Upload button."

   **Important (verified):** a drop does **not** reach the app under the cursor. The browser intercepts
   it and turns it into an HTTP upload to the landing directory. Dropping an STL onto Creality Print's
   3D view does not import it. The user still has to open it from the landing folder (or use the
   automation idea in section 5.6).

### Wire protocol (verified)

`addons/selkies-web-core/lib/file-upload.js`:

- Every upload is an HTTP `POST <subfolder>/api/upload` (XHR, `withCredentials`). The body is
  `application/octet-stream`. The destination path, relative to the landing directory, is URL-encoded in the
  `X-Upload-Path` header. In secure mode, a session token goes in an `Authorization: Bearer` header.
- Files up to **64 MiB** (`UPLOAD_CHUNK_BYTES`) go up in one POST. Larger files are cut into 64 MiB
  slices with `X-Upload-Id`, `X-Upload-Offset`, `X-Upload-Total`, and `X-Upload-Final: 1`. The slicing
  is "so no single request body exceeds a fronting proxy's per-request cap (Cloudflare rejects bodies
  over 100 MB)".
- Only one upload operation runs at a time. Progress goes to the dashboard as `fileUpload` window
  messages. A toast says "Successfully uploaded {fileName}" or "Failed to upload {fileName}: ..."
  (`translations.ts` `uploads.*`).

Server side (`src/selkies/stream_server.py`):

- Route table (L4253-L4266):
  `POST /api/upload`, `GET /api/file-manager/browse`, `POST /api/file-manager/mkdir`,
  `GET /api/file-manager/zip`, `GET /api/files/{path:.*}`. There is **no delete or rename endpoint**.
- `handle_upload` (L2985 and on): it refuses view-only credentials (403), and it refuses requests when
  `"upload" not in settings.file_transfers` (403 "uploads disabled"). It then normalises the path with
  `_file_parts` (L3176: drops `.`/empty parts, rejects `..` and NUL) and checks that
  `dest.startswith(root + "/")`. It opens the parent folder with `_open_dir_fd` (L3220), which walks
  one path part at a time and checks each step through `/proc/self/fd`. It raises `FileRootEscape` if a
  symlink leads outside the root. Data is written to a hidden staging file in the target folder
  (`.selkies-upload-<random>.part`), then renamed into place in one atomic step. Abandoned chunked
  parts expire after `UPLOAD_PART_TTL_SECONDS = 3600`. Missing subfolders are created.
- In lsio, nginx proxies `location SUBFOLDERapi` to the Selkies server (`127.0.0.1:8082`) with
  `client_max_body_size 0` (no limit) and `proxy_request_buffering off` (`default.conf` L26-L40, the same
  on the 3001/TLS server). **The built-in nginx sets no upload size limit.**

### Where uploads land (verified)

- Selkies setting `file_manager_path`, default `~/Desktop`. Environment variables: `SELKIES_FILE_MANAGER_PATH`,
  falling back to `FILE_MANAGER_PATH` (`settings.py` L834-L838). The help text: "Directory for client file transfers on both
  transports: uploads land here and the file-browser/download API serves it (created at startup if
  missing)."
- lsio sets `HOME=/config` (Dockerfile `ENV`). So the default landing directory is **`/config/Desktop`**.
  `init-nginx/run` L12/L33 also creates it as user `abc`:
  `FILE_MANAGER_PATH="${FILE_MANAGER_PATH:-$HOME/Desktop}"` and
  `s6-setuidgid abc mkdir -p ${FILE_MANAGER_PATH}`.
- **It can be changed** with `FILE_MANAGER_PATH=/some/dir`. The `abc` user (PUID/PGID) must be able to
  write to it, as the lsio docs say: "must be writable by the `abc` user". Upload and download use **the
  same root**. You cannot upload to one folder and serve downloads from another.

## 2. How downloads work (container to laptop)

### UI (verified)

- Sidebar, then **Files**, then **Download Files** opens the "Files" dialog (`panels/files.tsx`, subtitle
  "Download and manage files"). It is a React file manager (`panels/file-manager.tsx`) that lists
  `FILE_MANAGER_PATH` through `GET /api/file-manager/browse?path=<rel>` (JSON). You can move into
  subfolders, but **not above the root**. It also has "New Folder" and "Upload" buttons, a
  show-hidden-files toggle, and a **Download** button on every row (aria-label "Download").
- Clicking a row's Download button makes a temporary `<a download>` element and clicks it
  (`file-manager.tsx` L272-L286). A file downloads from `GET /api/files/<rel path>` with
  `Content-Disposition: attachment`. A folder downloads as a zip from
  `GET /api/file-manager/zip?path=<rel>`, but the root folder itself cannot be zipped. Clicking a file's
  *name* does nothing. Only the Download button downloads.
- Requesting a directory URL directly at `GET /api/files/<dir>/` returns a styled HTML listing. This is
  the successor of the old nginx fancyindex page (`fancy_index_handler`, L4119-L4200).

### Server rules (verified, `fancy_index_handler`, `handle_files_browse`, `handle_files_zip`)

- Refused for view-only credentials. Refused when `"download" not in file_transfers` ("Forbidden: downloads
  disabled"). Note that **the listing itself needs the `download` permission**.
- Path traversal: `_file_parts` rejects `..`. After that, `realpath` must stay under the root. **A symlink
  inside the root that points outside it is refused (403 "Directory Traversal detected").** So you
  cannot "expose" `/models` by symlinking it into `~/Desktop`. Use a bind mount instead (see 5.2).
- The zip endpoint also refuses cross-site fetches (`_fetched_cross_site`, using `Sec-Fetch-Site`/`Origin`),
  because "a cached Basic login" would otherwise be used for them.
- Both directions are paced by a shared adaptive pacer, so a big transfer does not starve the video
  stream. You can add a fixed cap with `SELKIES_FILE_TRANSFER_LIMIT_MBPS` (default 0 = off).

There is **no "push to browser" for arbitrary files**: the server cannot start a download on its own. The
only server-initiated path is **printing**. A job printed to the session's CUPS printer "Selkies" arrives
in the browser as a PDF (`SELKIES_PRINTING_ENABLED`). That is useless for G-code.

## 3. Environment variables (verified unless marked)

| Variable | Default (lsio) | Effect |
| --- | --- | --- |
| `SELKIES_FILE_TRANSFERS` | `upload,download` | Allowed directions. `""` or `none` turns both off (the bug where the validator ignored this, [selkies#239](https://github.com/selkies-project/selkies/issues/239), was fixed before 2.2.1; `settings.py` L1670). This is the **server-side** gate on every file endpoint. |
| `FILE_MANAGER_PATH` / `SELKIES_FILE_MANAGER_PATH` | `$HOME/Desktop` = `/config/Desktop` | Upload landing directory and download root. |
| `SELKIES_FILE_TRANSFER_LIMIT_MBPS` | `0` | Fixed throttle shared by uploads and downloads. |
| `SELKIES_UI_SIDEBAR_SHOW_FILES` | `true` | **Only hides the UI section.** The API stays reachable unless `SELKIES_FILE_TRANSFERS` blocks it (inferred from code: only `utils.ts` L204 reads it; the server endpoints check `file_transfers` only). |
| `HARDEN_DESKTOP=true` | unset | `init-selkies-config/run` L59-L80: sets `SELKIES_FILE_TRANSFERS=""`, `SELKIES_UI_SIDEBAR_SHOW_FILES=false`, `SELKIES_PRINTING_ENABLED=false`, `SELKIES_COMMAND_ENABLED=false`, and so on, **unless you set them yourself**. **Hands-on (Phase 2): the `SELKIES_FILE_TRANSFERS=""` part does not work.** s6 treats an empty env file as "unset", so Selkies falls back to `upload,download` and the API stays fully open; only the sidebar section is hidden. Set `SELKIES_FILE_TRANSFERS=none` explicitly. |
| `SELKIES_ENABLE_CLIPBOARD` | `true` | `true`/`in`/`out`/`false`. |
| `SELKIES_ENABLE_BINARY_CLIPBOARD` | `true` | Images and rich text on the clipboard. |
| `SELKIES_AUDIT_WEBHOOK_URL` | empty | One JSON POST per upload, download, or clipboard event (metadata only). |
| `CUSTOM_USER` / `PASSWORD` | unset | nginx basic auth across the **whole** server block, including `/api/*` (`init-nginx/run` L37-L40 removes the `#` from `auth_basic`). With no `PASSWORD` there is **no auth at all**. |
| `SUBFOLDER` | `/` | Prefix. The client builds `api/upload` and `api/files` relative to the page URL, so it works under a subfolder. |
| `SELKIES_ALLOWED_ORIGINS` | lsio sets `*` | WebSocket origin check. It does not affect upload CORS (see section 6). |

The `|locked` suffix (for example `SELKIES_ENABLE_CLIPBOARD="in|locked"`) stops the user from changing a
setting in the UI.

## 4. Can Creality Print's "Open file" dialog reach the laptop?

**No.** Verified as far as the code allows, and backed by the upstream feature request.

- Creality Print is a wxWidgets/GTK3 app inside the container. Its Import/Open/Export dialogs list the
  **container's** file system (as the `abc` user). The browser only receives video, audio, input,
  clipboard, and the HTTP file API above. A web page cannot mount or show the client's local file
  system to a remote process.
- Selkies 2.2.1 has **no xdg-desktop-portal FileChooser bridge**, no "remote file chooser", and no
  network drive to the client. `grep` over `src/selkies`, the web core, and the dashboard finds "portal"
  only for screen capture (`settings.py` L824). The upstream issue
  [selkies#516](https://github.com/selkies-project/selkies/issues/516) ("hook up file transfers directly
  to the browser's open/save dialogs with a custom xdg-desktop-portal", opened 2026-11-06) is **open**.
  The maintainers' bot triage says: "Container apps' own Open/Save dialogs see only the container
  filesystem and are unconnected to either path." Related:
  [selkies#594](https://github.com/selkies-project/selkies/issues/594) (DE/portal plugin system, open
  placeholder).
- Even if that portal existed, wxGTK uses a plain `GtkFileChooserDialog` rather than the portal-backed
  `GtkFileChooserNative` (inferred). It would probably not go through a portal unless forced
  (`GTK_USE_PORTAL=1`). Treat "browser-native open dialog" as not possible for now.
- Drag and drop from the laptop onto the app window becomes an upload (section 1), not an XDND drop
  into the app.

## 5. Practical workflows

### 5.1 Upload via the Selkies UI, then open from the landing folder (default, no setup)

Steps: Ctrl+Shift+M, then Files, then Upload Files (or drag onto the stream). The file lands in
`/config/Desktop`. In Creality Print use File, then Import (Ctrl+I), and pick `/config/Desktop`.

Make the landing folder easy to find (checked hands-on in Phase 2; see "Hands-on results"):

- **GTK bookmark:** not needed. The GTK3 chooser already shows "Home" and "Desktop" (`/config/Desktop`)
  in its sidebar with no bookmarks file present (verified hands-on).
- **App default folder:** Creality Print saves the last import folder in its app config, under section
  `recent`, key `last_opened_folder`, and the last export folder under section `app`, key
  `last_export_path` (verified: `AppConfig.cpp` L1489-L1503, L1649-L1690). Pre-filling both with
  `/config/Desktop` on first start makes Import and Export open there (verified hands-on for Import and
  G-code export; without the seed, the first Import opens in the app's log folder). The config file is
  `data_dir()/<SLIC3R_APP_KEY>.conf` (`AppConfig.cpp` L1808-L1813). The exact path and format belong to
  the app-config research.
- Pros: works out of the box, no host setup, works from any device (also phone/tablet), chunked so it
  survives reverse proxies, transfers are paced. Cons: two steps (upload, then import); one file
  operation at a time; no delete in the web UI (files pile up in `/config/Desktop`, so the user deletes
  them in the app's GTK dialog or via the volume).

### 5.2 Bind-mount a host/NAS folder (best for a homelab with a file server)

- Mount the model library, for example `-v /mnt/nas/3d:/config/Desktop` (or a subfolder such as
  `/config/Desktop/library`), or set `FILE_MANAGER_PATH` to the mount point (for example
  `-v /mnt/nas/3d:/models -e FILE_MANAGER_PATH=/models`). The web file manager then shows the same tree,
  so uploads and downloads go straight to the NAS. The user can also reach the files over Samba/NFS from
  the laptop without using the browser at all.
- Use a bind mount, **not a symlink**: the server refuses symlinks that leave the root (section 2).
  A bind mount at or under the root looks like a normal folder from inside the container (verified
  hands-on: `-v host:/config/Desktop/nas` and `-v host:/models -e FILE_MANAGER_PATH=/models` both work;
  a `:ro` mount can be browsed and downloaded, and uploads into it fail cleanly with "Read-only file
  system").
- Pros: no upload step at all for files that are already on the NAS. Sliced output ends up on the NAS
  as well. Survives image updates. Cons: needs host setup; PUID/PGID must match the share's owner
  (otherwise uploads fail with `mkdir failed`/permission errors); NFS/SMB latency (the server already
  moves disk work off the event loop for this reason). The whole mounted tree can be downloaded by
  anyone who can reach the web UI.
- lsio maintainers recommend this in
  [docker-orcaslicer#17](https://github.com/linuxserver/docker-orcaslicer/issues/17): "map an
  additional volume to the container for where I store all my stl's" (j0nnymoe, 2025-04-24). See also
  [selkies#195](https://github.com/selkies-project/selkies/issues/195), answered with `FILE_MANAGER_PATH`.

### 5.3 Download results via the Files dialog

Export G-code/3MF in Creality Print into `/config/Desktop` (or a subfolder). Then go to sidebar, Files,
Download Files, and click **Download** on the row. Folders come down as a zip. Pros: built in, works
everywhere. Cons: manual; you export to the right folder first; this is not a full file explorer (lsio
maintainer in [baseimage-selkies#192](https://github.com/linuxserver/docker-baseimage-selkies/issues/192):
"not really meant to be a full featured file explorer it is more to upload and download single files").

### 5.4 Skip downloads: send G-code from Creality Print straight to the printer over the LAN

For most users this is the main output path: slice, then "Send/Print" to a K1/K2/Ender-3 V3 class printer
on the LAN. Nothing needs to come back to the laptop. It depends on the container reaching the printer
(networking, discovery, and the `network_mode: host` vs bridge question are covered by the
networking/printer-connectivity research doc). Related prior art: OrcaSlicer LAN send issues in
[docker-orcaslicer#8](https://github.com/linuxserver/docker-orcaslicer/issues/8) and
[docker-bambustudio#22](https://github.com/linuxserver/docker-bambustudio/issues/22).

### 5.5 Clipboard

- Text syncs both ways by default (`SELKIES_CLIPBOARD_SEAMLESS=true`). Images and rich text sync when
  `SELKIES_ENABLE_BINARY_CLIPBOARD=true` (default). The dashboard clipboard panel also has an image upload
  that puts a picture on the session clipboard (verified, `panels/clipboard.tsx` header).
- **Files cannot be moved through the clipboard.** There is no `text/uri-list`/file transfer; non-image
  files picked in the clipboard panel are rejected with a warning. The clipboard is fine for pasting a
  model URL or printer IP, and useless for STLs.

### 5.6 Other options

- **Upload, then auto-open (drop-folder watcher):** Creality Print keeps PrusaSlicer's
  single-instance D-Bus forwarding. It sends the file to the running instance over the session bus
  (`io.github.crealityofficial.CrealityPrint.InstanceCheck.Object<version>`), controlled by the app-config
  key `single_instance` (`AppConfig.cpp` L441) (verified). `InstanceCheck.cpp` L77 looks for a
  `--single-instance` argument, but V7.3.1's command-line parser rejects it ("Invalid option
  --single-instance", verified hands-on). The working trigger is `"app": {"single_instance": true}` in
  `Creality.conf` plus a plain `AppRun <file>`. An `inotifywait` service on `/config/Desktop` that
  reacts when a `.selkies-upload-*.part` file is renamed to a model name makes "upload or drag onto the
  browser tab" end up in the scene. **Prototyped and working in Phase 2**; see "Hands-on results".
  > **Superseded:** setting `single_instance` in `Creality.conf` only works if it's set before the app
  > starts, and the Phase 2 prototype never actually set it (bug). The working design calls the running
  > instance's D-Bus method directly. See [12 §1](12-remaining-hands-on.md).
- **In-app model download:** Creality Print's embedded web view (Creality Cloud model library / "model
  mall", plus any MakerWorld-like links) downloads models inside the container, so no transfer is needed
  (inferred; whether the embedded WebKit works in the container is for the app/runtime research).
  Firefox is also installed in lsio slicer images (orcaslicer installs `firefox`), so a user could browse
  Printables/Thingiverse inside the session and save into `~/Desktop` (inferred).
- **Sidecar file browser** (for example `filebrowser/filebrowser`) sharing the same volume. Pros: rename,
  delete, multi-select, share links, its own users. Cons: a second port and container, and a second auth
  surface. Only worth it if the built-in manager's missing delete becomes annoying.
- **Network-share access from the laptop** (Samba sidecar or an existing NAS share) on top of 5.2. This
  gives the laptop's own Finder/Explorer access, which is the closest thing to "the dialog sees my files".

**Recommendation:** default to 5.1 plus a bookmark and pre-filled `last_opened_folder`/`last_export_path`
pointing at `/config/Desktop`. Document 5.2 (`-v <nas>:/config/Desktop/models`, or `FILE_MANAGER_PATH`)
as the best setup for homelab users, and 5.4 as the main output path. Prototype the 5.6 watcher in
Phase 2; if it works, it turns drag-onto-tab into "model appears in the plate".

## 6. Security notes

- **Auth:** without `PASSWORD` there is none. Anyone who can reach port 3000/3001 can list, download,
  and upload in `FILE_MANAGER_PATH`, as well as control the desktop. With `PASSWORD`, nginx basic auth
  covers `/api/*` as well (verified: `auth_basic` is at server level). lsio says basic auth is "Adequate
  for a trusted home LAN, nothing more". For anything internet-facing, put the container behind a
  reverse proxy with real auth (verified, security docs).
- **Exposure:** the file API's reach is the whole `FILE_MANAGER_PATH` tree. Do **not** set it to
  `/config`. That would expose the app config, cloud tokens, and `ssl/cert.key`. Keep it at
  `/config/Desktop` or a dedicated mount. Hidden files can be listed and downloaded (the UI has a "show
  hidden" toggle).
- **Path traversal:** handled carefully in 2.2.1 (verified): `..` and NUL are rejected; the realpath
  prefix is checked; the folder walk is checked per step through `/proc/self/fd` to defeat symlink swaps;
  the staging leaf is opened with `O_NOFOLLOW`; zip archives do not follow symlinks. The flip side is
  that symlinks out of the root don't work (use bind mounts).
- **Upload size:** no limit in the bundled nginx (`client_max_body_size 0`), and no quota in Selkies.
  An authenticated user can fill the disk. If you sit behind your own reverse proxy (SWAG, Traefik, NPM,
  Caddy, Cloudflare), its per-request body limit must be at least **64 MiB** (the client's slice size),
  or uploads of larger files fail. Small default limits (nginx's 1 MiB) break all real uploads, so set
  `client_max_body_size 0` or `>= 64m` on the `/api` path (inferred from the code). Also turn off request
  buffering and allow long timeouts, which lsio's own config does.
- **CSRF:** uploads need a custom header (`X-Upload-Path`) plus `Content-Type: application/octet-stream`.
  So a cross-site page triggers a CORS preflight, and the server sends no `Access-Control-Allow-*`
  headers, which means the preflight fails (inferred). Zip downloads check `Sec-Fetch-Site`. Plain
  `GET /api/files/...` has no cross-site check, but a cross-origin page cannot read the response.
  lsio's `SELKIES_ALLOWED_ORIGINS="*"` relaxes the **WebSocket** origin check only; set it to your own
  origin when exposed.
- **To turn transfers off:** `SELKIES_FILE_TRANSFERS=none` (server-side). Hiding the sidebar section
  alone is not a security control. View-only/shared viewers are always refused. **Do not rely on
  `HARDEN_DESKTOP=true` to turn transfers off**: in Phase 2 it hid the Files section, but upload, browse
  and download still returned 200 (see "Hands-on results").
- **Audit:** `SELKIES_AUDIT_WEBHOOK_URL` if you need a record of who moved what.

## 7. Hands-on test plan (Phase 2, Playwright plus `docker exec`)

Setup: run the image with `-p 3000:3000` (also a second run with `-e PASSWORD=test -e CUSTOM_USER=abc`).
Test files: a small `cube.stl` (~1 MB) and a `big.stl` larger than 64 MiB (for example a padded or random
binary STL) to exercise chunking.

1. **Discover the UI.** `page.goto("http://localhost:3000/")`, wait for `#overlayInput` and the video
   or canvas. Open the sidebar with `page.keyboard.press("Control+Shift+M")` or click
   `[role=button][aria-label="Show toolbar"]`. Expand the section with
   `button.sidebar-section-header[title="Files"]`. Screenshot.
2. **Upload via the button.**
   `with page.expect_file_chooser() as fc: page.click('button[title="Upload Files"]')`, then
   `fc.value.set_files("cube.stl")`. Alternatively,
   `page.set_input_files("#globalFileInput", "cube.stl")`. Wait for the toast text
   `Successfully uploaded cube.stl`. Check with `docker exec <c> ls -la /config/Desktop` and
   `sha256sum`. Check owner `abc` and no `.selkies-upload-*.part` left behind.
3. **Chunked upload:** repeat with `big.stl`. Watch the network for multiple `POST api/upload` with
   `X-Upload-Offset`. Compare checksums.
4. **Drag and drop:** build a `DataTransfer` in the page
   (`page.evaluate_handle` holding a `new File([...], "drop.stl")`) and `dispatch_event("drop", {dataTransfer})`
   on `#overlayInput`. Expect this to be unreliable: the handler uses `items[i].webkitGetAsEntry()`,
   which may return `null` for synthetic transfers. Record the result; a manual drag test may be needed.
5. **Upload into a subfolder:** open "Download Files", click `button[aria-label="New Folder"]`, create
   `models`, go into it, then `[aria-label="Upload"]` plus the file chooser. Check
   `/config/Desktop/models/`.
6. **Open in the app:** focus the stream, send `Control+i` (Import). In the GTK dialog press `Control+L`,
   type `/config/Desktop/cube.stl`, press Enter. Screenshot the plate. Record which folder the dialog
   opened in by default, and whether a "Desktop" entry or bookmark shows in its sidebar. Retry after
   seeding `~/.config/gtk-3.0/bookmarks` and `recent.last_opened_folder`.
7. **Export and download:** slice, then export G-code/3MF to `/config/Desktop` (keyboard-driven
   dialog as above). In the Files dialog, find the row by text and click its
   `button[aria-label="Download"]` inside `with page.expect_download() as dl:`. Then
   `dl.value.save_as(...)` and compare sha256 with `docker exec sha256sum`. Also download a folder and
   check that it arrives as a `.zip`.
8. **API-level checks with curl from the host:**
   - `curl -X POST --data-binary @cube.stl -H 'Content-Type: application/octet-stream' -H 'X-Upload-Path: api-test.stl' http://localhost:3000/api/upload` returns `{"status":"success"}`.
   - `curl 'http://localhost:3000/api/file-manager/browse?path='` returns JSON entries.
   - `curl -OJ http://localhost:3000/api/files/api-test.stl`.
   - Traversal: `X-Upload-Path: ../../etc/evil` returns 400 "invalid upload path";
     `curl --path-as-is http://localhost:3000/api/files/../../etc/passwd` and `%2e%2e%2f` variants return 403/404;
     `docker exec <c> ln -s /etc /config/Desktop/etc` then `GET /api/files/etc/passwd` returns 403.
   - Bind mount: `-v $PWD/nas:/config/Desktop/nas`, then upload and download inside `nas/` work.
9. **Env var matrix:** `SELKIES_FILE_TRANSFERS=none` returns 403 on upload and download, and the Files
   section is hidden. `SELKIES_FILE_TRANSFERS=upload`: upload OK, browse/download 403.
   `HARDEN_DESKTOP=true` with and without explicit `SELKIES_FILE_TRANSFERS=upload,download`.
   `FILE_MANAGER_PATH=/models`: uploads land there. `PASSWORD=test`: requests without credentials get
   401, and Playwright `http_credentials={"username":"abc","password":"test"}` works.
10. **Clipboard:** grant `clipboard-read`/`clipboard-write`, write text in the page, paste in the app (for
    example the printer IP field), and the reverse. Confirm that copying a file gives nothing useful.
11. **Watcher prototype (optional):** run `inotifywait -m -e moved_to /config/Desktop` plus
    `CrealityPrint --single-instance <file>` as a test service. Upload through the UI and check that the
    model shows up in the running instance.

## Hands-on results

Run on **2026-11-21** against `crp-research:baseline`: Creality Print V7.3.1 on
`ghcr.io/linuxserver/baseimage-selkies:debiantrixie` (build `f7632021-ls153`, 2026-11-21), Wayland mode,
Selkies **2.2.1** (`pip show selkies` in the container). The app ran as `abc` (PUID/PGID 1000) with
`HOME=/config`, from a copy of a `/config` where the first-run wizard was already done. The browser was
headless Chromium 131 (Playwright 1.49 in `mcr.microsoft.com/playwright:v1.49.0-noble`) at 1600×900 on
host port 3400. The app was driven through the stream with mouse and keyboard; the Selkies UI was driven
through DOM selectors. Scripts and screenshots (scratch, not in the repo):
`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-H/{scripts,shots}`
(`act.js` is the action runner, `probe.sh` the API probe, `variant.sh` the env-var matrix,
`image-watcher/` the watcher prototype).

### R1. Upload through the sidebar: works

- Open the handle at x=7/y=450, expand `button.sidebar-section-header[title="Files"]`, then
  `button[title="Upload Files"]`. This opens the browser's native file picker (Playwright `filechooser`
  event, `multiple=true`). `setFiles(cube.stl)` gave the toast "Successfully uploaded cube.stl" after
  about 0.04 s.
- The request was one `POST /api/upload` with `X-Upload-Path: cube.stl`.
- The file landed in **`/config/Desktop/cube.stl`**, owned by `abc:abc`, mode 644. The sha256 matched the
  source (`e32906e0…74a67b1`). No `.part` files were left behind.

### R2. Import into Creality Print: works; the first default folder is the app's log folder

- With focus on the stream, **Ctrl+I** opens the GTK3 chooser "Choose one or more files
  (3mf/step/stl/svg/obj/amf)". Its sidebar shows *Recent, Home, Desktop, log, Other Locations*. With no
  bookmarks file, GTK already lists "Desktop".
- **The default folder on a fresh config is `/config/.config/Creality/Creality Print/7.3/log`.** The app
  sets its working directory to its log folder (`/proc/<pid>/cwd`), and GTK starts there when the app
  has no remembered folder. That is also why "log" shows up in the sidebar.
- **Ctrl+L**, typing `/config/Desktop/cube.stl`, and **Enter** loaded the cube (20×20×20 mm, 12
  triangles). The window title became "cube".
- After that import, `Creality.conf` contained `"recent": {"last_opened_folder": "/config/Desktop"}`.
  The next Ctrl+I opened `/config/Desktop` directly, listing the uploaded files.
- **Seeding works.** A fresh copy of `/config` with `recent.last_opened_folder` and
  `app.last_export_path` set to `/config/Desktop` before the app started: the first Ctrl+I opened
  `/config/Desktop`, and the app kept the values at startup.
- The GTK chooser **does follow symlinks** inside `/config/Desktop`. The Selkies API refuses them (R6).

### R3. Slice, export, download: works (G-code and 3MF)

- "Slice plate", then the arrow next to "Send print", gives a menu with *Send print / Send to
  Multi-device / Export G-code / Export all sliced file / Upload to CrealityCloud*. **Export G-code**
  opens "Save Sliced file as:" **already in `/config/Desktop`** (the last import/export folder), with the
  name `cube_PLA_12m35s.gcode`. Enter saved the file (314,487 bytes).
- Sidebar, then "Download Files", opens the "Files" dialog (2 items, with the Download icon button on
  each row). `page.waitForEvent('download')` captured `GET /api/files/cube_PLA_12m35s.gcode`, suggested
  filename `cube_PLA_12m35s.gcode`. The **sha256 matched** (`270a7922…f506036`).
- Response headers: `Content-Disposition: attachment; filename=…`,
  `Content-Type: application/octet-stream`, `Accept-Ranges: bytes`. A `Range: bytes=0-99` request
  gave `206 Partial Content`, so downloads can be resumed.
- **Save project (Ctrl+S, 3MF) did *not* open `/config/Desktop`.** It opened the log folder (the app's
  working directory), even when `last_opened_folder` was set. Typing a full path into the name field
  (`/config/Desktop/cube.3mf`) works. The 3MF downloaded with a matching sha256 (`84b6f518…455773b7`).
  The user has to navigate to Desktop for the first project save. This is a usability gap; see the
  recommendations.
- Folder download: `GET /api/file-manager/zip?path=sub` returned a valid zip. Zipping the root returned
  404, and a request with `Sec-Fetch-Site: cross-site` returned 403 "Forbidden origin".

### R4. Drag and drop: cannot be automated headless (code path confirmed, needs a manual check)

A synthetic `DataTransfer` holding a `File` was dispatched as `dragover` and `drop` on `#overlayInput`.
The handler ran, but `items[0].webkitGetAsEntry()` returns `null` for synthetic transfers, so nothing
was uploaded and no error was shown. This is exactly the path in `lib/file-upload.js`: it only falls
back to `dataTransfer.files` when `items` is missing. A real drag from the OS gives real entries.
**Check by hand in a desktop browser.** The expected result (from code) is that the file lands in the
root of `FILE_MANAGER_PATH`, and the R7 watcher then opens it.

### R5. Large upload chunking: works

A 150 MiB (157,286,400 B) file went up as **3 POSTs** with the same `X-Upload-Id`, offsets
0 / 67108864 / 134217728, `X-Upload-Total: 157286400`, and `X-Upload-Final: 1` on the last. It took about
2.3 s over localhost. The sha256 matched (`4f846df9…dc2b1663`), and no staging file was left.

### R6. Env vars, auth, traversal, symlinks

API probe (`probe.sh`: upload, browse, download) plus a check of the sidebar's Files section:

| Variant | Page | Upload | Browse | Download | Files section in sidebar |
| --- | --- | --- | --- | --- | --- |
| defaults | 200 | 200 | 200 | 200 | Upload + Download |
| `SELKIES_FILE_TRANSFERS=none` | 200 | **403** | **403** | **403** | hidden |
| `SELKIES_FILE_TRANSFERS=upload` | 200 | 200 | 403 | 403 | Upload only |
| `HARDEN_DESKTOP=true` | 200 | **200** | **200** | **200** | hidden |
| `HARDEN_DESKTOP=true` + `SELKIES_FILE_TRANSFERS=upload,download` | 200 | 200 | 200 | 200 | hidden (`SHOW_FILES=false` still applied) |
| `SELKIES_UI_SIDEBAR_SHOW_FILES=false` | 200 | 200 | 200 | 200 | hidden |
| `PASSWORD=test CUSTOM_USER=abc` (no credentials or wrong password) | 401 | 401 | 401 | 401 | n/a |
| same, with `-u abc:test` | 200 | 200 | 200 | 200 | Upload + Download |

- **Bug found: `HARDEN_DESKTOP=true` does not turn file transfer off** on `baseimage-selkies:debiantrixie`
  ls153. `init-selkies-config` writes an *empty* `/run/s6/container_environment/SELKIES_FILE_TRANSFERS`
  (0 bytes, verified). s6's envdir rule treats an empty file as "unset the variable". The `selkies`
  process environment had no `SELKIES_FILE_TRANSFERS` at all (checked in `/proc/<pid>/environ`), so
  Selkies used the default `upload,download`. Hardened deployments must set
  `SELKIES_FILE_TRANSFERS=none` themselves. Worth reporting upstream: the fix is to write `none`
  instead of `""`.
- **`FILE_MANAGER_PATH=/models` with `-v host:/models`**: uploads and the browse listing use `/models`.
  The file sits on the host owned by the PUID user. `/config/Desktop` is still created but no longer
  used by the web UI.
- **Bind mounts nested under the root** (`-v host:/config/Desktop/nas`, `-v host2:/config/Desktop/library:ro`):
  upload into `nas/` 200; browse, download and zip of `library/` 200; upload into `library/` 400
  `"[Errno 30] Read-only file system: '.selkies-upload-….part'"`. The fd-verification walk accepts bind
  mounts.
- **Traversal:**
  - `X-Upload-Path: ../../etc/evil` gives 400 "invalid upload path".
  - `X-Upload-Path: /etc/evil2` gives 200, but it lands at **`/config/Desktop/etc/evil2`** (the leading
    slash is stripped, so it is contained). `/etc` was not touched.
  - `browse?path=..` gives 400.
  - `curl --path-as-is` `/api/files/../../etc/passwd`, `%2e%2e/%2e%2e/…` and `..%2f..%2f…` give nginx
    404 (nginx normalises the path before proxying).
- **Symlinks** created inside `/config/Desktop` (`etclink -> /etc`, `cfglink -> /config/.config`):
  - `GET /api/files/etclink/passwd` and `…/cfglink/…/Creality.conf` give **403 "Directory Traversal
    detected"**.
  - `browse?path=etclink` gives 400.
  - An upload into `etclink/` gives 400 "path escape rejected".
  - The browse listing does show such links as entries.

### R7. Upload watcher prototype (`crp-research:ft-watcher`): works

> **Correction (2026-11-21, later the same day):** this prototype is broken. A word-splitting bug on the space in "Creality Print" meant `single_instance` was never set. Each upload started a **second app instance** whose window covered the first, so "replaces the plate" below is a misreading. With correct forwarding, STLs are *added* to the current plate and unsaved work survives. Use the `ft-watcher2` design in [12 §1](12-remaining-hands-on.md). Likewise, R4's "cannot be automated" was overturned there (§3, CDP `Input.dispatchDragEvent`).

- The image is baseline plus `inotify-tools`, plus an s6 longrun `svc-upload-watcher` (depends on
  `svc-de`, runs as `abc`) that runs `/usr/local/bin/crp-upload-watcher`.
  - It watches `FILE_MANAGER_PATH` (default `~/Desktop`) for `moved_from` and `moved_to`.
  - A `moved_to` of `*.stl|3mf|obj|step|stp|amf|ply|oltp` that directly follows a `moved_from` of
    `.selkies-upload-*` counts as a finished web upload.
  - It then sets `"app.single_instance": true` in `Creality.conf` (with `jq`) and runs
    `DISPLAY=:0 GDK_BACKEND=x11 /opt/crealityprint/AppRun <file>`.
  - Source: `scratchpad/agent-H/image-watcher/`.
- Prerequisite checks:
  - `AppRun --single-instance <file>` fails with exit 1: "Invalid option --single-instance / GUI
    parameter parsing failed".
  - With `single_instance` set in the config, `AppRun <file>` logs "Instance check: Another instance
    found. This instance will terminate" and the running window loads the file. The session D-Bus is
    found through X11 autolaunch on `:0`. The running app has no `DBUS_SESSION_BUS_ADDRESS`; `abc`'s
    `dbus-launch --autolaunch` provides the bus.
- Result: uploading `watch-cube.stl` through "Upload Files" made the model appear on the plate in about
  1 s. The window title changed to "watch-cube".
- **Behaviour to know (WRONG, see the correction above and [12 §1](12-remaining-hands-on.md); the second instance's window covered the first):** each forwarded file **replaces** the current plate. It opens like a new
  project; after uploading `second.stl` and then `big-cube60.stl`, the object list held only
  `big-cube60.stl`. No "save changes?" prompt was seen, but these test projects had no unsaved edits.
  Check that before shipping, so a user doesn't lose work.
- **No false triggers:** saving a project 3MF from the app into `/config/Desktop` did not trigger the
  watcher, because the app does not write through a `.selkies-upload-*` rename.

### R8. Not tested

- Clipboard (text and images). Since tested: see [12 §2](12-remaining-hands-on.md).
- A third-party reverse proxy with a small `client_max_body_size`. Expected from code: a 413 on any
  slice above the limit.
- A real OS drag and drop (R4).
- `SUBFOLDER`.

### Phase 2 recommendations for our image

1. **Keep the default landing folder `/config/Desktop`.** Do **not** set `FILE_MANAGER_PATH=/config`.
   Document `-v <nas>:/config/Desktop/<name>` (or `FILE_MANAGER_PATH` plus a mount) for library and
   output folders on the NAS.
2. **Seed `Creality.conf` on first run:** set `recent.last_opened_folder` and `app.last_export_path` to
   `/config/Desktop`, but only when the keys are missing. Import and G-code export then start in the
   upload folder. Project save (3MF) still starts in the log folder; document "type `/config/Desktop/…`
   or click *Desktop*". A GTK bookmarks file is not needed.
3. **Ship the upload watcher as an opt-in** (for example `AUTO_OPEN_UPLOADS=true`). It turns "Upload Files"
   and drag-and-drop into "model appears in Creality Print". **Use the `ft-watcher2` design from
   [12 §1.5](12-remaining-hands-on.md)**, not R7's prototype. With it, STLs are added to the current plate,
   unsaved work is kept, and 3MFs get the app's own "save changes?" prompt (verified).
4. **Hardening docs:** state that `SELKIES_FILE_TRANSFERS=none` (not `HARDEN_DESKTOP`) is what turns
   transfer off, and that a `PASSWORD` or a fronting auth proxy is needed, because without one the file
   API is open to anyone who can reach the port.
