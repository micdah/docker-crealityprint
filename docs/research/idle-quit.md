# Close when idle (IDLE_QUIT)

How the opt-in "close when idle" feature works: the Selkies hooks it uses, the daemon that closes and starts the app, what happens to unsaved work, and what it saves. Users' view: the "Close when idle" section of [../../README.md](../../README.md). Research index: [README.md](README.md).

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.

Verified against: this image with Creality Print 7.3, selkies 2.2.1, s6-overlay 3.2.1.0; Docker 29 on Arch Linux (kernel 7.3.5), Intel UHD 630 host.

## Summary

- With `IDLE_QUIT=true`, the image closes Creality Print (SIGTERM to the app and its WebKit helpers) once no browser has been connected for `IDLE_QUIT_AFTER` seconds (default 1800). It starts the app again when a browser connects, but only if the timer closed it.
- It is built on Selkies' presence hooks. A daemon owns the timer and blocks on a FIFO, so it adds no polling.
- Closed, the container drops from about 1.5 % to under 0.1 % of a core and from about 50 to 8 wakeups a second (with the image's Selkies patch), and frees about 1.2 GiB of memory [V]. Selkies, Xwayland, labwc and the session bus keep running.
- There is no save prompt. The app's own project backup survives, and the next start offers to restore it [V]. Printer connections, including the K1 camera, start fresh.
- Costs: a cold start on return, an empty plate unless you restore, a running slice or G-code send is cut off, and file-API uploads made while it is closed aren't auto-opened.
- Off by default. When off, nothing is installed and the service only runs `sleep infinity`.
- It stays off next to the base image's app restarter (`RESTART_APP`, also turned on by `HARDEN_OPENBOX`), which would undo every idle close [V].

## Goal

- Close the app while nobody is connected, and bring it back on the next connection.
- Never block on a save prompt, and keep unsaved work recoverable.
- Add no periodic wakeups of our own.
- Change nothing for users who don't turn it on.
- Why the app is closed rather than frozen, and why the base's `RESTART_APP` isn't used: see [decisions.md](decisions.md).

## What the design needs from the Selkies hooks

Details of the hooks are in [base-image.md](base-image.md). The design relies on these facts [V, source]:

- `SELKIES_RUN_AFTER_CONNECT` runs when the first client connects. `SELKIES_RUN_AFTER_DISCONNECT` runs when the last client leaves. Both are empty (off) by default.
- Each hook runs as its own task, through `sh -c`. Two hooks can run at once, and the later event's hook can finish first.
- Selkies kills a hook after 300 s.
- A hook runs as `abc` with Selkies' environment, where `DISPLAY=:1`. The app runs on Xwayland `:0`.

So a hook must be quick, must never block, and must not start the app: it would get the wrong display, live in Selkies' process tree and be killed after 300 s. The daemon starts the app instead.

What remains when the app is closed is Selkies; its own idle cost is in [base-image.md](base-image.md).

## Pieces

| Piece | Kind | Job |
|---|---|---|
| `init-crealityprint-idle` | s6 oneshot, as root, after `init-config` and before the services | Clears the previous start's state; when on, creates the runtime folder and writes the two hooks into `/run/s6/container_environment/` |
| `crealityprint-idle` | script in `/usr/local/bin` | `connect` and `disconnect` (the hooks), `is-quit` (for the upload watcher), `daemon` (timer, closing, starting) |
| `svc-crealityprint-idle` | s6 longrun, after `svc-de` | Runs `crealityprint-idle daemon` as `abc`, or `sleep infinity` when there is no FIFO |
| `/run/crealityprint-idle/clients` | state file | `present` or `absent`, plus the spawn order of the hook that wrote it |
| `/run/crealityprint-idle/events` | FIFO | Wakes the daemon when the state changes |
| `/run/crealityprint-idle/quit-for-idle` | marker | Exists from the moment the daemon starts closing the app until a browser brings it back |

The runtime folder is owned by `abc`, mode 0700. Every log line starts with `[crealityprint-idle]`.

## Turning it on

- `IDLE_QUIT` defaults to `false`. Only `true`, in any case, turns it on.
- `IDLE_QUIT_AFTER` is in seconds, default 1800: time to come back and save, and for a slow G-code upload to finish. A value that isn't a positive integer logs a warning, and 1800 is used. Leading zeros are read as decimal.
- If the user already set `SELKIES_RUN_AFTER_CONNECT` or `SELKIES_RUN_AFTER_DISCONNECT` to anything else, init logs a line and the feature stays off. It never overwrites a user's hook.
- If an app restarter is on (`RESTART_APP`, `SELKIES_APP_RESTART` or `EXIT_ON_APP_CLOSE` is `true`; see below), init logs why and the feature stays off.
- On every start, init first deletes the previous start's runtime folder. `/run` isn't a tmpfs in Docker, so it survives a `docker restart`, and a leftover quit marker would make the watcher skip uploads [V: s6-overlay's `preinit` only mounts a tmpfs on `/run` when `/run` isn't writable, and Docker's `/run` is the writable container layer]. The hooks need no cleanup: s6 rebuilds `/run/s6/container_environment` from the container's environment on every start [V].
- When on, init creates the FIFO, writes `absent` to the state file (nobody is connected at boot), and installs the hooks.

## The hooks

- `connect` writes `present` to the state file, `disconnect` writes `absent`. Then each notifies the daemon. Neither starts or stops anything.
- Notify means writing one line to the FIFO under `timeout 5`. The daemon holds the FIFO open read-write, so the write doesn't block while the daemon runs, and the timeout covers a daemon that isn't reading. With no FIFO, the hook skips the notify.
- **Ordering.** Each state is stored with the hook's spawn order: the start time (`/proc/<pid>/stat` field 22) and PID of the process Selkies forked, zero-padded so they sort as text. That process is the hook's parent `sh` [V: dash 0.5.12 in the image forks the command of `sh -c` instead of exec-ing it]. A hook writes only if no later event has written already.
- The check and the write run under `flock` (on `clients.lock`, 5 s timeout). The write goes through a temp file and a rename, so the daemon, which reads without the lock, never sees half a state.
- Tested with out-of-order hooks: a `disconnect` spawned first but finishing last leaves `present`, and a `connect` spawned first but finishing last leaves `absent` [V].
- A missing or unreadable state file counts as connected: when in doubt, don't close the app.
- `is-quit` exits 0 while the marker exists. The upload watcher uses it.

## The daemon

### The timer

- It runs while nobody is connected and the app isn't closed by the timer. It blocks on `read -t <IDLE_QUIT_AFTER>` on the FIFO. Any event restarts the wait. Nobody is connected at boot, so the timer runs from the start.
- With a browser connected, or with the app closed by the timer, it blocks on a plain `read` until the next hook. The only wakeup of its own is one per idle period.
- On a timeout it re-reads the state file. If it still says `absent`:
  - No app process (still starting, or closed by the user): nothing to do, and the timer starts over.
  - The app is younger than the required age: it logs "has only run for Ns; closing it in Ms" and waits out the rest.
  - Otherwise it closes the app.
- **Required age = max(`IDLE_QUIT_AFTER`, 60 s)**, from the app's start time. So an app started while the timer was already running (by the upload watcher or from the menu) gets its full idle time, and a starting app is never closed.
- Why the 60 s floor: with a 5 s idle time and no floor, closing the app about 3.5 s into its very first start on a fresh `/config` left a config that the next start reported as "Detected corruption in the Creality Print configuration file, attempted to rebuild, please manually restart the software." [V]. Closing at 1, 2 or 4 s into a first start didn't reproduce it, and closing a later start at 0.5 to 3 s was always harmless [V]. The first start does one-off work (data-directory migration, about 2,000 system preset files, the first `Creality.conf` rewrite), and a close in the middle of it is the likely cause [I]. With the default 1800 s the floor never matters.

### Closing

- The app is the oldest `CrealityPrint` process of `abc`. The daemon collects it and every process below it (the WebKit helpers).
- It writes the marker first, then sends SIGTERM to the whole tree. It waits up to 10 s, checking every 0.1 s only during this shutdown. Then it sends SIGKILL to whatever is left and waits up to 5 s more.
- It returns once the tree is gone, or after logging that even SIGKILL failed. In that case the timer keeps running for that app, and nothing new is started next to it.
- In practice the app exits in about 50 ms [V].

### Starting again

- Before every wait (after each event or timeout, and when the daemon starts) the daemon checks: marker set and a browser connected? Then it removes the marker and starts the app, unless an app process already exists (started from the menu meanwhile).
- It starts the app as `DISPLAY=:0 setsid --fork /usr/local/bin/crealityprint` from `$HOME`, with output to `/dev/null` and its FIFO descriptor closed (`3<&-`):
  - `DISPLAY=:0` is where the app runs and where X11 autolaunch finds its session bus. `crealityprint-open` reaches the started app over D-Bus [V, e2e].
  - `setsid --fork` puts the app in its own session, re-parented to pid 1. s6 never signals it with the service, and pid 1 reaps it.
  - Bash doesn't mark the FIFO descriptor close-on-exec, and the app must not hold the daemon's channel open.
- The upload watcher starts the app the same detached way, with the uploaded file as an argument (see [files.md](files.md)).
- **A connect during closing.** The daemon is single-threaded and checks for a returning browser only after the old tree is gone. That matters: a new instance started while the old one still holds the app's D-Bus name can't take that name ("Not primary owner of DBus name", see [app.md](app.md)), so uploads could no longer reach it [I]. Tested by freezing the app tree (so SIGTERM couldn't end it) and connecting during the 10 s grace period: the daemon killed it, then started exactly one new instance [V].
- **A daemon restarted by s6** catches up on a connect it missed, because it checks when it starts. The marker and state file survive the restart.
- **A deliberate close stays closed.** Only an app closed by the timer comes back. If the user closes the app, reconnecting leaves the desktop empty; the desktop's right-click menu starts it [V, e2e].

## Not together with an app restarter

The base can restart the app when it exits, which undoes every idle close. Init therefore keeps `IDLE_QUIT` off, and logs `<SETTING> is on; IDLE_QUIT stays off, …`, when one of these is `true` [V]:

| Setting | Base | On app exit |
|---|---|---|
| `RESTART_APP` | Python Selkies (today) | `svc-watchdog` polls every second for the autostart shell and runs it again |
| `HARDEN_OPENBOX` | both | turns `RESTART_APP` on unless the user set it |
| `SELKIES_APP_RESTART` | Rust Selkies (see [selkies-rust.md](selkies-rust.md)) | the session restarts the app at once; `RESTART_APP` turns it on |
| `EXIT_ON_APP_CLOSE` | Rust Selkies | the container stops |

- Init runs after the base's `init-selkies-config`, so it checks the value the base acts on, including a `RESTART_APP` that `HARDEN_OPENBOX` set. With `HARDEN_OPENBOX=true` the log adds: set `RESTART_APP=false` to use `IDLE_QUIT`.
- A `|locked` suffix is ignored when reading the settings; the base doesn't strip it, so `RESTART_APP=true|locked` is a harmless false alarm.
- Without the guard, the watchdog started the app again 0.3 s after an idle close. The daemon had already seen the app gone and waited for a browser with the quit marker set, so the new app ran with nobody connected for good, and the watcher skipped every file-API upload [V].

## What is closed

| Process | Closed? | Why |
|---|---|---|
| `CrealityPrint` | yes | Most of the idle CPU and memory |
| its descendants (`WebKitWebProcess`, the WebKit network process) | yes | The rest of it. They also exit on their own when the app does [V] |
| the labwc autostart shell | ends by itself | It only waits for the app |
| `selkies` | no | Accepts the next connection and runs the connect hook |
| `Xwayland`, `labwc` | no | Selkies streams the desktop they draw |
| session bus (`dbus-launch`) | no | Cheap, and the new instance registers on it again |

## The upload watcher

How the watcher works is in [files.md](files.md). With `AUTO_OPEN_UPLOADS=true`:

- Before handing a finished upload to the app, the watcher runs `crealityprint-idle is-quit`. While the marker exists, it logs that it skipped the file and leaves the app closed. Otherwise its fallback would start the app for a file nobody is looking at, and the timer would close it again.
- This only affects uploads through the Selkies file API with no browser connected (e.g. `curl`). The file stays in the upload folder, to import after reconnecting.
- Uploads from the browser sidebar or by drag-and-drop always have a client connected, so they are opened as usual.
- If the user closed the app, the marker isn't set, and the watcher starts the app with the file. With no browser connected, the timer closes it again once it has run for `IDLE_QUIT_AFTER`, and the backup offers the plate back.

## What closing does to the app

Tested in containers from this image, with the K1C preset and an unsaved `cube.stl` on the plate [V]:

| Question | Result |
|---|---|
| Does SIGTERM prompt to save? | No. The app exits in about 50 ms; the helpers and the autostart shell are gone within a second |
| Settings (`Creality.conf`) | Not at risk: the app rewrites it on every change, not only at exit (see [persistence.md](persistence.md)). Closing risks nothing that `docker stop` doesn't |
| Unsaved project | The backup in `/tmp/crealityprint_model/<date>/<time>#<pid>#<id>` survives. The next start asks "Previously unsaved items have been detected. Do you want to restore them?"; Yes brought the cube back |
| Clean project at close | No prompt on the next start |
| Stale instance lock (`cache/<hash>.lock`) | Harmless; the next start runs normally |
| Cold start to the main window | About 1.6 s on a warm host (page cache warm), about 5 s in the e2e runs |
| Logs | One `debug_<date>_<pid>.log.0` per start. The app deletes old logs itself [V: string in the binary; I: retention] |

- The backup lives in `/tmp`, in the container layer. It is lost on a re-create, and after a `docker restart` the app often skips it because it gets the same PID as the app that wrote it. The idle timer's close and start happen inside a running container, where PIDs keep growing, so they are unaffected. See [persistence.md](persistence.md).
- **After choosing Yes, click once into the 3D view.** Until the first click, the restored app keeps redrawing at about 60 frames/s even with no browser connected: 11 cores without a GPU [V, twice; not tested with a GPU].
- **Work in progress stops:** a slice, a G-code upload to the printer (it may leave a partial file there), a cloud download or a firmware push. A print already running on the printer carries on. With the 1800 s default, "send, then close the tab" only breaks if the send takes longer than that [I].
- **Coming back** is a cold start: the desktop is empty for a few seconds, then the app opens with an empty plate or the restore prompt.

## Printer connections

Every return is a fresh start, so printer connections are set up from scratch (see [printers.md](printers.md)):

- Status reconnects by itself, as on any start [V].
- The K1 WebRTC camera works after an app restart: 137 KiB/s again, tested with a K1C [V]. Not re-measured through the daemon's start with a real printer [I: same binary and launcher].

## Measurements

A container from this image with its Selkies patch, no client connected, `CP_PRINTER=Creality K1C`, after the main window was up and a few minutes of settling; then the app tree closed with SIGTERM and a 30 s pause. CPU is the container cgroup's usage read from the host over 60 s windows; wakeups are voluntary plus nonvoluntary context switches per thread over about 75 s [V]:

| No client connected | App running | App closed |
|---|---|---|
| Container CPU (% of one core) | 1.5–1.6 % | 0.05–0.09 % (two runs) |
| Wakeups (context switches)/s | 50 | 8 |
| Memory (`memory.current`) | 1393 MiB | 157 MiB |

- Memory comes from an earlier run of the same states (second start of a `/config`, 60 s samples), before the patch, which doesn't change memory [V].
- Without the patch, the same two states used 2.1–2.3 % and 0.48 % of a core (see [base-image.md](base-image.md)).
- Per process with the app running (30 s sample, before the patch, % of one core) [V]: `CrealityPrint` 1.23, `WebKitWebProcess` (all) 0.63, `Xwayland` 0.07. The app and its helpers make up most of what closing saves.
- The absolute saving is small. The bigger cost of a running app is that it keeps waking the CPU, which keeps it out of its deep C-states [I].

## Why opt-in

- Closing interrupts whatever the app was doing, and returning costs a cold start.
- The saving is a few percent of one core. It matters for always-on, low-power home servers, not for everyone.
- So the default stays as it was, and the feature leaves no trace when off.

## Tests

- **`tests/e2e/idle.spec.js`** runs as its own CI matrix job. One container with `IDLE_QUIT=true`, `IDLE_QUIT_AFTER=5`, `AUTO_OPEN_UPLOADS=true` and `CP_PRINTER=Creality K1C`, and one test that checks in order:
  1. With no browser, the app is closed after the start-up guard ("has only run for" is logged first), and no app or WebKit process is left.
  2. A file-API upload while closed is skipped by the watcher, and no app starts.
  3. A connect starts exactly one app, the main window comes up, the skipped model isn't loaded, and `crealityprint-open` reaches the new instance.
  4. When the page leaves, the app is closed again, and the next connect starts it again.
  5. After the app is closed from outside (SIGTERM, while connected), leaving and reconnecting doesn't start it. The test waits for the state file to read `absent`, then `present`, so it knows the daemon saw both hooks.
- A second group boots two containers with `IDLE_QUIT=true` and `RESTART_APP=true` or `HARDEN_OPENBOX=true`. Each checks the guard's log line (the `HARDEN_OPENBOX` hint only in the second) and that nothing is installed.
- A third group gives a running container a fake quit marker and a `docker restart`. After the second start the marker is gone, the runtime dir holds a fresh state file and FIFO, the hooks are installed again, and init logged "on" twice with no warning.
- The spec takes about 2.4 minutes, mostly the two waits for the 60 s start-up guard.
- **`tests/e2e/watcher.spec.js`**: the default-settings test also checks that the feature is off by default: no `[crealityprint-idle]` log lines, no `SELKIES_RUN_AFTER_*` in `/run/s6/container_environment`, and no `/run/crealityprint-idle` (`AppContainer.idleFootprint()`).
- Checked by hand only: the user's-own-hooks path, out-of-order hooks, a connect during the grace period, the restore prompt, the start-up corruption window, the measurements and the camera.
