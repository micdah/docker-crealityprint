# 15 — Sharp UI on HiDPI screens (`CP_UI_SCALE`)

Date: 2026-11-22 · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, Intel UHD 630 · Image: `ghcr.io/micdah/docker-crealityprint:latest` (Creality Print 7.3.2, Selkies base `debiantrixie`, labwc 0.9.7)

This doc covers why Selkies' "UI Scaling" makes Creality Print blurry, what makes it sharp instead, and the opt-in `CP_UI_SCALE` setting that came out of it. §4 (added later the same day) corrects a wrong premise: Selkies does not default to 100 % on a HiDPI browser, so the image now fixes Selkies' DPI itself.

Legend: **[V]** = verified by running it or reading the source, **[I]** = inferred.

## Summary

- On a HiDPI screen, Selkies at 100 % gives a sharp but tiny UI. Raising Selkies' **UI Scaling** makes the UI bigger but **blurry**.
- **Cause:** in Wayland mode, Selkies applies UI Scaling as the **labwc output scale**. Creality Print is an **Xwayland** client (`GDK_BACKEND=x11`), and labwc draws X11 windows at scale 1 and **stretches the bitmap** [V, §1].
- **Fix:** Selkies at 100 % (the remote desktop then already has the browser's full device resolution) and **GTK draws the app at 2x** with `GDK_SCALE=2`. Selkies only sits at 100 % on a HiDPI browser if someone picks it, so the image now pins it with `SELKIES_SCALING_DPI=96` while `CP_UI_SCALE` is set (§4). Everything comes out sharp: the GTK widgets, the icons, the WebKit pages (home, Device, the printer picker) and the 3D view with its ImGui overlays. Mouse picking in the 3D view stays correct [V, §2].
- **Fractional scales don't work well** [V, §2]:
  - `GDK_DPI_SCALE` alone enlarges only text and leaves icons at 1x.
  - `GDK_SCALE=2` with `GDK_DPI_SCALE=0.75` is sharp, but it is still a 2x layout with smaller text, so it gives back almost no space.
- **Shipped:** `CP_UI_SCALE` takes a whole number from 1 to 4. The launcher turns it into `GDK_SCALE`, and the config init logs the result or rejects an invalid value. It is off by default (§3). The init also sets `SELKIES_SCALING_DPI=96` unless the user set it (§4).

---

## 1. Why Selkies' UI Scaling is blurry

Selkies source: `/lsiopy/lib/python3.13/site-packages/selkies` in the image.

- The browser's DPI choice arrives in `handle_scaling()` (`webrtc_mode.py`, about line 2760). In X11 mode it runs `set_dpi()`, which updates xrdb `Xft.dpi` and xsettingsd. In **Wayland mode** it skips those and calls `_realize_wayland_dpi()` [V].
- `_realize_wayland_dpi()` calls `InputHandler.realize_wayland_dpi()` (`input_handler.py`, about line 7574). That sets the nested session compositor's (labwc's) **output scale to DPI/96** and leaves the capture at scale 1.0 [V]. Its docstring says it directly: "XWayland applications need nothing merged: they run in the compositor's logical space and are scaled with it."
- The image runs Creality Print with `GDK_BACKEND=x11` (copied from orcaslicer; native Wayland GTK + wxGL is fragile, [09](09-roadblocks-and-risks.md)). The app is therefore an X11 client on labwc's Xwayland `:0`. labwc gives X11 clients no HiDPI path: they render at scale 1, and the compositor upscales their buffer to the output scale. labwc 0.9.7 has no option to stop scaling Xwayland (the binary contains no such setting) [V].
- At Selkies 100 % the remote desktop already matches the client's size × devicePixelRatio, e.g. 3200×1800 for a 1600×900 viewport at DPR 2 [V]. The only thing missing is an app that draws itself bigger. (Not the default on a HiDPI browser, see §4. [07](07-hands-on-baseline.md)'s 3200×1800 was most likely the stream size at output scale 2, not Xwayland's [I].)

## 2. Spike: GTK scaling in the app

Setup [V]:
- Four containers from the published image, each with `CP_PRINTER=Creality K1C` and the GPU passed through. One was the baseline; the other three each had one of the env variants below, passed straight to the container. The variables reach the app process: checked in `/proc/<pid>/environ`.
- Driven by Playwright (Chromium) at `deviceScaleFactor: 2`, first with a 1600×900 viewport (3200×1800 desktop), then 1920×1080 (3840×2160, a 4K monitor at 200 %). Selkies UI Scaling was left at 100 %.
- The app is GTK3 with WebKitGTK 4.1 (`ldd /opt/crealityprint/bin/CrealityPrint`).

| Variant | Result |
|---|---|
| baseline (no scaling) | Sharp, but a 1x UI on a 3840×2160 desktop: tiny |
| `GDK_SCALE=2` | **Everything 2x and sharp.** GTK widgets, SVG icons, the top bar, the ImGui view cube and plate toolbar, the WebKit Device page and the WebKit printer picker. The layout is that of a 1920×1080 1x screen |
| `GDK_DPI_SCALE=1.5` | Text 1.5x, icons and toolbar 1x. Sharp, but the sizes don't match |
| `GDK_SCALE=2 GDK_DPI_SCALE=0.75` | Sharp. Widgets and icons 2x, text about 1.5x. Panel widths stay close to the 2x variant, so it saves little space |

3D view checks with `GDK_SCALE=2` [V]:
- The GL canvas fills its area and renders at device resolution. It is not a quarter-size viewport, the usual GTK3 HiDPI bug in Prusa-family forks.
- Wheel zoom works.
- Hover-then-click on the cube selects it, and the object info panel appears.
- Clicking about 35 CSS px beside the cube selects nothing.
- Right-click on the cube opens the object context menu at the pointer.
- Dragging the selected cube moves it with the pointer.
- The same click test on the unscaled baseline behaves the same.

Testing notes:
- A bare Playwright `mouse.click()` doesn't select an object, even unscaled. The app picks on hover, so the pointer has to move there and wait first.
- The app keeps its window layout between browser connections, but the layout changes when the viewport size changes. Measure positions from a screenshot of the same layout.

Not checked: the slice preview's legend and layer slider, and every fixed-size dialog (#589/#654). The printer picker and context menus were fine.

Window size [V]:
- At scale 2, the app lays out in the browser window's CSS size, exactly as with Selkies' 200 %.
- 1920×1080 is comfortable.
- At 1600×900 the canvas is narrow and the top toolbar collapses into a scroller.
- At 1280×720 (the e2e spec's page until §4) panels overlap the 3D view.
- Creality Print itself needs about 1600×900 logical pixels, whatever the scale.

The labwc window title bar stays at 1x (thin). The app runs maximised, so this barely matters [V].

## 3. Design: `CP_UI_SCALE`

- **Opt-in env var, whole numbers 1–4.**
  - `root/usr/local/bin/crealityprint`, the stable launcher, exports `GDK_SCALE=<n>` when `CP_UI_SCALE` is 2–4.
  - Every start goes through this launcher (autostart, the desktop menu, the idle-quit restart), and it reads the container env on each launch.
  - If `CP_UI_SCALE` is unset, empty or 1, the launcher leaves `GDK_SCALE` alone, so a user's own `GDK_SCALE` still passes through.
- **Logged at init.** The launcher's output doesn't reach `docker logs` (the idle restart sends it to `/dev/null`). So `init-crealityprint-config` repeats the same check once per start:
  - it logs `UI scale <n>: …` (since §4: `Selkies' UI Scaling fixed at 100 % (SELKIES_SCALING_DPI=96) …`, or `keeping your SELKIES_SCALING_DPI=…`);
  - or, for an invalid value such as `1.5` or `abc`, `ignoring CP_UI_SCALE=…`. The app then gets no scale from it, but a `GDK_SCALE` the user set still applies.
  - For `1` it logs nothing, because `1` changes nothing.
- **Whole numbers only.** GTK3 has no fractional widget scale, and §2 shows that the fractional workarounds look worse than a whole number. Users can still pass `GDK_DPI_SCALE` (e.g. `0.85`) next to `CP_UI_SCALE=2` to make the text a little smaller.
- ~~**Selkies' DPI is not locked.**~~ **Reversed in §4.** This version left `SELKIES_SCALING_DPI` alone and told users to keep Selkies at 100 %. But a HiDPI browser starts at 200 %, and Selkies at 200 % on top of `CP_UI_SCALE=2` draws 4x and blurs again.
- **Selkies' "HiDPI (Pixel Perfect)" must stay on** (sidebar, Screen Settings; on by default, which is why the spike got a 3200×1800 desktop [V]). With it off, Selkies streams at CSS resolution and the browser upscales [I, from the label and its "Scale Locally" neighbour].
- **Per container, not per browser.** Every client gets the same app scale, so a 1x monitor also sees the larger UI. Following Selkies' slider instead would need a hook into Selkies internals plus an app restart on every change. Rejected as fragile across base-image updates.
- A change needs the container re-created (`docker compose up -d`); `docker restart` keeps the old environment. Every later app start, the idle-quit restart included, uses the same value [V: after an idle close and reconnect the new app process had `GDK_SCALE=2`].
- **Tests** (as first shipped; updated in §4): `tests/e2e/scale.spec.js`, CI matrix job `scale`, has two tests:
  - `CP_UI_SCALE=2` → the init log line, `GDK_SCALE=2` in the app process, and a screenshot at devicePixelRatio 2.
  - `CP_UI_SCALE=1.5` with a user `GDK_SCALE=3` → the "ignoring" log line, and the user's `GDK_SCALE` reaching the app unchanged.

## 4. Addendum (2026-11-22): Selkies' default DPI follows the browser

Found hands-on in a later session, on both the current Python base (Selkies 2.2.1) and the Rust Selkies `dev` base; re-checked here on a local build of this change. Client: Playwright Chromium, a fresh context (empty localStorage), 1600×900 at devicePixelRatio 2.

### What §1–§3 got wrong

- **A fresh HiDPI browser starts at UI Scaling 200 %, not 100 %** [V]. The Selkies web client derives its default DPI from `devicePixelRatio`: `autoScalingDpi()` = `snapDpi(round(DPR × 4) × 24)`, so DPR 2 gives 192 and DPR 1.5 gives 144 (Rust `web/selkies-web-core/lib/stream-density.ts` L73–76; the same function is in the minified Python `selkies-core.js`). The sidebar shows UI Scaling 200 % with HiDPI (Pixel Perfect) on.
- The result is a 3200×1800 stream at labwc output scale 2 with Xwayland `:0` at **1600×900** (`DISPLAY=:0 xdpyinfo`) [V]. Without `CP_UI_SCALE` the app is a 1x bitmap stretched 2x (slightly soft). **With `CP_UI_SCALE=2` it is drawn 2x and stretched 2x again: about 4x and blurry** [V, reproduced here with a forced `SELKIES_SCALING_DPI=192`].
- A user's pick of 100 % in the sidebar is stored in that browser's **localStorage**, per origin (`<prefix>_scaling_dpi`). The server doesn't remember it, so every new browser, profile or device starts at 200 % again, and no URL parameter sets it [V]. Turning HiDPI (Pixel Perfect) off doesn't help: the desktop becomes 1600×900 and the browser stretches it [V].
- Why §2's spike saw 100 % is unknown. A fresh Playwright context starts with empty localStorage, so it would have had to reuse a persistent profile that had 96 stored [I].

### Design change

- **`init-crealityprint-config` sets `SELKIES_SCALING_DPI=96` when `CP_UI_SCALE` is 2–4 and the user hasn't set `SELKIES_SCALING_DPI`** [V]. It writes the value to `/run/s6/container_environment`, as `init-crealityprint-idle` does for the Selkies hooks.
  - Order: the init is a dependency of `init-config-end`, which comes before `init-mods` → … → `init-services` → `svc-selkies`. `svc-selkies/run` is a `with-contenv` script that execs `selkies`, so the value is in Selkies' environment [V, base image s6 tree].
  - Selkies treats an operator-set `scaling_dpi` as locked (`settings.py` `OPERATOR_LOCKED_WHEN_OVERRIDDEN`). It logs `Client value for 'scaling_dpi' ('192') is not in the allowed list ['96']. Using server default '96'.` (harmless), keeps output scale 1, and the dashboard hides the UI Scaling select [V].
  - A `docker restart` needs no cleanup. `/run` itself survives it (Docker doesn't mount a tmpfs there), but s6 rebuilds `/run/s6/container_environment` from the container's environment on every start, so the 96 of one start never reaches the next one, where it would look like the user's setting [V: a file in `/run` survived the restart, the `container_environment` directory was new, and the log holds two "fixed at 100 %" lines and no "keeping your …" line]. An earlier draft kept a marker file for this; it turned out to be dead code. The same held for `init-crealityprint-idle`, which also removed its own Selkies hooks at every start; that is gone too, and only its runtime dir in `/run` still needs (and gets) its own cleanup ([13 §3.2](13-idle-quit.md)).
  - A user's own `SELKIES_SCALING_DPI` is kept and logged (`keeping your SELKIES_SCALING_DPI=…`, plus a hint when it isn't 96).
  - Unset, empty, `1` or invalid `CP_UI_SCALE`: nothing changes; Selkies keeps following the browser.
- §3's "per container, not per browser" now also covers Selkies' DPI: every client gets scale 1.

### Effects [V, local build, Intel UHD 630 host]

| Client | Without `CP_UI_SCALE` (Selkies follows the browser) | With `CP_UI_SCALE=2` (DPI pinned at 96) |
|---|---|---|
| DPR 1, 1600×900 | Xwayland 1600×900, scale 1 | Xwayland 1600×900: unchanged (96 is already its default) |
| DPR 1.5, 1600×900 | Xwayland 1600×900, scale 1.5 (stretched) | Xwayland 2400×1350, scale 1; the app is 2x physical, about 1.33x CSS size |
| DPR 2, 1600×900 | Xwayland 1600×900, scale 2 (stretched) | Xwayland 3200×1800, scale 1, sharp |

- Sharpness (from the hidden-premise session, on the "Process" header at the same on-screen size, 1:1 device-pixel crops): an edge measure of about 3850 for the stretched picture against about 5860 when the app draws at 2x on the full-resolution desktop.
- **CPU.** The app now renders its 3D view at full device resolution. Container CPU while orbiting (right-drag; left-drag on empty space draws a selection box in this app) a 638k-triangle sphere, 1600×900 at DPR 2, `docker stats` mid-orbit, 16-core host:

  | | No GPU (llvmpipe + x264) | `/dev/dri` (Intel UHD 630) |
  |---|---|---|
  | Default (Xwayland 1600×900, stretched to 3200×1800) | ~2.6 cores | ~0.6–1.1 cores |
  | `CP_UI_SCALE=2` (Xwayland 3200×1800) | ~4.3 cores with the plate small in the view, ~7.3 cores with it filling the view | ~0.5–0.6 cores |

  Without a GPU the cost grows with the rendered pixels; with one it stays flat, as in [04](04-gpu-acceleration.md). [12 §4](12-remaining-hands-on.md)'s ~7 cores came from the default (stretched) state, which costs ~2.6 cores here. That gap is not explained: 12 used left-drag (probably a selection box here too) and a different browser build [I].
- The 3D view starts **zoomed far out** (a tiny plate) with `CP_UI_SCALE` 2 or more [V]. Before any browser connects the desktop is 1024×768, so at 2x the app starts in a 512×384 logical window, fits its camera to that tiny canvas and keeps the zoom when the desktop grows. The old (stretched) setup shows the same, so this change didn't cause it. The README tells users to zoom in with the wheel. A real fix (e.g. a larger startup desktop, or re-fitting the camera on the first connect) is open.

### Tests

`tests/e2e/scale.spec.js` now checks the picture, not only the environment:
- `CP_UI_SCALE=2` with a fresh DPR-2 client at 1600×900: the init log line, `SELKIES_SCALING_DPI=96` in `/run/s6/container_environment`, `GDK_SCALE=2` in the app, **Xwayland `:0` at 3200×1800** (`xdpyinfo`), and no UI Scaling select in the sidebar's Screen Settings.
- `CP_UI_SCALE=2`, then `docker restart`: two "fixed at 100 %" lines, no "keeping your …" line, and 96 in the container environment.
- `CP_UI_SCALE=2` with `SELKIES_SCALING_DPI=144`: kept and logged.
- The invalid-value case also checks that no `SELKIES_SCALING_DPI` was written. `watcher.spec.js`'s default-settings test checks the same with `CP_UI_SCALE` unset.
