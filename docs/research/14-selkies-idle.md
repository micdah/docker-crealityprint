# 14 — Selkies' own idle wakeups, and a build-time patch

Date: 2026-11-22 · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, Intel UHD 630 · Base: `baseimage-selkies:debiantrixie@sha256:793fc362…` (selkies 2.2.1, pixelflux 2.2.3)

Follow-up to [13 §8](13-idle-quit.md), which found that with no browser connected Selkies itself wakes about 68 times a second, almost all of it from two key-handling loops that no setting reaches. This doc covers what can be done about it, the patch the image now applies, how the build fails when the patch no longer fits, and the measurements.

Legend: **[V]** = verified by running it or reading the source, **[I]** = inferred.

## Summary

- Two `asyncio` loops in `selkies/input_handler.py`, the stale-key sweep (every 100 ms) and the key-repeat loop (every 20 ms), start with the server and poll forever, connected or not. With no key held, both loop bodies do nothing [V].
- **No setting, and no upstream release, fixes it.** 2.2.1 is the newest selkies on PyPI. Upstream deleted the Python server on 2026-11-05 in favour of a Rust port, and the Rust port keeps the same two always-on timers [V, §2].
- **The image now patches the one file at build time**, in 5 small hunks (+17/−2 lines): each loop still sleeps its interval, then parks on an `asyncio.Event` while nothing is held; handling a client message sets the event (§3).
- **The build fails if the patch doesn't apply exactly.** `git apply` allows no fuzz, only line offsets, and applies all hunks or none; the script then byte-compiles the file. Verified against drifted copies of the file (§4).
- Measured, no client connected (§5):
  - app running: Selkies **65.5 → 5.6** wakeups/s on its main thread and **0.87 → 0.07 %** of a core; container **2.1–2.3 → 1.5–1.6 %** of a core;
  - app closed (the `IDLE_QUIT` state from [13](13-idle-quit.md)): container **70.9 → 8.1** wakeups/s and **0.48 → 0.05 %** of a core.
- A new e2e spec (`tests/e2e/input.spec.js`) checks both the saving and that a stuck key is still released. It fails on the unpatched image (66–71 wakeups/s) [V, §6].

---

## 1. Where the wakeups come from

Re-checked in the 2.2.1 source from the pinned base [V]:

| Loop | Defined | Interval | Started |
|---|---|---|---|
| `WebRTCInput._key_stale_sweep` | `input_handler.py` L5563 | `key_sweep_interval = 0.1` (L4787) | `connect()` L5364–5365, at server start |
| `WebRTCInput._key_repeat_loop` | L5637 | `key_repeat_tick = 0.02` (L4792) | `connect()` L5366–5367, at server start |

- The sweep releases a key whose client heartbeat (`kh`, every 100 ms while held) stops, e.g. a key-up lost to congestion. It also neutralizes gamepads whose `js,h` heartbeat stops. With `pressed_keys` and `gamepad_heartbeats` empty it `continue`s at once.
- The repeat loop does server-side key repeat on X11, and on both backends lets go of a held key whose heartbeats stopped. With `pressed_keys`, `key_suspended` and `key_repeat_state` empty, every branch is a no-op.
- So both loops only have work while a key or gamepad is held, and all of that state is added in `_dispatch_message` (`kd` L9199/L9204, `kh` L9270, `js,h` L9398, repeat arming L9229), which is only called from `on_message`, the transport's entry point for one client message. `key_suspended` is only added by the repeat loop itself, for a key in `pressed_keys`. Nothing outside `input_handler.py` touches these fields [V: grep of the package].

The remaining sources from [13 §8](13-idle-quit.md) are small and left alone: the gamepad interposer loops (`asyncio.sleep(1)`, L3913), the clipboard monitor (2 s), pixelflux's 250 ms timer and `pf-dc-watch` (500 ms). Together about 8 wakeups/s.

## 2. Options

| Option | Verdict |
|---|---|
| A setting | None exists. `SELKIES_GAMEPAD_ENABLED=false`, clipboard, audio and X11 mode don't touch the key loops ([13 §8](13-idle-quit.md)) [V]. |
| Wait for upstream | 2.2.1 is the newest release on PyPI [V]. Upstream commit `5f8f1fc0` (2026-11-05, "refactor: Remove the Python server") deletes `src/selkies` for the Rust server, and `crates/selkies/src/input/handler.rs` keeps the same design: `KEY_SWEEP_INTERVAL` 100 ms and `KEY_REPEAT_TICK` 20 ms on two `tokio::time::interval`s started with the handler (L305–307, L460–476) [V]. An upstream issue is still worth filing, against the Rust server. |
| Monkeypatch from outside (e.g. a `sitecustomize.py` replacing the two methods) | Rejected. It would copy both method bodies, so an upstream change to them would be silently overwritten instead of failing the build. |
| Slow the loops down | Rejected. Stuck-key release and key repeat would get slower too ([13 §8](13-idle-quit.md) only did this as an attribution test). |
| **Patch the file at build time, gating the loops** | **Chosen.** Smallest change that removes the cost without changing behaviour, and `git apply` can refuse a drifted file. |

## 3. The patch

`build/patches/selkies-park-idle-key-loops.patch`, applied by `build/patch-selkies.sh` in its own Dockerfile layer, after the AppImage layer so a patch change doesn't re-download the app. 5 hunks, all in `selkies/input_handler.py`:

1. `__init__`: `self.input_wake = asyncio.Event()`.
2. A new method `_key_loop_tick(interval)` just before `_key_stale_sweep`: sleep `interval`, then, while `pressed_keys`, `gamepad_heartbeats`, `key_suspended` and `key_repeat_state` are all empty, clear the event and wait on it.
3. and 4. Each loop's `await asyncio.sleep(…)` becomes `await self._key_loop_tick(…)`.
5. `on_message` gets `finally: self.input_wake.set()`.

Why it is safe [V: source, I: reasoning]:
- The parking check and the wait have no `await` between them, so on the single event loop nothing can add held state in between.
- The event is set *after* the message is handled, so any state the message added is already visible when a loop wakes. (Setting it before would be wrong: `kd` awaits `_paste_waits_for_png` before it adds the key, and a loop could park in between.)
- With nothing held both loop bodies are no-ops, so skipping their iterations changes nothing. After a wake a loop runs its body at once instead of up to one interval later; every check in it is time-gated (2 s stale window, 0.3 s heartbeat grace, 0.5 s repeat delay), so running early does nothing.
- Leftover state (e.g. a stale `key_suspended` entry) keeps the loops running, exactly as upstream: the failure direction is "polls like before", never "stops releasing keys".
- Cancelling a parked loop (`disconnect()`) raises `CancelledError` in the wait, which both loops already catch.
- While a client is connected and typing, the loops run as before.

## 4. Failing the build when the base changes

`build/patch-selkies.sh` [V]:
- finds the package with `importlib.util.find_spec("selkies")` (no import), and logs the selkies version;
- runs `git apply --check` and then `git apply`. `git` is in the base image; `patch` is not. `git apply` accepts a hunk only if its context matches exactly, allowing only a line offset, and applies a patch's hunks all or none;
- byte-compiles every patched file with `py_compile`: a syntax error fails the build, and the `.pyc` matches the new source (Selkies runs as `abc`, who can't rewrite it);
- exits non-zero with "no longer applies to selkies X; update the patch (see its header)" otherwise.

Checked by running the same step in the base image against edited copies of the file [V]:

| Change to the base's file | Result |
|---|---|
| none | applies, recompiles |
| 2 lines inserted at the top (everything shifted) | applies (offset only) |
| a line *outside* every hunk's context changed (`key_repeat_tick = 0.025`) | applies, correctly: the patch doesn't depend on it |
| `asyncio.sleep(self.key_repeat_tick)` → `… * 1` (inside a hunk) | **fails**, names the hunk; file untouched |
| `logger_webrtc_input.error(` → `.exception(` in `on_message` (context of hunk 5) | **fails**, file untouched |
| patch applied twice | **fails** |

What a Renovate base bump then looks like:
- Same code around the hunks: the build applies the patch and CI's `input` spec confirms it still works.
- Changed code: the `build` job fails at the patch step and nothing is published. Re-read the two loops and `on_message`, check that held state is still only added from client messages (§1), and regenerate the patch (its header says the same).
- The base moves to the Rust server: `find_spec("selkies")` or the patch fails. Then drop the patch, or file it upstream / port it there.

## 5. Measurements

Two containers from the same commit, unpatched and patched, run at the same time, `CP_PRINTER=Creality K1C`, no client connected, after the app's main window was up and a few minutes of settling. Wakeups are voluntary + nonvoluntary context switches per thread from `/proc/<pid>/task/<tid>/status`, between two snapshots about 75 s apart. CPU is the container cgroup's `usage_usec` read from the host (nothing running in the container), 60 s windows [V].

App running:

| | Unpatched | Patched |
|---|---|---|
| Selkies main threads (`selkies`) | 65.5 wakeups/s, 0.87 % | **5.6 wakeups/s, 0.07 %** |
| Whole container, wakeups | 113/s | **50/s** |
| Whole container, CPU (2 windows) | 2.12 %, 2.28 % | **1.48 %, 1.62 %** |

App closed (SIGTERM to `CrealityPrint`, 30 s pause; the state `IDLE_QUIT` leaves the container in):

| | Unpatched | Patched |
|---|---|---|
| Whole container, wakeups | 70.9/s (selkies 68.4, `pf-dc-watch` 2.0, labwc 0.5) | **8.1/s** (selkies 5.6, `pf-dc-watch` 2.0, labwc 0.5) |
| Whole container, CPU (2 windows) | 0.48 %, 0.49 % | **0.05 %, 0.05 %** |

- The patch saves about 0.65 % of a core and 60 wakeups/s whether or not the app runs.
- Together with `IDLE_QUIT` the container drops from about 2.2 % to about 0.05 % of a core when nobody is connected.

## 6. Tests

- **`tests/e2e/input.spec.js`** (its own CI matrix job, about 35 s locally), one container:
  1. with no client connected, the Selkies process (all threads, per-thread deltas over 5 s) must get down to at most 25 wakeups/s within 2 minutes;
  2. opens a session and sends a raw `kd,65505` (Shift_L) on the client's WebSocket (`window.selkiesTransport`), with no key-up and no heartbeats, like a lost key-up. Selkies must log `Auto-releasing key 65505 (heartbeat lost).`: the parked sweep woke up and released it. Shift_L is a modifier, so the repeat loop leaves it alone and the sweep is its only releaser;
  3. after the page leaves, the rate must drop back under the limit.
- Results [V]: patched 8–10/s before any client, the key released, 49 then 7/s after the client left. **Unpatched: fails at step 1** with 24 samples between 66 and 71/s.
- `clipboard.spec.js` (types Ctrl+V and Ctrl+C into the session) passes on the patched image [V].
- The full e2e suite (13 tests, GPU spec included) and the smoke test pass on the patched image [V].
- X11 mode (`PIXELFLUX_WAYLAND=false`), where the repeat loop also does key repeat, checked with throwaway specs (not kept) [V]:
  - the `input` spec passes: 4 wakeups/s before any client, the key released, 33 then 3/s after the client left;
  - holding `f` in the browser for 1.5 s, 35 s after connecting (loops parked again), gave 42 XTEST key presses on `:1` patched and 44 unpatched (counted as XInput2 raw key events with Selkies' vendored python-xlib), against none without a key held. So key repeat works the same after a wake.
- Not tested hands-on: gamepads. Their only loop state is `gamepad_heartbeats`, added from `js,h` client messages like keys (§1) [I].

## 7. Licence

Selkies is MPL-2.0 (file-level copyleft). The modified file stays MPL-2.0, ships as source in the image, and the patch is in this repository.
