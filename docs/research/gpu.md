# GPU acceleration

How the image uses a GPU, what it buys, and what happens without one.

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.
Verified against: selkies 2.2.1, pixelflux 2.2.3, Mesa 25.0.7, Creality Print 7.3.1, on `baseimage-selkies:debiantrixie`, Intel UHD 630 host.

- **Intel/AMD: pass `--device /dev/dri:/dev/dri`, nothing else.** The base image's init scripts map the device groups and pick the render node. The app then renders its 3D view on the GPU, and the stream is encoded with zero-copy VA-API H.264 [V, UHD 630].
- **The GPU does two separate jobs**: the app's OpenGL rendering and the stream encoding. Rendering is the big saving. Orbiting a 640k-triangle model costs about 3.1–3.3 cores at 12–15 frames/s without a GPU, and 0.55–0.65 cores at about 55 frames/s with one, with a 1600×900 or a 3200×1800 stream alike [V].
- **Without a GPU everything still works**: llvmpipe renders, x264 encodes. It is usable, but sluggish with big models [V].
- **Stable over time**: 29-minute sessions with and without the GPU kept `/dev/shm` and PIDs flat, and memory flat apart from one bounded WebKit step on CPU rendering. Plan about 2 GiB RAM per container [V].
- **Pitfalls**: never install `vainfo` (black stream on Intel Gen9), and `AUTO_GPU=false` does not turn the GPU off [V]. NVIDIA and AMD are untested.

## What the image does

- Nothing GPU-specific of its own. It inherits the base image's GPU handling unchanged, as docker-orcaslicer does. Base services and environment in general: see [base-image.md](base-image.md).
- Wayland mode (`PIXELFLUX_WAYLAND=true`). The launcher sets `GDK_BACKEND=x11`, so the app is a GLX client on Xwayland `:0` [V]. Why Wayland mode: see [decisions.md](decisions.md).
- It sets no GL variables: no `__GLX_VENDOR_LIBRARY_NAME`, `LIBGL_ALWAYS_SOFTWARE`, `MESA_GL_VERSION_OVERRIDE` or `INTEL_DEBUG` [V].
- The only GPU package it adds is `mesa-utils` (`glxinfo`, `eglinfo`) for diagnostics. Everything else is already in the base [V]:
  - GL: `libgl1-mesa-dri`, `mesa-libgallium`, `libglx-mesa0`, `libegl-mesa0`, `libgbm1`, `libglu1-mesa`, `mesa-vulkan-drivers`, `vulkan-tools`.
  - VA-API: `intel-media-va-driver-non-free` (iHD), `i965-va-driver-shaders`, `mesa-va-drivers` (AMD), `libva2` 2.22.0.
- Compose: `devices: [/dev/dri:/dev/dri]` and `shm_size: "1gb"`. No `--group-add`, no `seccomp=unconfined`. lsio gives the same advice for one GPU (docker-orcaslicer #35).

## Who draws and who captures

In Wayland mode [V: config and process tree; render-node sharing seen in which processes hold the node]:

```
selkies (python) ── in process ── pixelflux: headless Wayland compositor (socket wayland-1)
                                   renders on DRINODE with GLES, or in software (Pixman)
labwc (nested client of wayland-1) ── Xwayland :0 ── Creality Print (GDK_BACKEND=x11, GLX)
```

- pixelflux advertises its render node in the `linux-dmabuf` feedback. labwc and Xwayland therefore render on the same GPU, and Xwayland gets glamor/DRI3, so GLX clients load Mesa's hardware driver (`iris` on the UHD 630).
- With the GPU, the processes holding `/dev/dri/renderD128` are selkies (compositor and encoder), labwc, Xwayland, CrealityPrint and WebKitWebProcess [V].
- pixelflux logs its choice: `[Wayland] Renderer: GL on /dev/dri/renderD128.`, `[Wayland] Renderer: software (Pixman), no render node.`, or `GPU renderer failed to initialize (…); rendering in software (Pixman).` [V].
- **X11 mode** (`PIXELFLUX_WAYLAND=false`) also works with the GPU [V]. It runs Xvfb `:1` (XLibre 25.2.2 from linuxserver/selkies-layers, with glamor, DRI3 and LinuxServer patches) on `DRINODE`, else the NVIDIA node, else the first `renderD*`. The log shows `**** Xvfb using DRI3 on /dev/dri/renderD128 (i915) ****` and `[X11] Zero-copy capture (DRI3): … encoded in place on VAAPI.`, and `glxinfo -B` on `:1` reports the UHD 630. The app's autostart then lives in the openbox config. lsio no longer develops X11 acceleration and answers DRI3 choppiness reports with "use Wayland mode" (baseimage #42, #115, #145).
- No VirtualGL anywhere in the stack [V].

## Two jobs: rendering and encoding

| | App rendering (the 3D view) | Stream encoding (what the browser gets) |
|---|---|---|
| Done by | Mesa (`iris` on Intel Gen8+, `radeonsi` on AMD) or NVIDIA's GL; llvmpipe without a GPU | pixelflux: VA-API (Intel/AMD) or NVENC; x264 and other software encoders on the CPU |
| Device variable | `DRINODE` (alias `SELKIES_RENDER_DRI`) | `DRI_NODE` (alias `SELKIES_ENCODE_DRI`); `SELKIES_GPU_ID=-1` disables hardware encode |
| Force CPU | Don't mount the device; X11 mode: `DISABLE_DRI3=true`; app only: `LIBGL_ALWAYS_SOFTWARE=1` in the app's environment | `SELKIES_USE_CPU=true` (lockable as `true\|locked`), or the sidebar switch |

- The two variable names differ by one underscore. Both come from selkies `settings.py` [V].
- **Zero copy** needs the render and encode node to be the same device. Frames then go from the render buffer into the encoder as a DMA-BUF. pixelflux logs `[Wayland] Zero-copy capture: … encoded in place on VAAPI.`, or `[Wayland] Readback capture: …` with the reason (`no GPU renderer`, `software encoding selected`, `the encode node is another GPU`, `JPEG encodes on the CPU`, …) [V].
- On a multi-GPU host, set `DRINODE` and `DRI_NODE` to the same node [I: single-GPU host only].
- The two jobs switch independently [V]: `SELKIES_USE_CPU=true` keeps GPU rendering with x264 readback; `LIBGL_ALWAYS_SOFTWARE=1` for the app keeps zero-copy VA-API with the app on llvmpipe.

### What the base's init scripts do

- **`init-video`** [V]:
  - For each device in `/dev/dri` and `/dev/dvb` that `abc` can't use, it creates a group with the device's GID (random name `video…`) and adds `abc`, or runs `chmod g+rw`. That is why no `--group-add` is needed.
  - It writes `AUTO_GPU=true` when a render node exists and none of `AUTO_GPU`, `DRI_NODE`, `DRINODE` is set.
  - It probes for the Intel i965 VA driver with `vainfo` (see Intel pitfalls). Today's base doesn't ship `vainfo`, and the image purges it in case a later base does (the Rust Selkies base does), so the probe never fires.
- **`init-selkies-config`** [V]: on a non-NVIDIA host with exactly one render node, it sets `DRI_NODE=/dev/dri/renderD128`, and in Wayland mode also `DRINODE`. It does this whatever `AUTO_GPU` says.
- What they decided ends up in `/run/s6/container_environment/` (`DRINODE`, `DRI_NODE`, `AUTO_GPU`, `LIBVA_DRIVER_NAME`, `__GLX_VENDOR_LIBRARY_NAME`).

### Codecs

- On the UHD 630 with the default iHD driver, pixelflux reports `Render node 0 encodes H264, VP8, H265 on vaapi.` [V].
- FullColor 4:4:4 H.264 on Intel/AMD falls back to x264 with a GPU readback, because VA-API has no 4:4:4 H.264 profile. Keep FullColor off [V, lsio docs].
- Software H.265, VP9 and AV1 are several times heavier than x264. Keep `h264enc` first in `SELKIES_ENCODER` [V, lsio docs].
- VA-API caps at 4096×4096, hence the base's resolution clamp (baseimage #118).
- NVENC has no VP8/VP9; AV1 needs Ada [V, lsio docs].

## Measured cost (Intel UHD 630)

Setup [V]: i9-9900K (16 threads), 31 GiB RAM, Arch Linux, kernel 7.3.5. Research build of this image's recipe (versions above). Stream locked to 1600×900 with `SELKIES_MANUAL_WIDTH`/`HEIGHT`. Workload: a 640,000-triangle sphere (32 MB STL), orbited by headless Google Chrome with a continuous **right-drag** (a left-drag on empty space draws a selection box). Counters over 30 s mid-orbit: container CPU from the cgroup, per-process CPU, per-process GPU engine time from i915 DRM fdinfo, and `eth0` transmit as a proxy for stream throughput. Other containers ran on the host at the same time; repeats agree within about ±10 %.

Prepare view, orbiting (100 % = one core):

| Run | App GL | Encoder | Container CPU | App CPU | selkies CPU | GPU render / video busy | Stream |
|---|---|---|---|---|---|---|---|
| T1 no GPU (×3) | llvmpipe | x264, Pixman readback | 245–261 % | 229–246 % | 9–10 % | – | 1.6–2.0 Mbit/s |
| T2 `--device /dev/dri` (×4) | iris | VA-API, zero copy | 62–72 % | 40–46 % | 11–13 % | 38–52 % / 10–13 % | 10.5–11.2 Mbit/s |
| T3 T2 + `SELKIES_USE_CPU=true` | iris | x264, readback | 114 % | 42 % | 59 % | 55 % / – | 8.5 Mbit/s |
| T4 T2 + app `LIBGL_ALWAYS_SOFTWARE=1` | llvmpipe | VA-API, zero copy | 280 % | 273 % | 3 % | 0 / 1.5 % | 1.1 Mbit/s |
| T5 T2 + i965 VA driver | iris | VA-API (i965) | 68 % | 44 % | 12 % | 34 % / 15 % | 0.07 Mbit/s, **black** |

Input latency, from a mouse move in the browser to the decoded frame that shows it, was a 41–44 ms median with the GPU [V, Rust Selkies trial's measurement of today's image].

G-code Preview after slicing the sphere (148 layers), same orbit: 69 % container CPU with the GPU, 214 % without [V].

- **App rendering is the big win.** llvmpipe costs 2.3–2.7 cores (T1, T4); on the GPU the app uses about 0.4 cores.
- **Encoding is the smaller win.** x264 instead of VA-API adds about 0.5 cores of selkies CPU at the GPU-rendered frame rate (T3 vs T2). Without a GPU, encoding is cheap only because llvmpipe produces few frames.
- About 11 vs 2 Mbit/s at the same quality setting means the CPU-only session shows far fewer frames, so orbiting is visibly less fluid. The exact frame rate wasn't measured (`GALLIUM_HUD` printed nothing).
- Both modes rendered the view correctly. On llvmpipe the 640k-triangle model was usable but sluggish.

### Window size: 1600×900 vs 3200×1800

A second series measured the effect of the browser window's size [V]. Same host and model, this image, headless Google Chrome (H.264), viewport 1600×900 at device pixel ratio 1 or 2, so Selkies streams 1600×900 or 3200×1800 (the log confirms `Output 0 resized to …`). A gentler orbit than above: a right-drag around a 120 px circle, one turn every 4 s. Container CPU from the cgroup over 30 s mid-drag, three interleaved rounds per configuration (spread under 3 %); frames counted as decoded in the page. Screenshots during the drag confirm the view rotates.

| Stream | GPU: container | GPU: app, selkies | GPU: frames/s | No GPU: container | No GPU: app, selkies | No GPU: frames/s |
|---|---|---|---|---|---|---|
| 1600×900 | 0.65 cores | 0.43, 0.12 | ~54 | 3.08 cores | 2.92, 0.11 | ~14.5 |
| 3200×1800 | 0.53 cores | 0.33, 0.13 | ~56 | 3.32 cores | 2.89, 0.28 | ~11.7 |

- **The stream size hardly matters.** At device pixel ratio 2 the app's layout was the same as at 1, because Selkies' default UI Scaling (200 % on such a browser) has labwc stretch the app: it still rendered at 1600×900, and only the stream was 3200×1800 [I, from the identical layout; see [hidpi.md](hidpi.md)]. Without a GPU the app's llvmpipe rendering stays at about 2.9 cores, and the frame rate drops instead. The extra 0.24 cores at 3200×1800 are x264 in selkies and labwc.
- Rendering the app itself at full resolution (`CP_UI_SCALE=2`) costs more without a GPU: see [hidpi.md](hidpi.md). Compare numbers only within one series.
- With the GPU, 3200×1800 used slightly less app CPU than 1600×900 at a similar frame rate; why is unknown.
- At 1600×900 the GPU figure matches the table above; the no-GPU figure is higher (3.08 vs 2.45–2.61 cores), from the different orbit.

## Without a GPU

- No `/dev/dri` is needed to start or to render [V]. The compositor uses Pixman, Xwayland has no glamor, and the app's GLX goes to llvmpipe: `glxinfo -B` reports `llvmpipe (LLVM 19.1.7, 256 bits)`, OpenGL `4.5 (Core/Compatibility Profile) Mesa 25.0.7`, `Accelerated: no` [V].
- Encoding is x264 (striped, only changed stripes sent), or SVT-AV1 when the client picks AV1 [V]. pixelflux logs `Readback capture: … (no GPU renderer)` and `encoding in software (x264)`.
- pixelflux also logs `No hardware encoder on render node 0 (nvenc): Could not load CUDA library (libcuda.so.1)`. That is harmless noise [V].
- llvmpipe adds about 110 threads (its workers) [I].
- Slicing is CPU-bound either way; the GPU only makes interaction smoother [I].
- With Selkies' default scaling, a smaller browser window saves little CPU: the app renders at the same size, and only the stream and frame rate change (see "Window size" above).

## Creality Print and OpenGL

- It needs only **OpenGL 2.0** in a compatibility profile, and refuses to start below that (`OpenGLManager.cpp`, `init_glcontext()` and `init_gl()`) [V, source]. iris gives 4.6 and llvmpipe 4.5, so no `MESA_GL_VERSION_OVERRIDE` is needed [V].
- wxWidgets 3.3.2 is built with its EGL GL canvas, but on X11/Xwayland the app uses GLX (`libGLX_mesa` in the #604 backtrace) [I].
- The advanced G-code viewer turns on by itself only for a hard-coded list of NVIDIA RTX/GTX names with GL 3.1 or newer. Elsewhere it is off unless the app-config key `enable_advanced_gcode_viewer` is set [V, source].
- The `CREALITYPRINT_OPENGL_SOFTWARE_RENDERER` switches are Windows-only [V, source].
- **Bundled GL libraries are fine.** The AppImage ships `libGLU`, `libOpenGL` and `libGLdispatch` from its Ubuntu 24.04 build host and puts them first on `LD_LIBRARY_PATH`. Mesa, `libGL`, `libEGL`, `libdrm` and `libgbm` come from the container. The mix gets a hardware context on iris and works on llvmpipe [V]. Untested on NVIDIA.
- The app's `AppRun` sets `__GLX_VENDOR_LIBRARY_NAME=mesa` on hybrid hosts whose boot GPU isn't NVIDIA, but only if the variable is unset [V, source]. On NVIDIA the base's `init-video` sets it first, so the base wins [I].
- Three `Unable to init GLAD OpenGL loader` lines at start, with and without a GPU, are harmless: they come before the canvas has a context [V]. The default log level doesn't record the GL version or vendor; use `glxinfo -B` instead [V]. The app's System Info dialog is commented out in the source [V].
- **Slicing on the GPU is stable on Mesa 25.0.7** [V]: slicing the 640k-triangle sphere, switching Prepare and Preview and orbiting the G-code preview gave no hang and no "Not Responding". (Host kernel logs weren't readable, so a silent GPU reset can't be fully ruled out.)
- **Watch Mesa 26.** CrealityPrint #604 (open): an Intel iGPU hangs after every slice on Mesa 26.0.x under Xwayland. `INTEL_DEBUG=noccs` fixes it with the GPU kept; `LIBGL_ALWAYS_SOFTWARE=1` also fixes it; `LIBGL_DRI3_DISABLE=1`, `MESA_GL_VERSION_OVERRIDE=2.1` and lite mode don't. Related: OrcaSlicer #14453 (iris segfault in the plate thumbnail render on Mesa 26.1/26.2, also on Comet Lake UHD) and #15810. The tracking entry is in [decisions.md](decisions.md).

## Intel pitfalls

- **Never install `vainfo`** [V]. The build purges it (a no-op while the base doesn't ship it), and the smoke test fails if it is present. With it present, `init-video`'s probe logs `**** Intel i965 driver required for this GPU ****` and exports `LIBVA_DRIVER_NAME=i965`. On the UHD 630 pixelflux then reports a working zero-copy encoder, but the browser shows a black picture (0.07 Mbit/s, video engine 15 % busy, no errors). VP9 on i965 was black too. The default iHD driver works, and the VPP failure behind the probe (baseimage #170) doesn't happen with iHD. `-e LIBVA_DRIVER_NAME=iHD` can't override it, because `init-video` writes the s6 environment after reading the user's. For VA-API debugging, install `vainfo` ad hoc with `docker exec` after init has run.
- **`AUTO_GPU=false` does not disable the GPU** on a single-GPU host [V]. `init-selkies-config` still sets both nodes, and the log still shows GL rendering and zero-copy VA-API. To run without the GPU, don't mount `/dev/dri`. The lsio docs and docker-orcaslicer README say otherwise.
- lsio reports rendering glitches at odd resolutions with Intel zero-copy VA-API (docker-orcaslicer #28), and an Intel-only menu breakage fixed in Selkies 2.1.0 (docker-orcaslicer #43). Not seen here.

## NVIDIA and AMD (untested)

- **AMD** should work like Intel through `/dev/dri`: `radeonsi` for GL and `mesa-va-drivers` for VA-API, both in the base [I].
- **NVIDIA** (desk research only, from the lsio docs):
  - Host driver 580 or newer, installed from NVIDIA's `.run` file (distribution packages "frequently cause problems"), and the NVIDIA container toolkit (`nvidia-ctk runtime configure --runtime=docker`).
  - Driver 595.80 or newer: mount `/dev/nvidia-modeset` (create it with `nvidia-modprobe --modeset`). Driver 580–594: also the kernel parameters `nvidia-drm.modeset=1 nvidia_drm.fbdev=1`, and possibly a dummy plug on a headless card.
  - Run with `--runtime nvidia --gpus all --device /dev/nvidia-modeset`, or in compose a `deploy.resources.reservations.devices` entry with `driver: nvidia` and `capabilities: [compute,video,graphics,utility]`. The base already sets `NVIDIA_DRIVER_CAPABILITIES=all`.
  - On NVIDIA, `init-video` writes the missing Vulkan, OpenCL and EGL vendor files, copies `nvidia-drm_gbm.so`, and exports `__GLX_VENDOR_LIBRARY_NAME=nvidia` [V, source].
- Creality Print has open upstream reports of a blank 3D view with NVIDIA under Wayland/Xwayland on desktops (#378, #451, #473, #544). Community workarounds use `__EGL_VENDOR_LIBRARY_FILENAMES=…/50_mesa.json`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1`. Zink on NVIDIA has its own allocation errors (OrcaSlicer #11698).

## Long sessions

Two 29-minute sessions, one client each, with and without `/dev/dri`, a 3200×1800 stream at 60 fps and a small model loaded [V]:

| | Without GPU | With GPU |
|---|---|---|
| `/dev/shm` | 6 → 44 MB on connect (wlroots/Pixman frame buffers), then flat | 0.13 MB throughout (frames stay in GPU memory) |
| Container memory | 1.36 → 1.91 GiB, then flat | 1.45 → 1.82 GiB, flat |
| After disconnect | about −200 MB | about −200 MB |
| PIDs | 402–415, flat | 290–301, flat |

- **No sign of baseimage #142** (`/dev/shm` growing on iGPUs). That issue concerns readback modes (4:4:4, JPEG, forced CPU encode), which these runs didn't use. `shm_size: 1gb` is plenty.
- selkies RSS steps up when a client connects (+220 MB with x264 at this size, +12 MB with VA-API), grows a little in the first ~10 minutes, then stays flat, and drops after disconnect. CrealityPrint RSS grows 20–40 MB in the first ~15 minutes, then stays flat.
- **CPU rendering only:** the four `WebKitWebProcess` processes grew about 60 MB each, **+240 MB in one step** between minutes 12 and 17, then stayed flat, also after disconnect. Likely the embedded web views refreshing and rendering in system memory with llvmpipe [I]. A multi-hour run would show whether it repeats.
- **Plan about 2 GiB RAM per container**, plus more while slicing.

## Diagnostics

| Tool | Shows |
|---|---|
| `docker logs` | Group mapping, the i965 line, `Renderer: …`, `Zero-copy capture …` or `Readback capture … (<why>)`, `Encoder: VAAPI H264 …` |
| `docker exec --user abc -e DISPLAY=:0 <ctr> glxinfo -B` | The renderer the app gets (`Mesa Intel(R) UHD Graphics 630` or `llvmpipe`). Shipped in the image |
| `/run/s6/container_environment/` | The node and driver choices the init scripts wrote |
| `selkies gpu-probe` | Selkies' own render-node, driver and GL probe [V: exists; not run] |
| `vkcube` | lsio's in-container GPU test (from the base's `vulkan-tools`) |
| Selkies sidebar "Stats" | Capture path, encoder, frame rate |
| `/proc/<pid>/fdinfo` (i915 `drm-engine-render`/`-video`) | Per-process GPU time without root; host `intel_gpu_top` shows the same per engine |
| `vainfo` | Purged from the image on purpose (see Intel pitfalls) |

## Tests

- `tests/e2e/gpu.spec.js` runs only when the host has `/dev/dri`; CI runners have no GPU, so it runs locally only. It starts the image with the GPU and `CP_PRINTER`, waits for the main window, checks that `glxinfo -B` on `:0` reports a renderer and that it isn't llvmpipe, opens a browser session, and waits up to 60 s for pixelflux's `Encoder: VAAPI …` (or `NVENC`) line. It matches that success line on purpose: pixelflux also logs a harmless `No hardware encoder … (nvenc)` line (see "Without a GPU").
- **Playwright's bundled Chromium has no H.264 decoder** [V]. The Selkies client then steps down to VP9/VP8, so a test with it doesn't see the H.264 stream a Chrome user gets. To check what users see, use Google Chrome.
- The other e2e specs run without a GPU, on llvmpipe and x264.
