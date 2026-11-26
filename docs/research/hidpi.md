# Sharp UI on HiDPI screens (CP_UI_SCALE)

Why Selkies' own UI Scaling makes Creality Print blurry on a HiDPI screen, how the opt-in `CP_UI_SCALE` draws it sharp instead, and what that costs. Users' view: the "Sharp UI on HiDPI screens" section of [../../README.md](../../README.md). Research index: [README.md](README.md).

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.
Verified against: Creality Print 7.3.2, selkies 2.2.1, labwc 0.9.7, base image `debiantrixie`; Playwright Chromium at devicePixelRatio 1, 1.5 and 2; Intel UHD 630 host; plus `scale.spec.js`, which runs on every build.

- **Selkies' UI Scaling blurs this app.** In Wayland mode Selkies applies it as labwc's output scale, and labwc stretches an Xwayland window as a bitmap [V].
- **A fresh HiDPI browser starts at UI Scaling 200 %.** The web client derives its DPI from `devicePixelRatio` [V]. So without `CP_UI_SCALE`, on a 200 % screen, the app is a 1x picture stretched 2x (soft).
- **`CP_UI_SCALE=2` (whole numbers 1–4) makes GTK draw the app at 2x** (`GDK_SCALE`), and the image pins Selkies' DPI at 96 (UI Scaling 100 %) unless the user set `SELKIES_SCALING_DPI`. The desktop then has the browser's full device resolution, and GTK widgets, icons, WebKit pages and the 3D view are sharp, with correct mouse picking [V].
- **Costs:** the app needs about 1600×900 CSS px of browser window, every browser gets the same scale, and without a GPU the 3D view costs more CPU (full-resolution rendering). Off by default.

## Why Selkies' UI Scaling is blurry

- The browser's DPI reaches Selkies' `handle_scaling()`. In X11 mode it sets `Xft.dpi` and xsettingsd; in Wayland mode it calls `realize_wayland_dpi()`, which sets the nested compositor's (labwc's) **output scale to DPI/96** and leaves the capture at scale 1 [V, source]. Its docstring: "XWayland applications need nothing merged: they run in the compositor's logical space and are scaled with it."
- The app runs with `GDK_BACKEND=x11` (why: [decisions.md](decisions.md)), so it is an X11 client on labwc's Xwayland `:0`. labwc renders X11 clients at scale 1 and upscales their buffer to the output scale; 0.9.7 has no option to turn that off [V].
- **The web client's default DPI** is `round(devicePixelRatio × 4) × 24`, snapped to the nearest step: DPR 2 gives 192 (200 %), DPR 1.5 gives 144 [V, `selkies-core.js`]. A fresh DPR-2 client at 1600×900 gets a 3200×1800 stream, labwc output scale 2, and Xwayland at **1600×900** (`xdpyinfo`) [V].
- A user's pick of 100 % in the sidebar is kept only in that browser's `localStorage`, per origin. The server doesn't remember it and no URL parameter sets it, so every new browser, profile or device starts at 200 % again [V].
- **At UI Scaling 100 %** the desktop matches the browser window's CSS size × devicePixelRatio (3200×1800 for 1600×900 at DPR 2) [V]. All that is missing is an app that draws itself larger, which is what `GDK_SCALE` does.
- **"HiDPI (Pixel Perfect)" must stay on** (sidebar, Screen Settings; the default). With it off the desktop is the CSS size and the browser stretches it [V].
- Rust Selkies (base `dev`) has the same model: pixelflux pins Xwayland clients to scale 1 and applies the DPI as output scale, and `SELKIES_SCALING_DPI=96` works there too [V, hands-on port]. `scale.spec.js` hasn't been run on it yet.

## What the image does

- **Launcher** (`/usr/local/bin/crealityprint`, `apply_ui_scale`): when `CP_UI_SCALE` is `2`, `3` or `4`, it exports `GDK_SCALE` with that value. Unset, empty, `1` or anything else leaves `GDK_SCALE` alone, so a user's own `GDK_SCALE` passes through [V, code and e2e]. Every start goes through it (autostart, menus, the idle-quit restart), so every app start uses the container's value [V: after an idle close and reconnect the new app had `GDK_SCALE=2`].
- **Init** (`init-crealityprint-config`, `configure_ui_scale` and `pin_selkies_dpi`) repeats the launcher's check, because the launcher's output never reaches `docker logs` (see [base-image.md](base-image.md)). For 2–4, unless `SELKIES_SCALING_DPI` is already set, it writes `96` to `/run/s6/container_environment/SELKIES_SCALING_DPI` [V, code and e2e].
  - The init finishes before `init-config-end`, so before `svc-selkies` starts. That service is `with-contenv`, so Selkies gets the value [V].
  - s6 rebuilds `container_environment` from the container's environment on every start, also after `docker restart`. The 96 of one start therefore never reaches the next, where it would look like the user's value [V, e2e].
- **What Selkies does with it:** it treats an operator-set `scaling_dpi` as locked (`OPERATOR_LOCKED_WHEN_OVERRIDDEN` in `settings.py`), keeps output scale 1, and hides the UI Scaling select in the sidebar [V, source and e2e]. It also logs `Client value for 'scaling_dpi' ('192') is not in the allowed list ['96']. Using server default '96'.`, which is harmless [V].

Init log lines, each prefixed `[crealityprint-init]` [V, code]:

| `CP_UI_SCALE` | `SELKIES_SCALING_DPI` | Logged |
|---|---|---|
| unset, empty or `1` | any | nothing; Selkies keeps following the browser |
| `2`–`4` | unset | `UI scale <n>: Selkies' UI Scaling fixed at 100 % (SELKIES_SCALING_DPI=96) …` |
| `2`–`4` | set by the user | `UI scale <n>: keeping your SELKIES_SCALING_DPI=<v>`, plus `; the app is only sharp at 96` when it isn't 96 |
| `2`–`4` | unset, but the write fails | `UI scale <n>: could not set SELKIES_SCALING_DPI=96 …; on a HiDPI browser the app may be blurry` |
| anything else (`1.5`, `abc`) | any | `ignoring CP_UI_SCALE=<v>: use a whole number from 1 to 4 (e.g. 2)`; nothing is pinned |

## What was tested

GTK3 app with WebKitGTK 4.1, `CP_PRINTER=Creality K1C`, GPU passed through, Selkies at 100 %; Playwright Chromium at DPR 2 with 1600×900 and 1920×1080 windows (3200×1800 and 3840×2160 desktops). The variables reached the app process (`/proc/<pid>/environ`) [V].

| Variant | Result [V] |
|---|---|
| none | Sharp, but a 1x UI on a 3840×2160 desktop: tiny |
| `GDK_SCALE=2` | Everything 2x and sharp: GTK widgets, SVG icons, the top bar, the ImGui view cube and plate toolbar, the WebKit Device page and printer picker. Laid out like a 1920×1080 1x screen |
| `GDK_DPI_SCALE=1.5` | Text 1.5x, icons and toolbars 1x. Sharp, but the sizes don't match |
| `GDK_SCALE=2 GDK_DPI_SCALE=0.75` | Sharp; widgets and icons 2x, text about 1.5x. Panels stay almost as wide as at 2x, so it saves little space |

- **3D view at `GDK_SCALE=2`** [V]: the GL canvas fills its area at device resolution (not the quarter-size viewport that is the usual GTK3 HiDPI bug in Prusa-family forks). Wheel zoom works. Hover-then-click on a cube selects it; a click about 35 CSS px beside it selects nothing; right-click opens the object menu at the pointer; dragging moves the cube with the pointer. The unscaled baseline behaves the same.
- **Sharpness**: on a 1:1 device-pixel crop of the "Process" header at the same on-screen size, an edge measure of about 3850 when stretched against about 5860 when drawn at 2x on the full-resolution desktop [V].
- **Not checked**: the slice preview's legend and layer slider, and the fixed-size dialogs of #589/#654 (see [app.md](app.md)). The printer picker and context menus were fine.
- The labwc title bar stays at 1x (thin). The app runs maximized, so it barely matters [V].

Effect of the DPI pin by client (1600×900 CSS window) [V]:

| Client | Without `CP_UI_SCALE` (Selkies follows the browser) | With `CP_UI_SCALE=2` (DPI pinned at 96) |
|---|---|---|
| DPR 1 | Xwayland 1600×900, scale 1 | Xwayland 1600×900, unchanged; the app is 2x the usual size |
| DPR 1.5 | Xwayland 1600×900, output scale 1.5 (stretched) | Xwayland 2400×1350, scale 1; the app about 1.33x the usual CSS size, sharp |
| DPR 2 | Xwayland 1600×900, output scale 2 (stretched) | Xwayland 3200×1800, scale 1, sharp |

## Caveats

- **Window size.** At scale 2 the app has as many logical pixels as the browser window has CSS pixels on a DPR-2 screen [V]. Creality Print needs about 1600×900 logical, whatever the scale: 1920×1080 is comfortable, at 1600×900 the canvas is narrow and the top toolbar collapses into a scroller, and at 1280×720 panels overlap the 3D view [V]. On a DPR-1 screen scale 2 halves the logical size, so it needs a 3200×1800 window [I, from the table above].
- **Per container, not per browser.** Every client gets the same app scale and Selkies DPI. Following each browser's slider would need a hook into Selkies internals plus an app restart on every change.
- **The 3D view starts zoomed far out** (a tiny plate) at scale 2 or more [V]. Before any browser connects, Xwayland is 1024×768 [V], so at 2x the app starts in a 512×384 logical window; that it fits its camera to that canvas and keeps the zoom when the desktop grows is [I]. The stretched default shows the same. The README says to zoom in with the wheel. A real fix (a larger startup desktop, or re-fitting the camera on the first connect) is open.
- **Applies at app start.** A changed value needs a re-create (`docker compose up -d`); `docker restart` keeps the old environment [V].
- **Text size:** `GDK_DPI_SCALE` (e.g. `0.85`) next to `CP_UI_SCALE=2` shrinks text only; icons stay 2x [V, the variant table].
- **Set `CP_UI_SCALE`, not a bare `GDK_SCALE`.** A user's `GDK_SCALE` reaches the app but doesn't pin the DPI [V, code]. A HiDPI browser then gets the 2x app stretched another 2x: about 4x and blurry [V with `CP_UI_SCALE=2` and a forced `SELKIES_SCALING_DPI=192`; the same for a bare `GDK_SCALE` is I]. A bare `GDK_SCALE` needs `SELKIES_SCALING_DPI=96` next to it.

## CPU cost of full-resolution rendering

With the DPI pinned, the app renders its 3D view at full device resolution. Setup [V]:

- Workload: orbiting a 638k-triangle sphere with a **right-drag** (a left-drag on empty space draws a selection box instead).
- One browser at 1600×900 and DPR 2; a local build of the image; 16-thread host (i9-9900K) with Intel UHD 630.
- Container CPU read from `docker stats` mid-orbit. Repeats and the orbit's path weren't recorded, so treat the figures as rough.

| | No GPU (llvmpipe + x264) | `/dev/dri` (Intel UHD 630) |
|---|---|---|
| Default: Xwayland 1600×900, stretched to 3200×1800 | ~2.6 cores | ~0.6–1.1 cores |
| `CP_UI_SCALE=2`: Xwayland 3200×1800 | ~4.3 cores with the plate small in the view, ~7.3 cores with it filling the view | ~0.5–0.6 cores |

- Without a GPU the cost grows with the pixels the app renders; with one it stays flat [V].
- [gpu.md](gpu.md)'s "Window size" series (about 3.3 cores without a GPU, 0.53 with one, at a 3200×1800 stream) ran without `CP_UI_SCALE` and from fresh browsers, so its app most likely rendered at 1600×900, as in the default row above [I]. Its finding that window size hardly matters is about the stream size, not the app's render size. Its baseline is higher than ~2.6 because of a different orbit; compare only within one series.

## Tests

`tests/e2e/scale.spec.js` (CI matrix job `scale`), a fresh Chromium context at 1600×900 and DPR 2, so the Selkies client asks for 200 % [V, code]:

- `CP_UI_SCALE=2`: the "fixed at 100 %" init line, `96` in `/run/s6/container_environment/SELKIES_SCALING_DPI`, `GDK_SCALE=2` in the app process, **Xwayland `:0` at 3200×1800** (`xdpyinfo`) once a browser is connected, a screenshot, and no UI Scaling select (by id and by label) in Screen Settings while "HiDPI (Pixel Perfect)" is there.
- `CP_UI_SCALE=2`, then `docker restart`: two "fixed at 100 %" lines, no "keeping your …" line, and still `96`.
- `CP_UI_SCALE=2` with `SELKIES_SCALING_DPI=144`: kept, logged with the "only sharp at 96" hint.
- `CP_UI_SCALE=1.5` with a user `GDK_SCALE=3`: the "ignoring" line, no DPI file written, and `GDK_SCALE=3` reaching the app unchanged.
- `watcher.spec.js`'s default-settings test checks that with `CP_UI_SCALE` unset nothing is logged and no DPI is written.
- In the 3D view the app picks on hover: a bare Playwright `mouse.click()` doesn't select an object, even unscaled. Move the pointer there and wait first [V].
