# 15 — Sharp UI on HiDPI screens (`CP_UI_SCALE`)

Date: 2026-11-22 · Host: Docker 29, x86_64, Arch Linux kernel 7.3.5, Intel UHD 630 · Image: `ghcr.io/micdah/docker-crealityprint:latest` (Creality Print 7.3.2, Selkies base `debiantrixie`, labwc 0.9.7)

This doc covers why Selkies' "UI Scaling" makes Creality Print blurry, what makes it sharp instead, and the opt-in `CP_UI_SCALE` setting that came out of it.

Legend: **[V]** = verified by running it or reading the source, **[I]** = inferred.

## Summary

- On a HiDPI screen, Selkies at 100 % gives a sharp but tiny UI. Raising Selkies' **UI Scaling** makes the UI bigger but **blurry**.
- **Cause:** in Wayland mode, Selkies applies UI Scaling as the **labwc output scale**. Creality Print is an **Xwayland** client (`GDK_BACKEND=x11`), and labwc draws X11 windows at scale 1 and **stretches the bitmap** [V, §1].
- **Fix:** leave Selkies at 100 % (the remote desktop then already has the browser's full device resolution) and let **GTK draw the app at 2x** with `GDK_SCALE=2`. Everything comes out sharp: the GTK widgets, the icons, the WebKit pages (home, Device, the printer picker) and the 3D view with its ImGui overlays. Mouse picking in the 3D view stays correct [V, §2].
- **Fractional scales don't work well** [V, §2]:
  - `GDK_DPI_SCALE` alone enlarges only text and leaves icons at 1x.
  - `GDK_SCALE=2` with `GDK_DPI_SCALE=0.75` is sharp, but it is still a 2x layout with smaller text, so it gives back almost no space.
- **Shipped:** `CP_UI_SCALE` takes a whole number from 1 to 4. The launcher turns it into `GDK_SCALE`, and the config init logs the result or rejects an invalid value. It is off by default (§3).

---

## 1. Why Selkies' UI Scaling is blurry

Selkies source: `/lsiopy/lib/python3.13/site-packages/selkies` in the image.

- The browser's DPI choice arrives in `handle_scaling()` (`webrtc_mode.py`, about line 2760). In X11 mode it runs `set_dpi()`, which updates xrdb `Xft.dpi` and xsettingsd. In **Wayland mode** it skips those and calls `_realize_wayland_dpi()` [V].
- `_realize_wayland_dpi()` calls `InputHandler.realize_wayland_dpi()` (`input_handler.py`, about line 7574). That sets the nested session compositor's (labwc's) **output scale to DPI/96** and leaves the capture at scale 1.0 [V]. Its docstring says it directly: "XWayland applications need nothing merged: they run in the compositor's logical space and are scaled with it."
- The image runs Creality Print with `GDK_BACKEND=x11` (copied from orcaslicer; native Wayland GTK + wxGL is fragile, [09](09-roadblocks-and-risks.md)). The app is therefore an X11 client on labwc's Xwayland `:0`. labwc gives X11 clients no HiDPI path: they render at scale 1, and the compositor upscales their buffer to the output scale. labwc 0.9.7 has no option to stop scaling Xwayland (the binary contains no such setting) [V].
- At Selkies 100 % the remote desktop already matches the client's size × devicePixelRatio, e.g. 3200×1800 for a 1600×900 viewport at DPR 2 ([07](07-hands-on-baseline.md)) [V]. The only thing missing is an app that draws itself bigger.

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
- At 1280×720 (the e2e spec's page) panels overlap the 3D view.
- Creality Print itself needs about 1600×900 logical pixels, whatever the scale.

The labwc window title bar stays at 1x (thin). The app runs maximised, so this barely matters [V].

## 3. Design: `CP_UI_SCALE`

- **Opt-in env var, whole numbers 1–4.**
  - `root/usr/local/bin/crealityprint`, the stable launcher, exports `GDK_SCALE=<n>` when `CP_UI_SCALE` is 2–4.
  - Every start goes through this launcher (autostart, the desktop menu, the idle-quit restart), and it reads the container env on each launch.
  - If `CP_UI_SCALE` is unset, empty or 1, the launcher leaves `GDK_SCALE` alone, so a user's own `GDK_SCALE` still passes through.
- **Logged at init.** The launcher's output doesn't reach `docker logs` (the idle restart sends it to `/dev/null`). So `init-crealityprint-config` repeats the same check once per start:
  - it logs `UI scale <n>: keep Selkies' UI Scaling at 100 % …`;
  - or, for an invalid value such as `1.5` or `abc`, `ignoring CP_UI_SCALE=…`. The app then gets no scale from it, but a `GDK_SCALE` the user set still applies.
  - For `1` it logs nothing, because `1` changes nothing.
- **Whole numbers only.** GTK3 has no fractional widget scale, and §2 shows that the fractional workarounds look worse than a whole number. Users can still pass `GDK_DPI_SCALE` (e.g. `0.85`) next to `CP_UI_SCALE=2` to make the text a little smaller.
- **Selkies' DPI is not locked.** The image leaves `SELKIES_SCALING_DPI` alone. The README tells users to keep Selkies at 100 %; Selkies at 200 % on top of `CP_UI_SCALE=2` would draw 4x and blur again.
- **Selkies' "HiDPI (Pixel Perfect)" must stay on** (sidebar, Screen Settings; on by default, which is why the spike got a 3200×1800 desktop [V]). With it off, Selkies streams at CSS resolution and the browser upscales [I, from the label and its "Scale Locally" neighbour].
- **Per container, not per browser.** Every client gets the same app scale, so a 1x monitor also sees the larger UI. Following Selkies' slider instead would need a hook into Selkies internals plus an app restart on every change. Rejected as fragile across base-image updates.
- A change needs the container re-created (`docker compose up -d`); `docker restart` keeps the old environment. Every later app start, the idle-quit restart included, uses the same value [V: after an idle close and reconnect the new app process had `GDK_SCALE=2`].
- **Tests:** `tests/e2e/scale.spec.js`, CI matrix job `scale`, has two tests:
  - `CP_UI_SCALE=2` → the init log line, `GDK_SCALE=2` in the app process, and a screenshot at devicePixelRatio 2.
  - `CP_UI_SCALE=1.5` with a user `GDK_SCALE=3` → the "ignoring" log line, and the user's `GDK_SCALE` reaching the app unchanged.
