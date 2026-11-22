# 13 — Sleep when idle (opt-in)

Date: 2026-11-22 · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, Intel UHD 630

This doc covers the opt-in "sleep when idle" feature (`IDLE_SLEEP=true`): why it exists, the Selkies hooks it builds on, the design, how it interacts with the upload watcher, the tests and the measurements.

Legend: **[V]** = verified by running it or reading the source, **[I]** = inferred.

## Summary

- With no browser connected, the container still uses about **2.7 % of one core**, and the app keeps waking the CPU [V, §1].
- With `IDLE_SLEEP=true`, the image **freezes (SIGSTOP) Creality Print and its child processes** once no client has been connected for `IDLE_SLEEP_AFTER` seconds (default 600). It **resumes (SIGCONT) them the moment a client connects**.
- Selkies, Xwayland, labwc and `dbus-launch` keep running, so the next connection works as usual.
- It is built on Selkies' own presence hooks, `SELKIES_RUN_AFTER_CONNECT` and `SELKIES_RUN_AFTER_DISCONNECT` [V, §2]. No polling: the daemon blocks on a FIFO with a read timeout.
- **Off by default.** When off, nothing is installed: no hooks, and the service just runs `sleep infinity`.
- Costs while asleep: printer connections drop (status recovers on wake, but the K1 WebRTC camera only comes back after an app restart, §7), a running slice or G-code send is paused, and file-API uploads with no client connected aren't auto-opened (§4).
- What's left asleep is Selkies itself, about 68 wakeups/s, mostly two hard-coded 50 Hz + 10 Hz keyboard loops that no setting turns off (§8).
- Saving while asleep: container CPU drops from **about 2.3 % to about 0.7 % of one core**, and context switches (a proxy for wakeups) from **about 111/s to 68/s** [V, §6]. What is left is Selkies itself (§8).

---

## 1. Question and goal

The server runs 24/7, but the app is used rarely, often with days or weeks between visits. Question: can the container use (almost) no CPU while nobody is connected, without losing the app's state?

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
- Freeze the app while nobody is connected, and wake it instantly on the next connection.
- Keep all app state, including unsaved work. So: pause the processes, don't stop and restart them.
- Add no new periodic wakeups of our own.
- Change nothing for users who don't turn it on.

## 2. The Selkies presence hooks

The Selkies base image already reports when the first client connects and when the last one leaves [V, read in the installed package `selkies/` under `/lsiopy/lib/python3.13/site-packages/`]:

- `settings.py` L686 and L692 define two string settings, `run_after_connect` and `run_after_disconnect` (env `SELKIES_RUN_AFTER_CONNECT` / `SELKIES_RUN_AFTER_DISCONNECT`, default empty = off).
  - Connect: "run after the first client has connected; runs again each time a client connects while no others are connected."
  - Disconnect: "run after the last client has disconnected, including on server shutdown while clients are connected."
- `stream_server.py` L1919, `set_clients_present(present)`, is called by both streaming modes (`websockets_mode.py` L5162, `webrtc_mode.py` L678). It only acts on a change (0 → 1 or 1 → 0 clients) and then starts the matching command as an asyncio task.
- `_run_client_hook()` runs the command with `asyncio.create_subprocess_shell()`. It waits **at most 300 s**, then kills the command and logs a warning. A non-zero exit status is logged as a warning.
- The command runs in the Selkies process's context, so as user `abc` [I: Selkies runs as `abc`].
- The hooks are not serialized: each one is its own task, so a fast disconnect/connect can have two hook commands running at once, and the later event's hook can finish first [V: source]. Without ordering, a late `disconnect` could mark a connected browser as gone, and the app would freeze in front of the user. §3.3 shows how the hooks are ordered.

Consequences for the design:
- The hooks are the only reliable "someone is here" signal. Selkies itself must stay awake to deliver it.
- A hook must be quick and must never block. A hook that hangs would be killed after 300 s, but it should not get anywhere near that.

## 3. Design

### 3.1 Pieces

| Piece | Kind | Job |
|---|---|---|
| `init-crealityprint-idle` | s6 oneshot (init) | When `IDLE_SLEEP=true`: writes the two hooks into `/run/s6/container_environment/` so Selkies picks them up. Otherwise does nothing. |
| `crealityprint-idle` | script in `/usr/local/bin` | `connect` and `disconnect` (the hooks), `is-asleep` (for the upload watcher), `daemon` (the timer). One script, so freezing and resuming live in one place. |
| `svc-crealityprint-idle` | s6 longrun | Runs `crealityprint-idle daemon` as `abc`. Runs `sleep infinity` when the init step didn't create the FIFO (feature off, or the user's own hooks are set). |
| `/run/crealityprint-idle/clients` | state file | `present` or `absent`, plus the spawn order of the hook that wrote it (§3.3) |
| `/run/crealityprint-idle/events` | FIFO | Wakes the daemon when the state changes |

### 3.2 Turning it on

- `IDLE_SLEEP` defaults to `false`. Only `true` (any case) turns it on.
- `IDLE_SLEEP_AFTER` is in seconds, default `600` (10 minutes). A value that isn't a positive integer logs a warning and 600 is used.
- If the user already set `SELKIES_RUN_AFTER_CONNECT` or `SELKIES_RUN_AFTER_DISCONNECT`, the init step logs a warning and leaves the feature off. It never overwrites a user's hook.
- When off, nothing is installed, so the feature leaves no footprint.
- The init step clears the previous start's runtime folder and its own hooks first. `/run` isn't a tmpfs in Docker, so after a restart with `IDLE_SLEEP` turned off, nothing from the earlier run is left.
- When on, it creates `/run/crealityprint-idle/` (owned by `abc`) with the FIFO and the state file set to `absent`, then installs the hooks.

### 3.3 The hooks: `crealityprint-idle connect|disconnect`

- `connect`:
  1. writes `present` to the state file (see "Ordering" below);
  2. resumes (SIGCONT) the app tree **right away**;
  3. notifies the daemon.
- `disconnect`: writes `absent` to the state file, then notifies the daemon.
- "Notify" = write one line to the FIFO under `timeout 5`. The daemon keeps the FIFO open read-write, so the write doesn't block while the daemon runs. The timeout keeps a hook from hanging if the daemon isn't reading. If the FIFO doesn't exist, the hook skips the notify.
- **Ordering.** Each state is stored with the hook's spawn order: the start time (`/proc/<pid>/stat` field 22) and PID of the process Selkies forked. That is the hook's parent `sh`, because dash doesn't `exec` a `sh -c` command [V]. A hook only writes if no later event has written already. The check and write run under `flock`, and the write goes through a temp file and rename, so the daemon (which reads without the lock) never sees half a state. Verified in a container with out-of-order hooks: a `disconnect` spawned first but finishing last leaves `present`, and a `connect` spawned first but finishing last leaves `absent` [V].
- `connect` resumes the app itself instead of asking the daemon. So waking never depends on the daemon, and it happens as soon as Selkies runs the hook.
- `is-asleep` exits 0 when the app is frozen (the `CrealityPrint` process is in state `T` in `/proc/<pid>/stat`). The upload watcher uses it.
- A missing or unreadable state file counts as "connected": when in doubt, don't freeze.

### 3.4 The daemon

- It runs as `abc` (`s6-setuidgid abc`).
- Nobody is connected at boot, so the daemon **arms the timer at start**.
- The timer only runs while nobody is connected and the app is awake. Then it blocks on `read -t <IDLE_SLEEP_AFTER>` on the FIFO.
- While a browser is connected, or after the app is frozen, it blocks on a plain `read` with no timeout until the next hook.
- There is no polling, so it adds no wakeups of its own.
- An event (connect or disconnect) restarts the wait.
- On timeout, it re-reads the state file. If the state is `absent`, it freezes (SIGSTOP) the `CrealityPrint` process and all its descendants (the WebKit helper processes).
  - Freezing stops the app first, then its helpers, so a stopped app can't start new helpers meanwhile. It walks the tree again (up to 5 passes) until no new process turns up, in case a helper started a child between the walk and its own stop. If the app exits before it can be stopped, nothing is logged and the timer re-arms.
  - Resuming continues the helpers first, then the app, so the app never waits on a stopped helper.
- **Race guard:** after freezing, it re-reads the state file. If a client connected in the meantime, it resumes the app at once. The two orderings are both covered:
  - the connect hook ran before the freeze: the re-check sees `present` and resumes;
  - the connect hook runs after the freeze: its own SIGCONT resumes.
- If no app process exists yet (still starting, or closed from the menu), it re-arms the timer and tries again after the next timeout.
- Every step is logged on lines starting with `[crealityprint-idle]`.

### 3.5 What is frozen, and why the process tree

| Process | Frozen? | Why |
|---|---|---|
| `CrealityPrint` | yes | Most of the idle CPU |
| its descendants (the WebKit helpers, e.g. `WebKitWebProcess`) | yes | The rest of the app's idle CPU |
| `selkies` | no | Must accept the next connection and run the connect hook |
| `Xwayland`, `labwc` | no | Selkies streams the desktop they draw |
| `dbus-launch` / session bus | no | Cheap, and a frozen bus would make other D-Bus callers hang [I] |

Why not something broader:
- **`docker pause` (the cgroup freezer)** freezes the whole container, including Selkies. Nothing inside could then notice a connection and wake the app [I].
- **The process group** of the app also holds the labwc autostart shell and `dbus-launch` [V: `ps -eo pgid` in a running container]. Walking the tree from the `CrealityPrint` PID freezes exactly the app and its helpers.
- **Freezing the compositor or Xwayland too** would save a little more (Xwayland is 0.07 %), but Selkies would then have nothing to stream on the next connection, and waking would need more steps.

Why SIGSTOP and not closing the app:
- The app keeps its full state in memory, including unsaved work, the open plate and dialogs.
- Waking is instant. A cold start of the app takes much longer [I].

### 3.6 Why opt-in

- While asleep, the app does nothing in the background: printer status and camera connections drop, and a running slice or G-code send pauses (§4, §7).
- The saving is small in absolute terms (a few percent of one core). It matters for always-on, low-power home servers, not for everyone.
- So the default behaviour stays exactly as before, and the feature leaves no trace when off.

## 4. Interaction with the upload watcher

With `AUTO_OPEN_UPLOADS=true`, the watcher hands each finished upload to the running app over D-Bus (see [12 §1.5](12-remaining-hands-on.md)).

- Before any D-Bus send, the watcher runs `crealityprint-idle is-asleep`. A message queued for a frozen app would still be delivered when the app wakes, so the model would land on the plate later, unexpectedly.
- So, if the app is asleep when a file arrives, the watcher logs that it skipped the file and **leaves the app frozen**. It doesn't wake the app just for the upload.
- This only happens for uploads through the Selkies file API with no browser connected (e.g. `curl`). The file stays in the upload folder, so import it after reconnecting.
- Uploads from the browser sidebar or drag-and-drop always have a client connected, so the app is awake and the file is opened as usual.

Other effects while asleep:
- Printer connections drop. Status reconnects on wake, but the WebRTC camera only comes back after an app restart (§7).
- A slice or G-code send that is still running when the last tab closes is paused once the timeout passes. It continues on the next visit [I].

## 5. Tests

Container starts are the slow part of the e2e suite, so the feature adds only one, and every wait is a short poll rather than a fixed sleep.

- **`tests/e2e/idle.spec.js`** (new, its own CI matrix job): one container with `IDLE_SLEEP=true`, `IDLE_SLEEP_AFTER=5` and `AUTO_OPEN_UPLOADS=true`, one test that checks in order:
  1. with no browser connected, `CrealityPrint` and all its descendants reach state `T`;
  2. a file-API upload while asleep is skipped by the watcher, and the app stays frozen;
  3. opening a session wakes the tree (`awake: a browser connected` is logged), the main window comes up, and the skipped model is not in the app's `load_files` log;
  4. after the page leaves, the tree is frozen again.
- **`tests/e2e/watcher.spec.js`**: its existing default-settings test also checks that `IDLE_SLEEP` is off by default, with no extra container and no waiting: no `[crealityprint-idle]` log lines, no `SELKIES_RUN_AFTER_*` in `/run/s6/container_environment`, and no `/run/crealityprint-idle`.
- Not covered by an e2e test, to keep CI fast: the user's-own-hooks path (`IDLE_SLEEP=true` with `SELKIES_RUN_AFTER_*` already set, so the feature stays off with a warning) and the clearing of a previous start's state. The hook ordering was checked by hand (§3.3).
- `tests/e2e/lib/app.js` gains `appTreeStates()` (the `/proc` state of the app tree in one `docker exec`) and `appLogIncludes()`.

Results on the dev host [V]:
- The idle test takes **about 20 s**, also with `--app-cpus 4 --workers 1` (mimicking a CI runner). The off-by-default checks add 2.8 s to the watcher spec.
- Measured waits:

| Wait | Took | Poll limit |
|---|---|---|
| frozen with no browser | about 5.05 s after the timer started | 30 s |
| watcher skips the upload | within one 500 ms poll | 30 s |
| wake on connect | about 20 ms after Selkies saw the client | 30 s |
| frozen again after the page left | about 5.1 s | 30 s |

- With a 5 s timeout the first freeze can land before the app has started its WebKit helpers ("froze Creality Print and 0 helper processes"). Waking finishes the start-up normally, and the main window comes up in about 7 s.

## 6. Measurements

Test container from `crealityprint:dev`, no client connected, `CP_PRINTER=Creality K1C`, second start of the same `/config`. Samples were 60 s, taken on 2026-11-22 between 12:09 and 12:19 (local time), only while no e2e, smoke or build container was running. The table gives the mean of two awake and three frozen samples (range in brackets) [V]. CPU is % of one core (from `/proc/<pid>/stat`; 10 ms ticks, so ±0.02 %). Context switches are voluntary + nonvoluntary, summed over all threads.

| Process | CPU awake | CPU asleep | ctxt switches/s awake | asleep |
|---|---|---|---|---|
| `CrealityPrint` | 1.33 % (1.13–1.52) | 0.00 % | 26.9 | 0 |
| `selkies` | 0.80 % (0.77–0.82) | 0.70 % (0.52–0.84) | 67.4 | 67.7 |
| `WebKitWebProcess` (×4) | 0.09 % | 0.00 % | 4–9 | 0 |
| `Xwayland` | 0.05 % | 0.00 % | 9.5 | 0 |
| `labwc` | 0.00 % | 0.00–0.02 % | 0.5 | 0.5 |
| everything else (`WebKitNetworkProcess`, nginx, pulseaudio, …) | 0.00 % | 0.00 % | 0 | 0 |
| **Sum** | **2.26 %** (2.10–2.41) | **0.71 %** (0.52–0.85) | **111** | **68** |
| Container cgroup (`cpu.stat`) | 2.14–2.42 % | 0.57–0.84 % | | |

- Asleep saves about 1.5 % of a core and about 43 context switches/s. Xwayland goes quiet too, because nothing redraws [V].
- Selkies is unchanged (about 67 switches/s either way) and is all that is left (§8).
- The §1 baseline came from a different, longer-running container. It had more WebKit activity (0.63 % against 0.09 % here), so the saving depends on what the app's web views are doing [I].

| Other | Value |
|---|---|
| Hook run time (`crealityprint-idle connect`, inside `docker exec`) | about 95 ms total, of which `docker exec` itself is about 57 ms, so about 40 ms [V] |
| Wake on connect in the e2e test (Selkies sees the client → processes resumed) | about 20 ms [V] |
| CPU in the 30 s after a wake | 1.75 %, back to normal idle with no spike [V] |

## 7. Printer reconnect after wake

Setup: test container from `crealityprint:dev` with `IDLE_SLEEP_AFTER=60`; K1C "K1C-264A" (192.168.1.251, firmware with the WebRTC camera, see [11](11-printer-tests.md)) added by IP on the bridge network. Read-only throughout: no print, send, heat, move, fan or light control was used. The Details page (status + camera) was left open when the browser left, so it was what came back on wake.

| Step | Result |
|---|---|
| Before sleep | Device tab "Idle", Details showing live temperatures (19 °C, targets 0) and the camera [V] |
| Asleep 16 min (11:12 → 11:28 UTC) | Only one TCP connection to the printer was still open (port 443, ESTABLISHED); the others had closed [V] |
| Status after wake | **Recovers by itself.** Within seconds the Details page showed new values (20 °C, chamber filled in, X/Y position), and later 21 °C [V] |
| Camera after wake | **Doesn't recover.** The view keeps its last frame. Inbound traffic stays at about 3 KiB/s, against about 137 KiB/s while the camera streams [V] |

The camera was then narrowed down with manual `SIGSTOP`/`SIGCONT` on the same config, measuring the container's inbound bytes over 10 s [V]:

| Case | Camera traffic |
|---|---|
| never frozen, 1 to 7 minutes after opening Details | 136–137 KiB/s, steady (the printer doesn't end the session itself) |
| after a 20 s, 60 s or 2 min freeze of the app tree | about 3 KiB/s |
| freezing only `CrealityPrint` and leaving the WebKit helpers running | drops to 26 KiB/s within 5 s and 0 by 60 s; about 3 KiB/s after resume. The web view stalls without its UI process |
| after the camera refresh button, closing and reopening Details, switching Prepare → Device, or waiting 4+ minutes | still about 3 KiB/s |
| after restarting the app (container restart) | 137 KiB/s again |

So any freeze longer than a few seconds ends the WebRTC camera session, and the app's page doesn't set it up again until the app restarts [V]. The likely cause is WebRTC's consent/keep-alive checks failing while the page can't answer them [I].

Decision (2026-11-22): **document it, no workaround.** A traffic-based "don't sleep while the camera streams" check would be fragile, and it would keep the app awake whenever the Details page was left open. To get the camera back after a sleep, save your project and restart the app (close it and relaunch it from the desktop's right-click menu, or restart the container).

## 8. Selkies' own idle cost

Investigated read-only on `ghcr.io/micdah/docker-crealityprint:latest` (selkies 2.2.1, pixelflux 2.2.3), Wayland mode, no client connected. 60 s samples of every thread's schedstat run time and context switches, with attribution from `strace -f` and `py-spy dump/record --native` (installed only in throwaway test containers). Full notes and raw data are not kept in the repo.

With the app frozen, the container wakes **about 68 times a second at about 0.87 % of one core**, and almost all of that is Selkies [V]:

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
- **Capture and encode with no client:** none. There is no encoder thread, and the app's redraws don't wake Selkies (67.6/s frozen against 68.3/s awake) [V].
- **Periodic Python tasks:** none besides the timers above. A 60 s strace showed no stats, metrics, webhook, token-file or upload-reaping activity [V].
- **Other processes:** effectively zero (table) [V].
- **With a client connected** (for comparison): 628 wakeups/s and 6.7 % CPU, of which pulseaudio alone is 300/s and 2.1 %. It falls back to 68/s about 30 s after the client leaves [V].

Settings tested, each in a fresh container with the app frozen [V]:

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
1. **The key loops** are the only large item, and no setting reaches them. Options: report upstream to Selkies (start the loops only while keys are held or a client is connected); patch the base image's Python file, which would need re-checking on every Renovate base bump and should gate the loops, not slow them; or accept about 0.8 % of a core.
2. **`SELKIES_AUDIO_ENABLED=false`** as an image default: no idle effect, but it saves about 400 wakeups/s and about 3 % of a core while a client is connected. Creality Print needs no audio [I]. **Decided 2026-11-22: done** (Dockerfile `ENV`; users can set it back to `true`).
3. **`SELKIES_ENABLE_CLIPBOARD`**: about 2.5 wakeups/s less, at the cost of the session-to-browser clipboard (covered by `tests/e2e/clipboard.spec.js`). `SELKIES_ENABLE_CLIPBOARD=in` should keep paste from the browser into the app with the same idle saving [I, not measured]. Not worth a default.
