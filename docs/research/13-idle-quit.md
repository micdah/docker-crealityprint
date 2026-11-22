# 13 — Close when idle (opt-in)

Date: 2026-11-22 · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, Intel UHD 630

This doc covers the opt-in "close when idle" feature (`IDLE_QUIT=true`): why it exists, the Selkies hooks it builds on, the design, how it interacts with the upload watcher, what happens to unsaved work, the tests and the measurements.

Legend: **[V]** = verified by running it or reading the source, **[I]** = inferred.

## Summary

- With no browser connected, the container still uses about **2.3–2.7 % of one core** and over **1 GiB of memory**, and the app keeps waking the CPU [V, §1, §6].
- With `IDLE_QUIT=true`, the image **closes Creality Print (SIGTERM to the app and its WebKit helpers)** once no client has been connected for `IDLE_QUIT_AFTER` seconds (default 1800, 30 minutes). **It starts the app again when a client connects**, but only if the idle timer was what closed it.
- Selkies, Xwayland, labwc and the session bus keep running, so the next connection works as usual.
- It is built on Selkies' own presence hooks, `SELKIES_RUN_AFTER_CONNECT` and `SELKIES_RUN_AFTER_DISCONNECT` [V, §2]. No polling: the daemon blocks on a FIFO with a read timeout.
- **Off by default.** When off, nothing is installed: no hooks, and the service just runs `sleep infinity`.
- **Unsaved work is offered back.** SIGTERM ends the app at once without a save prompt, but the app's own project backup survives, and the next start asks "Previously unsaved items have been detected. Do you want to restore them?" [V, §5].
- **Printer connections come back fully,** including the K1 WebRTC camera, because every return is a fresh start (§7).
- Costs: a short cold start on reconnect (about 2 s to the main window here), an empty plate unless you restore, a running slice or G-code send is cut off, and file-API uploads with no client connected aren't auto-opened (§4).
- Closed, the container drops from about **3.0 % to about 1.1 % of one core**, from about **114 to 70 context switches/s**, and from about **1.4 GiB to about 160 MiB** of memory (§6). What is left is Selkies itself (§8).

---

## 1. Question and goal

The server runs 24/7, but the app is used rarely, often with days or weeks between visits. Question: can the container use (almost) no CPU and little memory while nobody is connected?

Baseline, measured with no client connected (30 s sample, % of one core) [V]:

| Process | CPU |
|---|---|
| `CrealityPrint` | 1.23 % |
| `selkies` | 0.73 % |
| `WebKitWebProcess` (all) | 0.63 % |
| `Xwayland` | 0.07 % |
| **Total** | **2.67 %** |

The absolute numbers are small. The bigger cost is that the app and its WebKit helpers keep waking the CPU, which keeps it out of its deep C-states [I]. The app and its helpers account for about 1.9 % of the 2.67 %.

Goal:
- Close the app while nobody is connected, and bring it back on the next connection.
- Never block on a save prompt, and keep unsaved work recoverable.
- Add no new periodic wakeups of our own.
- Change nothing for users who don't turn it on.

### 1.1 Why close, not freeze

The first version of this feature (never merged) froze the app tree with SIGSTOP and resumed it with SIGCONT. It saved the same CPU and kept unsaved work in memory, but:
- **The K1 WebRTC camera never came back after a freeze.** Any freeze longer than a few seconds ended the camera session, and the app's page didn't set it up again until the app restarted. Refreshing, reopening Details and waiting 4+ minutes didn't help; a restart did [V, 2026-11-22: 136 KiB/s before, about 3 KiB/s after any 20 s+ freeze, 137 KiB/s after a restart].
- A frozen app keeps all its memory (about 1.2 GiB, §6).
- Closing loses no settings (§5), and unsaved work is offered back on the next start (§5).

So closing wins: same CPU saving, memory freed, and every return is a clean start. The price is a short cold start instead of an instant resume.

## 2. The Selkies presence hooks

The Selkies base image already reports when the first client connects and when the last one leaves [V, read in the installed package `selkies/` under `/lsiopy/lib/python3.13/site-packages/`]:

- `settings.py` L686 and L692 define two string settings, `run_after_connect` and `run_after_disconnect` (env `SELKIES_RUN_AFTER_CONNECT` / `SELKIES_RUN_AFTER_DISCONNECT`, default empty = off).
  - Connect: "run after the first client has connected; runs again each time a client connects while no others are connected."
  - Disconnect: "run after the last client has disconnected, including on server shutdown while clients are connected."
- `stream_server.py` L1919, `set_clients_present(present)`, is called by both streaming modes (`websockets_mode.py` L5162, `webrtc_mode.py` L678). It only acts on a change (0 → 1 or 1 → 0 clients) and then starts the matching command as an asyncio task.
- `_run_client_hook()` runs the command with `asyncio.create_subprocess_shell()`. It waits **at most 300 s**, then kills the command and logs a warning. A non-zero exit status is logged as a warning.
- The command runs in the Selkies process's context: as user `abc`, with Selkies' environment (`DISPLAY=:1`, the X11-mode default, while the app runs on Xwayland `:0`) [V: container env].
- The hooks are not serialized: each one is its own task, so a fast disconnect/connect can have two hook commands running at once, and the later event's hook can finish first [V: source]. §3.3 shows how the hooks are ordered.

Consequences for the design:
- The hooks are the only reliable "someone is here" signal. Selkies itself must stay awake to deliver it.
- A hook must be quick and must never block.
- **A hook must not start the app.** It would run with the wrong display, inside Selkies' process tree, and be killed after 300 s. The daemon starts the app instead (§3.4).

## 3. Design

### 3.1 Pieces

| Piece | Kind | Job |
|---|---|---|
| `init-crealityprint-idle` | s6 oneshot (init) | When `IDLE_QUIT=true`: writes the two hooks into `/run/s6/container_environment/` so Selkies picks them up. Otherwise does nothing. |
| `crealityprint-idle` | script in `/usr/local/bin` | `connect` and `disconnect` (the hooks), `is-quit` (for the upload watcher), `daemon` (the timer, closing and starting the app). One script, so it all lives in one place. |
| `svc-crealityprint-idle` | s6 longrun | Runs `crealityprint-idle daemon` as `abc`. Runs `sleep infinity` when the init step didn't create the FIFO (feature off, or the user's own hooks are set). |
| `/run/crealityprint-idle/clients` | state file | `present` or `absent`, plus the spawn order of the hook that wrote it (§3.3) |
| `/run/crealityprint-idle/events` | FIFO | Wakes the daemon when the state changes |
| `/run/crealityprint-idle/quit-for-idle` | marker | Exists while the app is closed because of the idle timer, until a browser brings it back |

### 3.2 Turning it on

- `IDLE_QUIT` defaults to `false`. Only `true` (any case) turns it on.
- `IDLE_QUIT_AFTER` is in seconds, default `1800` (30 minutes): enough to come back and save, and for a slow G-code upload to the printer to finish. A value that isn't a positive integer logs a warning and 1800 is used.
- If the user already set `SELKIES_RUN_AFTER_CONNECT` or `SELKIES_RUN_AFTER_DISCONNECT`, the init step logs a warning and leaves the feature off. It never overwrites a user's hook.
- When off, nothing is installed, so the feature leaves no footprint.
- The init step clears the previous start's runtime folder and its own hooks first. `/run` isn't a tmpfs in Docker, so after a restart with `IDLE_QUIT` turned off, nothing from the earlier run is left.
- When on, it creates `/run/crealityprint-idle/` (owned by `abc`) with the FIFO and the state file set to `absent`, then installs the hooks.

### 3.3 The hooks: `crealityprint-idle connect|disconnect`

- `connect` writes `present` to the state file, then notifies the daemon. `disconnect` writes `absent`, then notifies the daemon. Neither starts or stops anything.
- "Notify" = write one line to the FIFO under `timeout 5`. The daemon keeps the FIFO open read-write, so the write doesn't block while the daemon runs. The timeout keeps a hook from hanging if the daemon isn't reading. If the FIFO doesn't exist, the hook skips the notify.
- **Ordering.** Each state is stored with the hook's spawn order: the start time (`/proc/<pid>/stat` field 22) and PID of the process Selkies forked. That is the hook's parent `sh`, because dash doesn't `exec` a `sh -c` command [V]. A hook only writes if no later event has written already. The check and write run under `flock`, and the write goes through a temp file and rename, so the daemon (which reads without the lock) never sees half a state. Verified in a container with out-of-order hooks: a `disconnect` spawned first but finishing last leaves `present`, and a `connect` spawned first but finishing last leaves `absent` [V].
- A missing or unreadable state file counts as "connected": when in doubt, don't close the app.
- `is-quit` exits 0 while the marker exists, so from the moment the daemon starts closing the app until a browser brings it back. The upload watcher uses it, so an upload during the shutdown neither goes to the dying app nor starts a new one.

### 3.4 The daemon

- It runs as `abc` (`s6-setuidgid abc`).
- **The timer** runs while nobody is connected and the app isn't closed by us (no marker, or a marker next to an app that survived SIGKILL). It blocks on `read -t <IDLE_QUIT_AFTER>` on the FIFO; an event (connect or disconnect) restarts the wait. Nobody is connected at boot, so the timer runs from the start.
- With the marker set, or with a browser connected, it blocks on a plain `read` with no timeout until the next hook. There is no polling, so it adds no wakeups of its own beyond one per idle period.
- **On timeout** it re-reads the state file. If it is `absent`:
  - no app process (still starting, or closed by the user): nothing to do, the timer starts over;
  - the app has run for less than `IDLE_QUIT_AFTER`, and never less than **60 s**: it waits out the rest and checks again ("has only run for Ns; closing it in Ms"). This gives an app started while the timer was already running (by the upload watcher, or from the menu) its full idle time, and protects a starting app (§5.3);
  - otherwise it closes the app (below).
- **Closing** writes the marker first, then sends SIGTERM to `CrealityPrint` and every process below it (the WebKit helpers). It waits up to 10 s for all of them to exit (checking every 0.1 s, only during this shutdown), sends SIGKILL to whatever is left, and waits up to 5 s more. It returns once the tree is gone, or after logging that even SIGKILL failed (the timer then keeps running for that app, and nothing new is started next to it). In practice the app exits in about 50 ms [V, §5].
- **Starting again.** Before every wait (so after every event or timeout, and when the daemon starts) the daemon checks: marker set and a browser connected? Then it removes the marker and starts the app with `DISPLAY=:0 setsid --fork /usr/local/bin/crealityprint` from `$HOME`. Checking when it starts means a daemon restarted by s6 catches up on a connect it missed while no one read the FIFO.
  - `DISPLAY=:0` is where the app runs and where its session bus is found (X11 autolaunch), the same as the upload watcher's fallback launch ([12](12-remaining-hands-on.md), test F). `crealityprint-open` reaches the started app over D-Bus [V, §5, e2e].
  - `setsid --fork` puts the app in its own session, re-parented to pid 1: s6 never signals it with the service, and pid 1 reaps it.
  - The daemon's FIFO descriptor is closed for the app (`3<&-`); bash doesn't mark it close-on-exec, and the app must not hold the daemon's private channel open.
  - If an app process already exists (started meanwhile from the desktop menu), it only removes the marker.
- **Connect during closing.** The daemon is single-threaded and only checks for a returning browser after the old tree is gone. A connect that arrives while the app is exiting is acted on right after, and never meets the old instance. That matters: every instance registers `…InstanceCheck.Object<hash>` on the session bus, and a new one that finds a dying one hands it its arguments and exits. Verified by freezing the app tree (so SIGTERM couldn't end it) and connecting during the 10 s grace period: the daemon killed it, then started exactly one new instance [V].
- **A deliberate close stays closed.** Only an app closed by the timer (the marker) is started again. If you close the app yourself, reconnecting leaves the desktop empty; start it from the desktop's right-click menu [V, e2e].
- Every step is logged on lines starting with `[crealityprint-idle]`.

### 3.5 What is closed, and why the process tree

| Process | Closed? | Why |
|---|---|---|
| `CrealityPrint` | yes | Most of the idle CPU and memory |
| its descendants (the WebKit helpers, e.g. `WebKitWebProcess`) | yes | The rest of the app's idle CPU and memory; they also exit on their own when the app does [V] |
| the labwc autostart shell | ends by itself | It only waits for the app |
| `selkies` | no | Must accept the next connection and run the connect hook |
| `Xwayland`, `labwc` | no | Selkies streams the desktop they draw |
| `dbus-launch` / session bus | no | Cheap, and the restarted app registers on it again |

### 3.6 Why opt-in

- Closing interrupts whatever the app was doing in the background, and returning costs a cold start.
- The CPU saving is small in absolute terms (a few percent of one core). It matters for always-on, low-power home servers, not for everyone.
- So the default behaviour stays exactly as before, and the feature leaves no trace when off.

## 4. Interaction with the upload watcher

With `AUTO_OPEN_UPLOADS=true`, the watcher hands each finished upload to the running app over D-Bus, and starts the app with the file if none runs (see [12 §1.5](12-remaining-hands-on.md)).

- Before handing over, the watcher runs `crealityprint-idle is-quit`. While the app is closed for being idle, it logs that it skipped the file and **leaves the app closed**. Otherwise the fallback would start the app for a file nobody is looking at, and the idle timer would close it again and drop the plate.
- This only happens for uploads through the Selkies file API with no browser connected (e.g. `curl`). The file stays in the upload folder, so import it after reconnecting.
- Uploads from the browser sidebar or drag-and-drop always have a client connected, so the app is running and the file is opened as usual.
- If you closed the app yourself, the marker isn't set, and the watcher starts the app with the file as before. With no browser connected, the idle timer then closes it again once it has run for `IDLE_QUIT_AFTER` (the backup offers the plate back, §5).

## 5. What closing does to the app

Tested in containers from this image (Creality Print 7.3), K1C preset, with the file `cube.stl` added to the plate and not saved [V]:

| Question | Result |
|---|---|
| Does SIGTERM prompt to save? | **No.** The app exits in about **50 ms**; the WebKit helpers and the autostart shell are gone within a second. |
| Settings (`Creality.conf`) | Not at risk: the app rewrites the file through a temp file and rename on every change, not only at exit ([05](05-settings-persistence.md), [12 §1](12-remaining-hands-on.md)). Closing risks nothing that `docker stop` doesn't. |
| Unsaved project | The project backup in `/tmp/crealityprint_model/<date>/<time>#<pid>#<id>` survives. The next start shows **"Previously unsaved items have been detected. Do you want to restore them?"** with Yes/No. **Yes brought the cube back** on the plate. |
| Clean project at close | No prompt on the next start. |
| Stale instance lock (`cache/<hash>.lock`) | Harmless: the next start runs normally. |
| Start from the daemon's context | Works; `crealityprint-open` reaches the new instance over D-Bus. |
| Cold start to the main window | About **1.6 s** (warm page cache, this host) and about 5 s in the e2e runs. |
| Logs | One `debug_<date>_<pid>.log.0` per start. The app deletes old log files itself (the binary has "delete log file over …"), so they don't pile up [V: string, I: retention]. |
| Memory | About **1.4 GiB** with the app running against about **160 MiB** once it is closed (§6). |

The backup lives in `/tmp`, so it survives a `docker restart` but not a re-create ([09 R12](09-roadblocks-and-risks.md)).

### 5.1 Work in progress

Closing ends what the app was doing: a slice, a G-code upload to the printer (it may leave a partial file there), a cloud download or a firmware push. A print already running on the printer is not affected. With the 30-minute default, "send, then close the tab" only breaks if the send takes longer than that [I].

### 5.2 Coming back

You get a cold start: the desktop is empty for a few seconds, then the app opens with an empty plate (or with the restore prompt above). Printer status and the camera connect from scratch.

### 5.3 Never close a starting app

In the first e2e run (5 s timeout), the daemon closed the app about 3.5 s into its **very first start on a fresh `/config`**, before any WebKit helper had started. The next start showed **"Detected corruption in the Creality Print configuration file, attempted to rebuild, please manually restart the software."** and stayed on that dialog [V].

Narrowing it down [V]:
- The same close at 1, 2 and 4 s into a first start didn't reproduce it, so the window is narrow.
- Closing a later start (existing config) at 0.5, 1, 2 and 3 s was harmless every time.
- The first start does one-off work (the data-directory migration under `.migration-7.3.lock`, about 2,000 system preset files, the first `Creality.conf` rewrite), so a close in the middle of it is the likely cause [I].

Guard: **the daemon never closes an app that has run for less than 60 s** (from `/proc/<pid>/stat` field 22, and in general for less than `IDLE_QUIT_AFTER`, §3.4). It logs "has only run for Ns; closing it in Ms" and checks again then. With the default 30 minutes the 60 s floor never matters. It only matters for a very short `IDLE_QUIT_AFTER`, like the tests' 5 s.

## 6. Measurements

Test container from this image, no client connected, `CP_PRINTER=Creality K1C`, second start of the same `/config` (the first start does one-off seeding). After 2 minutes of settling: two 60 s samples with the app running, then the app tree closed with SIGTERM, 30 s pause, three 60 s samples. CPU is the container cgroup's `cpu.stat` usage as % of one core; context switches (a proxy for wakeups) are voluntary + nonvoluntary, summed over every thread in the container; memory is the cgroup's `memory.current` [V].

| No client connected | App running (2 samples) | App closed (3 samples) |
|---|---|---|
| Container CPU (% of one core) | **3.05 %** (3.02–3.08) | **1.07 %** (1.05–1.10) |
| Context switches/s | **114** (112–115) | **70** (70–70) |
| Memory (`memory.current`) | **1393 MiB** | **157 MiB** |

- The samples include the measuring itself (a `docker exec` that reads every thread's `/proc` status at the start and end of each sample), so the absolute CPU figures are a little higher than the per-process sums in §1; the difference between the columns is what counts.
- Closing saves about **2 % of a core**, **44 context switches/s** and about **1.2 GiB** of memory.
- That is about the same CPU and wakeups as freezing saved (freeze: 2.26 % → 0.71 %, 111 → 68 switches/s, measured per process), and also frees the app's memory.
- What is left is Selkies (§8).

## 7. Printer connections after a return

- **Status** reconnects by itself after a start, as on any start.
- **The K1 WebRTC camera** works again after a start. With the freeze version it stayed dead after any pause of more than a few seconds until the app restarted (§1.1); a restart, which is what every return now is, brought it back to 137 KiB/s [V, 2026-11-22 with the K1C "K1C-264A"]. Not re-measured with a real printer on this exact image [I: same app binary and start path].

## 8. Selkies' own idle cost

Investigated read-only on `ghcr.io/micdah/docker-crealityprint:latest` (selkies 2.2.1, pixelflux 2.2.3), Wayland mode, no client connected. 60 s samples of every thread's schedstat run time and context switches, with attribution from `strace -f` and `py-spy dump/record --native` (installed only in throwaway test containers). Full notes and raw data are not kept in the repo.

With the app out of the way (frozen at the time; closed is the same for Selkies), the container wakes **about 68 times a second at about 0.87 % of one core**, and almost all of that is Selkies [V]:

| Source | Wakeups/s | CPU % | Cause | Setting |
|---|---|---|---|---|
| selkies main thread: `_key_repeat_loop` | ~50 | ~0.65 | `asyncio.sleep(0.02)` loop, `selkies/input_handler.py` (defined around L5637, interval at L4792) | none |
| selkies main thread: `_key_stale_sweep` | ~10 | ~0.15 | `asyncio.sleep(0.1)` loop (around L5563, interval at L4787) | none |
| selkies main thread: clipboard monitor | ~0.5 | small | 2 s wait plus a liveness `connect()` to labwc's `wayland-0` (around L8443, L6840) | `SELKIES_ENABLE_CLIPBOARD=false` |
| selkies main thread: gamepad interposers | ~1 | small | four `asyncio.sleep(1)` loops (around L3911) | none (`SELKIES_GAMEPAD_ENABLED=false` doesn't stop them) |
| pixelflux compositor thread | 4 | 0.03 | a 250 ms timerfd, purpose unknown | none |
| `pf-dc-watch` (pixelflux) | 2 | 0.007 | 500 ms clipboard watch on labwc | `SELKIES_ENABLE_CLIPBOARD=false` |
| labwc | 0.5 | ~0 | woken by Selkies' 2 s socket probe | `SELKIES_ENABLE_CLIPBOARD=false` |
| pulseaudio, cupsd, nginx, dbus, at-spi, s6 | 0 | 0 | — | — |

The key loops (line numbers [V], wakeup split [V by strace and a patch experiment]) start when the server starts (`connect()` at L5364–5367, called from `websockets_mode.py` L7876–7879), not when a client connects. They also run in Wayland mode, where key repeat is off.

The four questions:
- **Capture and encode with no client:** none. There is no encoder thread, and the app's redraws don't wake Selkies (67.6/s with the app paused against 68.3/s with it running) [V].
- **Periodic Python tasks:** none besides the timers above. A 60 s strace showed no stats, metrics, webhook, token-file or upload-reaping activity [V].
- **Other processes:** effectively zero (table) [V].
- **With a client connected** (for comparison): 628 wakeups/s and 6.7 % CPU, of which pulseaudio alone is 300/s and 2.1 %. It falls back to 68/s about 30 s after the client leaves [V].

Settings tested, each in a fresh container with the app paused [V]:

| Setting | Container wakeups/s | CPU % |
|---|---|---|
| none | 68.1 | 0.87 |
| `SELKIES_ENABLE_CLIPBOARD=false` | 65.5 | 0.82 |
| `SELKIES_AUDIO_ENABLED=false` | 67.8 | 0.82 |
| `SELKIES_PRINTING_ENABLED=false` | 67.7 | 0.84 |
| `SELKIES_GAMEPAD_ENABLED=false` | 68.2 | 0.83 |
| all four | 65.2 | 0.84 |
| `PIXELFLUX_WAYLAND=false` (X11 mode) | 64.1 | 0.87 |
| test-only patch slowing both key loops to once an hour | 8.0 | 0.065 |
| the same patch + clipboard off | 5.0 | 0.05 |

The patch was only an attribution test. It disables stuck-key release and is not a fix.

Package C-state residency was not measured: `powertop` needs root, and `perf`/`turbostat` aren't installed. For scale, the host as a whole made about 48,000 idle-state entries/s at the time, so Selkies' 68/s is a small part of what keeps this CPU awake [V numbers, I conclusion].

Options, not decided:
1. **The key loops** are the only large item, and no setting reaches them. Options: report upstream to Selkies (start the loops only while keys are held or a client is connected); patch the base image's Python file, which would need re-checking on every Renovate base bump and should gate the loops, not slow them; or accept about 0.8 % of a core. **Decided 2026-11-22: patched** at build time, gating the loops; the build fails when the patch no longer applies ([14](14-selkies-idle.md)).
2. **`SELKIES_AUDIO_ENABLED=false`** as an image default: no idle effect, but it saves about 400 wakeups/s and about 3 % of a core while a client is connected. Creality Print needs no audio [I]. **Decided 2026-11-22: done** (Dockerfile `ENV`; users can set it back to `true`).
3. **`SELKIES_ENABLE_CLIPBOARD`**: about 2.5 wakeups/s less, at the cost of the session-to-browser clipboard (covered by `tests/e2e/clipboard.spec.js`). `SELKIES_ENABLE_CLIPBOARD=in` should keep paste from the browser into the app with the same idle saving [I, not measured]. Not worth a default.

## 9. Tests

Container starts are the slow part of the e2e suite, so the feature adds only one, and every wait is a poll that returns early.

- **`tests/e2e/idle.spec.js`** (its own CI matrix job): one container with `IDLE_QUIT=true`, `IDLE_QUIT_AFTER=5` and `AUTO_OPEN_UPLOADS=true`, one test that checks in order:
  1. with no browser connected, the app is closed once it has had its first minute ("has only run for …" is logged first), and no app or WebKit process is left;
  2. a file-API upload while closed is skipped by the watcher, and no app starts;
  3. opening a session starts exactly one app, the main window comes up, the skipped model isn't loaded, and `crealityprint-open` reaches the new instance;
  4. after the page leaves, the app is closed again, and the next connect starts it again;
  5. after the user closes the app (SIGTERM from outside, while connected), leaving and reconnecting does not start it. The test waits for the state file to read `absent` and then `present`, so it knows the daemon saw both hooks.
- **`tests/e2e/watcher.spec.js`**: its existing default-settings test also checks that `IDLE_QUIT` is off by default, with no extra container and no waiting: no `[crealityprint-idle]` log lines, no `SELKIES_RUN_AFTER_*` in `/run/s6/container_environment`, and no `/run/crealityprint-idle`.
- Checked by hand, not in CI: the user's-own-hooks path, the hook ordering (§3.3), a connect during the shutdown grace period (§3.4), and the restore prompt (§5).
- `tests/e2e/lib/app.js` gains `appTreeProcessCount()` (app + WebKit processes) and `appLogIncludes()`.
- The idle spec takes about **2.3 minutes**, most of it the two waits for the 60-second start-up guard (§5.3).
