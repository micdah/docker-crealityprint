# 04 — GPU acceleration (making it work "like orcaslicer")

Research date: **2026-11-21**. Scope: how `linuxserver/docker-baseimage-selkies` (and `linuxserver/docker-orcaslicer` on top of it) uses a GPU, and what that means for a Creality Print image built the same way.

**Verified** means I saw it in source or docs at the commit listed below. **Inferred** means my reading of the evidence, not yet checked by running anything. No containers were run in this phase. One read-only check was made on the host (`ls -ln /dev/dri`, see §9).

## Sources (pinned)

| Repo / doc | Commit / ref | What I read |
| --- | --- | --- |
| [linuxserver/docker-baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies) | `a7d1dfd0cd98b6992786a4883382f1094d075534` (`master` = the `debiantrixie` tag, 2026-11-21) | `Dockerfile`, `package_versions.txt`, `root/etc/s6-overlay/s6-rc.d/{init-video,init-selkies-config,svc-xorg,svc-de,svc-selkies}/run`, `root/defaults/startwm*.sh`, issues |
| [linuxserver/docker-orcaslicer](https://github.com/linuxserver/docker-orcaslicer) | `4b114d95b04b4517e79d01cd6681b843bce10ef2` (2026-11-17) | `Dockerfile`, `README.md`, `readme-vars.yml`, `root/`, issues |
| [linuxserver/docker-documentation](https://github.com/linuxserver/docker-documentation) (source of docs.linuxserver.io) | `3a909e2de81fea470dacd0f1b965f90484f17de7` (2026-11-20) | `docs/selkies/user-guide/{gpu,configuration,troubleshooting}.md`, `docs/selkies/developer-guide/{architecture,baseimage-internals}.md`, `docs/selkies/components/{pixelflux,baseimages}.md` |
| [selkies-project/selkies](https://github.com/selkies-project/selkies) | tag `2.2.1` = `d6b9351421bd503ffa89bdee78e2bce758b1ffe5` (the version the baseimage pins via `SELKIES_RELEASE=2.2.1`) | `src/selkies/settings.py`, `src/selkies/gpu_probe.py`, `src/selkies/commands.py`, `src/README.md`, `docs/components/desktop-image.md` |
| [selkies-project/pixelflux](https://github.com/selkies-project/pixelflux) | tag `2.2.3` = `5c78910e524539a2b801433303ee61dd04f42a51` (pinned via `PIXELFLUX_RELEASE=2.2.3`) | `pixelflux/src/lib.rs` (Wayland compositor, renderer bring-up, capture decision), `pixelflux/src/encoders/vaapi/mod.rs` |
| [linuxserver/selkies-layers](https://github.com/linuxserver/selkies-layers) | `95dc51408c1e5819d94bf70964186d1c1881859e` (2026-11-17) | `Dockerfile.debian.xvfb`, `patches/debian/trixie/xvfb/` |
| [CrealityOfficial/CrealityPrint](https://github.com/CrealityOfficial/CrealityPrint) | `6262848e302b8c0d593f2b341cd01310aa2f58a1` (`master`, 2026-11-13); latest release `v7.3.1`, pre-release `v7.3.2` | `src/slic3r/GUI/OpenGLManager.cpp`, `GUI_App.cpp`, `deps/wxWidgets/wxWidgets.cmake`, `src/platform/unix/{BuildLinuxImage,build_appimage}.sh.in`, issues |
| [OrcaSlicer/OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) | `5a1ffc6a631ead5886f1c22920deb341fc1a0106` (`main`, 2026-11-21) | `src/slic3r/GUI/OpenGLManager.cpp`, `src/dev-utils/platform/unix/build_linux_image.sh.in`, issues |

Paths below are relative to the repo named in each statement.

---

## 1. TL;DR

- **To enable it, mount the device; nothing else is needed.** Intel/AMD: `--device /dev/dri:/dev/dri`. With one render node the init scripts detect it and point both rendering and encoding at it (verified). NVIDIA: `--runtime nvidia --gpus all --device /dev/nvidia-modeset`, with host driver 580 or newer installed from NVIDIA's `.run` file (verified, lsio docs).
- **There are two separate GPU jobs with two env vars**, and the docs admit the names differ by one underscore (verified, `docs/selkies/user-guide/gpu.md`):
  - `DRINODE` is **rendering**: the device the display server (pixelflux's Wayland compositor, or Xvfb via glamor) draws on, and therefore the device the app's OpenGL runs on.
  - `DRI_NODE` is **encoding**: the device VA-API or NVENC encodes the stream on.
  - When both name the same device you get **zero copy**: frames go from the render buffer straight into the encoder as a DMA-BUF.
- **OrcaSlicer's image runs the Wayland stack** (`PIXELFLUX_WAYLAND=true`) and forces the app onto X11 through XWayland (`GDK_BACKEND=x11`). The slicer's GL therefore goes through **Mesa GLX on XWayland**, which renders on the GPU when there is one (verified config; GL path inferred). We should copy this exactly.
- **VirtualGL is not used.** On X11 the containers run a patched **XLibre Xvfb with glamor and DRI3**, so apps get direct hardware GL. On Wayland, pixelflux *is* the compositor and renders on the GPU (verified).
- **Without a GPU** everything still works: the compositor renders with Pixman, the app gets **llvmpipe** (CPU OpenGL), and x264 encodes on the CPU. A slicer 3D view on llvmpipe is usable for small models and sluggish for big models and G-code previews (orcaslicer issue #19 reporter: "unusable when a model is loaded due to the laggy stuttering").
- **Creality Print specifics:**
  - It needs only **OpenGL 2.0** in a compatibility profile (verified).
  - Its AppImage **bundles `libOpenGL.so`/`libGLdispatch.so`** from the build host and prepends them through `LD_LIBRARY_PATH` (verified). This is a possible glvnd mismatch to check in Phase 2.
  - Upstream has open Linux GL bugs: a blank 3D view on NVIDIA under Wayland/XWayland, and an Intel iGPU **GPU hang after slicing on Mesa 26.0.x** with the workaround `INTEL_DEBUG=noccs`.
- **Gap found:** `init-video` tries to auto-select the Intel `i965` VA-API driver for Gen ≤ 9.5 GPUs (which includes the **UHD 630**) by running `vainfo`, but `vainfo` was **removed from the baseimage Dockerfile** in commit `e075dc6330` (2026-09-20). The check therefore can never succeed (verified that the package is absent).
  - **Phase 2 update:** this gap is *helpful* on the UHD 630. With `vainfo` installed, the probe switches to `i965`, and the stream goes **black**. The default iHD driver works. **Do not install `vainfo` in our image** (see "Hands-on results").

---

## 2. Display stacks in the baseimage: who draws, who captures

The baseimage carries **two** display stacks and picks one per container with `PIXELFLUX_WAYLAND` (verified, `docs/selkies/user-guide/configuration.md`, `svc-xorg/run`, `svc-de/run`).

### 2.1 Wayland mode (`PIXELFLUX_WAYLAND=true`, what docker-orcaslicer uses)

Process topology (verified, `docs/selkies/developer-guide/architecture.md`, `root/defaults/startwm_wayland.sh`):

```
selkies (python) ── in process ──> pixelflux: headless Smithay compositor on socket "wayland-1"
                                    renders on DRINODE (GLES) or in software (Pixman)
startwm_wayland.sh ──> labwc (nested: a *client* of wayland-1)
                         serves wayland-0 and XWayland on DISPLAY=:0
                           └─> /opt/orcaslicer/AppRun (GDK_BACKEND=x11, so it talks to XWayland :0)
```

- `svc-xorg/run` bails out with `sleep infinity` in Wayland mode, so no Xvfb runs (verified).
- pixelflux 2.2.3 `lib.rs` (verified):
  - With a render node it logs `[Wayland] Renderer: GL on /dev/dri/renderDXXX.` and brings up GBM/EGL.
  - It creates the `linux-dmabuf` global **with default feedback naming that render node** (`DmabufFeedbackBuilder::new(up.node.dev_id(), …)`).
  - Without a node it logs `[Wayland] Renderer: software (Pixman), no render node.`
  - If GPU bring-up fails it logs `GPU renderer failed to initialize (…); rendering in software (Pixman).`
- **Inferred:** because the dmabuf feedback advertises the render node, nested labwc (wlroots) renders on that GPU, and the XWayland it spawns starts with glamor/DRI3 on the same node. GLX clients such as OrcaSlicer and Creality Print then load Mesa's hardware driver (`iris` on a UHD 630) through DRI3. Without a GPU, XWayland has no glamor and GLX falls back to Mesa's software rasterizer (llvmpipe). §9 verifies this with `glxinfo -B` against `DISPLAY=:0`.

### 2.2 X11 mode (`PIXELFLUX_WAYLAND=false`)

- `svc-xorg/run` picks the render node in this order: `DRINODE` if set, else the NVIDIA node if `nvidia-smi` exists, else the first `/dev/dri/renderD*`. It then starts **Xvfb `:1` with `-glamor -dri <node>`**, unless `DISABLE_DRI3=true` or no node exists (verified).
- The Xvfb comes from `selkies-layers`: XLibre `xlibre-xserver-25.2.2`, built with `-Dglamor=true -Ddri3=true -Dglx=true` and six LinuxServer patches (verified, `Dockerfile.debian.xvfb`, `patches/debian/trixie/xvfb/`):
  - `xvfb-gpu-screen-pixmap` puts the screen pixmap on the GPU.
  - `xvfb-syncobj-present`, `xvfb-vblank-rate` (fake vblank at the capture rate), `xvfb-zero-copy-semaphore` (NVIDIA), `xvfb-hotplug-outputs`, `xvfb-vidmode`.
- With DRI3 on a render node, GLX clients render directly on the GPU. pixelflux captures the root window by a DRI3 blit into a DMA-BUF that the encoder imports in place (verified, `docs/selkies/components/pixelflux.md` §X11).
- `DISABLE_DRI3=true` makes "applications render on the CPU and capture fall back to shared memory" (verified, `configuration.md`).
- For a software-only server, `svc-xorg` points `__EGL_VENDOR_LIBRARY_FILENAMES` at Mesa's `50_mesa.json`. It also **unsets the Zink variables** (`GALLIUM_DRIVER MESA_LOADER_DRIVER_OVERRIDE LIBGL_KOPPER_DRI2`) for Xvfb (verified). That cleanup is left over from an earlier lsio design that pushed NVIDIA GL through Zink (issues #112, #173 mention `DISABLE_ZINK`). The current `init-video` no longer sets Zink anywhere (verified by grep), so this is inferred to be history.
- lsio's stated direction: "X11 acceleration is not going to be developed anymore … I would highly recommend moving over to wayland" (thelamer in [baseimage #145](https://github.com/linuxserver/docker-baseimage-selkies/issues/145), 2026-04). [Baseimage #115](https://github.com/linuxserver/docker-baseimage-selkies/issues/115) says the same: "If you are experiencing issues with 3d acceleration please try `-e PIXELFLUX_WAYLAND=true`".

### 2.3 VirtualGL

The lsio stack does not use it (verified: no `vglrun`/VirtualGL anywhere in the baseimage, the docs or selkies `src/`). Upstream selkies' own desktop image says Zink "is what replaces VirtualGL here" (verified, selkies `docs/components/desktop-image.md`). One Creality Print user does report that `vglrun` fixes the blank viewport on an NVIDIA desktop ([CrealityPrint #378](https://github.com/CrealityOfficial/CrealityPrint/issues/378)). That is a desktop workaround and not relevant to our container (inferred).

---

## 3. The two jobs: (a) app rendering vs (b) stream encoding

| | (a) App rendering (the slicer's OpenGL 3D view) | (b) Stream encoding (what the browser receives) |
| --- | --- | --- |
| What does it | Mesa (`iris` on Intel Gen8+, `radeonsi` on AMD) or NVIDIA's GL, reached through the display server's DRI3 render node; llvmpipe without a GPU | pixelflux: VA-API (Intel/AMD) or NVENC (NVIDIA) on the GPU; x264/x265/libvpx/SVT-AV1/JPEG on the CPU |
| Device var | `DRINODE` (alias `SELKIES_RENDER_DRI`) | `DRI_NODE` (alias `SELKIES_ENCODE_DRI`); `SELKIES_GPU_ID` (index, `-1` disables HW encode) |
| Auto | `AUTO_GPU` (selkies default `"true"`: first GPU; can also be a vendor/driver token such as `intel`, `nvidia`, `amdgpu`) | auto-selected if unset |
| Force CPU | no device mounted; X11: `DISABLE_DRI3=true`; app only: `LIBGL_ALWAYS_SOFTWARE=1` in the app env | `SELKIES_USE_CPU=true` (lockable: `"true\|locked"`), or the sidebar CPU switch |
| Packages in the image | `libgl1-mesa-dri`, `mesa-libgallium`, `libglx-mesa0`, `libegl-mesa0`, `libgbm1`, `libglu1-mesa` (already in the baseimage) | `intel-media-va-driver-non-free` (iHD), `i965-va-driver-shaders`, `mesa-va-drivers` (radeonsi VA), `libva2`/`libva-drm2` (already in the baseimage); NVENC uses the host driver's `libnvidia-encode`/`libcuda` injected by the toolkit |

Sources: `settings.py` at selkies `2.2.1` (`encode_dri`/`DRI_NODE`, `render_dri`/`DRINODE`, `auto_gpu`/`AUTO_GPU`, `use_cpu`), selkies `src/README.md`, `configuration.md` (`SELKIES_GPU_ID`, `SELKIES_USE_CPU`), baseimage `Dockerfile` and `package_versions.txt` (Mesa **25.0.7**, libva **2.22.0**, iHD **25.2.3**, i965 **2.4.1** on Debian trixie). All verified.

**Coupling (verified, docs and pixelflux source):** zero copy needs the encode node and the render node to be the same device. pixelflux logs one of these:

- `[Wayland] Zero-copy capture: output 0 WxH rendered on /dev/dri/renderD128, encoded in place on VAAPI.`
- `[Wayland] Readback capture: … read back for the encode thread (<why>)`, where `<why>` is one of `no GPU renderer`, `software encoding selected`, `the encode node is another GPU`, `JPEG encodes on the CPU`, or `no zero-copy … encoder on the render node`.
- X11: `[X11] Zero-copy capture (DRI3) unavailable: <reason>; capturing through XShm.`

**So (a) and (b) are independently switchable**, which makes the A/B tests in §9 possible:

- GPU render + CPU encode: `SELKIES_USE_CPU=true`. This is a readback path and costs CPU.
- CPU render + GPU encode: no `DRINODE`, or `LIBGL_ALWAYS_SOFTWARE=1` for the app only. With the compositor itself on the GPU, the encode stays zero-copy and only the app's GL is in software.

**Codec caveats (verified, `gpu.md`):**

- Intel VA-API: H.264, H.265, VP9; AV1 only on Arc and recent iGPUs. `vainfo` lists what is actually available.
- **FullColor 4:4:4 H.264 on Intel/AMD falls back to x264 on the CPU** with a GPU readback, because VA-API exposes no 4:4:4 H.264 profile. Keep FullColor off on Intel.
- H.265/VP9/AV1 that fall back to software are "several times heavier than x264", so keep `h264enc` first in `SELKIES_ENCODER`.
- [Baseimage #118](https://github.com/linuxserver/docker-baseimage-selkies/issues/118): VA-API caps at 4096×4096, and the resolution clamp is there for that reason.

---

## 4. Intel / AMD in detail

### 4.1 What the init scripts do (verified)

**`init-video/run`** (oneshot) does the following:

1. **Group mapping for render nodes.** For every char device in `/dev/dri` and `/dev/dvb`:
   - If user `abc` already owns it, or is in its group and the group has `rw`, it prints `**** permissions for /dev/dri/X are good ****`.
   - Otherwise it looks up the device's **GID**. If no group with that GID exists in the container, it creates one with a random name (`video` plus 4 random chars) and that GID, then `usermod -a -G` adds `abc` to it. It prints `**** adding /dev/dri/X to video group <name> with id <gid> ****`.
   - If the device lacks group `rw` it runs `chmod g+rw` and prints a hint to do the same on the host.

   This is why lsio needs no `--group-add` (unlike most images).
2. **`AUTO_GPU`.** On x86_64, if a `/dev/dri/renderD*` exists and none of `AUTO_GPU`, `DRI_NODE` or `DRINODE` is set, it writes `AUTO_GPU=true` into the s6 container env.
3. **i965 detection.** On x86_64 without `nvidia-smi`, it takes `DRI_NODE` (or the first render node if `AUTO_GPU=true`) and runs `LIBVA_DRIVER_NAME=i965 vainfo --display drm --device <node>`. If that succeeds it exports `LIBVA_DRIVER_NAME=i965`, logging `**** Intel i965 driver required for this GPU ****`. The commit message says it is meant for "10th gen and lower" (commit `500ecfa8c0`, 2026-07-17, prompted by [baseimage #170](https://github.com/linuxserver/docker-baseimage-selkies/issues/170), which was **Intel UHD 630**: pixelflux VA-API VPP init failed with `the requested VAProfile is not supported`).
   - **Bug (verified that the package is gone; effect inferred):** `vainfo` was added to the Dockerfile in `500ecfa8c0` and `bf839c0a88`, then **removed in `e075dc6330` ("updates for rc1", 2026-09-20)**. It is absent from `Dockerfile` and `package_versions.txt` at `a7d1dfd`. With `vainfo` missing, the `if` always fails and the iHD driver is used.
   - pixelflux 2.2.3 still uses the VA-API **VideoProc (VPP)** entrypoint for RGB→NV12 conversion (verified, `encoders/vaapi/mod.rs` `open_vpp`), and VPP is what failed on the UHD 630 in #170. **Test this first on our host.**

**`init-selkies-config/run`** (oneshot, verified):

- Not NVIDIA, exactly one render node (`renderD128` present and no `renderD129`), and `DRI_NODE` unset: it sets `DRI_NODE=/dev/dri/renderD128`.
- In Wayland mode it also sets `DRINODE=/dev/dri/renderD128` if unset.
- **Inferred side effect:** this runs regardless of `AUTO_GPU`. On a single-GPU host, `AUTO_GPU=false` may therefore not actually disable the GPU, despite what the docs promise. Check in Phase 2.

**`svc-xorg/run`** handles X11 mode only; see §2.2.

### 4.2 Mesa and VA packages for our image

Everything needed is **already in the baseimage** (verified, `Dockerfile` and `package_versions.txt`):

- `libgl1-mesa-dri`, `mesa-libgallium`, `libglx-mesa0`, `libegl-mesa0`, `libgbm1`, `libglu1-mesa`, `mesa-vulkan-drivers`, `vulkan-tools` (provides `vkcube`).
- `intel-media-va-driver-non-free`, `i965-va-driver-shaders`, `mesa-va-drivers`, `firmware-misc-nonfree`.

Our image only needs to add diagnostics (recommendation, revised after Phase 2):

- `mesa-utils` (provides `glxinfo`, `eglinfo`). Harmless; tested.
- **Not `vainfo`.** Installing it re-arms the `init-video` i965 probe, which on a UHD 630 selects `i965` and gives a black stream (Phase 2). For VA-API debugging, install it ad hoc with `docker exec … apt-get install vainfo` *after* init has run.
- optionally `intel-gpu-tools`, though it is more useful on the host

Watch out: OrcaSlicer's AppRun runs `glxinfo` when `XDG_SESSION_TYPE=wayland` (see §5). Creality Print's AppRun has no such logic, so installing `mesa-utils` is harmless for us (verified, §6.3).

### 4.3 Compose (Intel/AMD)

```yaml
services:
  crealityprint:
    image: <ours>
    shm_size: "1gb"
    devices:
      - /dev/dri:/dev/dri
    # only for multi-GPU hosts; must match for zero copy:
    # environment:
    #   - DRINODE=/dev/dri/renderD128
    #   - DRI_NODE=/dev/dri/renderD128
```

lsio's advice ([docker-orcaslicer #35](https://github.com/linuxserver/docker-orcaslicer/issues/35), thelamer): "if you only have one GPU all you need to do is pass `--device /dev/dri:/dev/dri` none of that other stuff is needed". He also advises against `PIXELFLUX_WAYLAND=false` and `seccomp=unconfined`.

---

## 5. NVIDIA in detail

From `docs/selkies/user-guide/gpu.md`, `init-video/run` and the orcaslicer README:

- **Host requirements (verified, docs):**
  - Driver **580 or newer**, installed from NVIDIA's `.run` file; "Distribution packaged drivers frequently cause problems".
  - On **595.80 and newer**, only `/dev/nvidia-modeset` is needed (run `sudo nvidia-modprobe --modeset` if it does not exist) and must be mounted, because it "is required for proper Vulkan support".
  - On **580–594**, also set the kernel params `nvidia-drm.modeset=1 nvidia_drm.fbdev=1`, and possibly a **dummy plug** on a headless card.
  - nvidia-container-toolkit set up with `sudo nvidia-ctk runtime configure --runtime=docker`.
  - **Not available on Alpine images** (ours will be Debian, so fine).
- **Run:** `--runtime nvidia --gpus all --device /dev/nvidia-modeset` (verified, README).
- **Compose (verified, docs):**
  ```yaml
      runtime: nvidia            # optional when using deploy.resources with the toolkit (inferred)
      devices:
        - /dev/nvidia-modeset:/dev/nvidia-modeset
      deploy:
        resources:
          reservations:
            devices:
              - driver: nvidia
                count: 1          # or: all
                capabilities: [compute,video,graphics,utility]
  ```
  The baseimage already sets **`ENV NVIDIA_DRIVER_CAPABILITIES=all`** (verified, `Dockerfile`), so the toolkit injects the graphics/EGL/GLX, video (NVENC) and display libraries. `all` is what is needed; `graphics,video,utility,compute,display` is the explicit equivalent. Upstream selkies notes that `/dev/nvidia-modeset` comes in under the `display` capability (verified, selkies `docs/components/desktop-image.md`).
- **What `init-video` fixes inside the container** (verified, runs only if `nvidia-smi` exists *and* `/dev/dri` is non-empty):
  - Writes a missing OpenCL ICD, Vulkan ICD (`libGLX_nvidia.so.0`) and **glvnd EGL vendor file** (`10_nvidia.json` → `libEGL_nvidia.so.0`).
  - Copies `nvidia-drm_gbm.so` into the GBM dir ([baseimage #146](https://github.com/linuxserver/docker-baseimage-selkies/issues/146), Unraid).
  - If the GLX node's driver is `nvidia`/`nvidia-drm` and `DISABLE_DRI3=false`, it exports **`__GLX_VENDOR_LIBRARY_NAME=nvidia`**. This routes GLX clients (our slicer) to NVIDIA's GL instead of Mesa.
  - Also sets `__GL_SYNC_TO_VBLANK=0` (image ENV).
  - The baseimage also installs `libnvidia-egl-wayland1` and `libnvidia-egl-gbm1`, which XWayland/labwc need on NVIDIA (verified, Dockerfile).
- **Known caveats:**
  - The **app GL path is GLX through XWayland (Wayland mode) or Xvfb+glamor (X11 mode) on NVIDIA's own EGL/GBM**. That path needs modeset/GBM support, hence the driver and kernel-parameter requirements (inferred from the docs).
  - [Baseimage #163](https://github.com/linuxserver/docker-baseimage-selkies/issues/163): labwc aborted in a loop on NVIDIA after the wlroots 0.20 bump (Arch images, fixed by pinning).
  - [Baseimage #112](https://github.com/linuxserver/docker-baseimage-selkies/issues/112): toolkit 1.18 broke the old Zink path; the fix was to use NVIDIA's proprietary kernel module.
  - [docker-orcaslicer #19](https://github.com/linuxserver/docker-orcaslicer/issues/19) (2025, the old KasmVNC base): "No build plate with nvidia GPU", closed stale.
  - **NVENC does not do VP8/VP9**; AV1 needs Ada.
  - OrcaSlicer's own AppRun forces Zink (`__GLX_VENDOR_LIBRARY_NAME=mesa`, `MESA_LOADER_DRIVER_OVERRIDE=zink`, `GALLIUM_DRIVER=zink`) when `XDG_SESSION_TYPE=wayland`, `glxinfo` reports NVIDIA and the driver is >555 (verified, `build_linux_image.sh.in` at `5a1ffc6`). In the lsio container `XDG_SESSION_TYPE` is unset and `glxinfo` is not installed, so it stays dormant (inferred).
- **Creality Print on NVIDIA (upstream desktop reports):** a blank 3D canvas on Wayland/XWayland with NVIDIA ([#378](https://github.com/CrealityOfficial/CrealityPrint/issues/378), [#473](https://github.com/CrealityOfficial/CrealityPrint/issues/473), [#544](https://github.com/CrealityOfficial/CrealityPrint/issues/544) open, [#451](https://github.com/CrealityOfficial/CrealityPrint/issues/451) open).
  - Community workarounds are `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1`. Some combine these with `__GLX_VENDOR_LIBRARY_NAME=nvidia`.
  - The Creality Print AppRun itself forces `__GLX_VENDOR_LIBRARY_NAME=mesa` on hybrid hosts with a non-NVIDIA boot VGA, but only when the variable is unset (verified, `BuildLinuxImage.sh.in`). lsio's `init-video` sets it, so ours wins (inferred).
  - **The NVIDIA path is untested for Creality Print in a container**, and we have no NVIDIA host. Document it as "should work like orcaslicer, unverified".

---

## 6. Creality Print / OrcaSlicer OpenGL requirements and known GPU bugs

### 6.1 Minimum GL (verified)

- **Creality Print** (`src/slic3r/GUI/OpenGLManager.cpp` at `6262848`):
  - `init_glcontext()` asks wxWidgets for a **compatibility profile** (falls back to the default), and `init_gl()` requires `is_version_greater_or_equal_to(2, 0)`. Otherwise it shows "OpenGL version is lower than 2.0" and closes.
  - GLAD is loaded via `eglGetProcAddress` when running on Wayland/EGL, else via the libGL loader.
  - wxWidgets **3.3.2** is built with `-DwxUSE_GLCANVAS_EGL=ON` (`deps/wxWidgets/wxWidgets.cmake`). Under X11/XWayland the backtrace in [#604](https://github.com/CrealityOfficial/CrealityPrint/issues/604) shows `libGLX_mesa → MakeCurrent`, so **GLX is used on X11** (inferred from that trace).
  - The "advanced G-code viewer" auto-enables only for a hard-coded list of NVIDIA RTX/GTX names with GL ≥ 3.1; otherwise it is off, and the user can override it with the app-config key `enable_advanced_gcode_viewer`. On Intel or llvmpipe we get the simpler viewer by default.
  - The software-renderer env switches `CREALITYPRINT_OPENGL_SOFTWARE_RENDERER` / `…_HARDWARE_AVAILABLE` are **Windows-only** (`#ifdef _WIN32`).
- **OrcaSlicer** (`OpenGLManager.cpp` at `5a1ffc6`): it tries the highest **core** profile from `OpenGLVersions::core`, then compatibility, then the default, and errors below 2.0. Its message says "lower than 3.2", but the check is for 2.0.
- Both are far below what Mesa offers: `iris` on a UHD 630 gives GL 4.6, and llvmpipe in Mesa 25 gives GL 4.5 (inferred from general Mesa knowledge). **We need no `MESA_GL_VERSION_OVERRIDE`.**

### 6.2 Known Linux GPU bugs relevant to us

| Issue | Status | Relevance |
| --- | --- | --- |
| [CrealityPrint #604](https://github.com/CrealityOfficial/CrealityPrint/issues/604): GPU hang / black "Not Responding" after every slice on an Intel iGPU, **Mesa 26.0.x**, running via XWayland | open (2026-08) | A/B table: `INTEL_DEBUG=noccs` fixes it with GPU accel kept, `LIBGL_ALWAYS_SOFTWARE=1` fixes it. Not fixed by `LIBGL_DRI3_DISABLE=1`, `MESA_GL_VERSION_OVERRIDE=2.1` or lite mode. Our base has Mesa **25.0.7**, so possibly unaffected (inferred). **Slice repeatedly in Phase 2 and watch host `dmesg` for "GPU hang".** |
| [OrcaSlicer #14453](https://github.com/OrcaSlicer/OrcaSlicer/issues/14453): segfault on slice, thumbnail `glDrawElements` with no EBO bound, `iris` only (Mesa 26.1/26.2) | open | Shared code lineage (plate thumbnails). Comment reproduces it on **Comet Lake UHD**. |
| [OrcaSlicer #15810](https://github.com/OrcaSlicer/OrcaSlicer/issues/15810): Mesa segfault in thumbnail render, works with `LIBGL_ALWAYS_SOFTWARE=1` | closed | Same family; Flatpak Mesa 26.x. |
| [OrcaSlicer #11698](https://github.com/OrcaSlicer/OrcaSlicer/issues/11698): Zink memory allocation errors, NVIDIA + Wayland | open | Reason to avoid Zink on NVIDIA. |
| [CrealityPrint #637](https://github.com/CrealityOfficial/CrealityPrint/issues/637): Fedora hybrid GPU; Zink `SwapBuffers` deadlock; FreeType variable-font crash | open | WebKit env workaround `WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1`. |
| [docker-orcaslicer #43](https://github.com/linuxserver/docker-orcaslicer/issues/43): broken menus/buttons on some Intel setups with `v2.4.2-ls43` | closed 2026-10-20 | Fixed by Selkies 2.1.0. Shows that Intel-specific rendering regressions in the stack do happen. |
| [docker-orcaslicer #28](https://github.com/linuxserver/docker-orcaslicer/issues/28): plates not interactable | closed | thelamer: "zero copy encoder on Intel VAAPI has some rendering bugs at off resolutions but the performance is night and day … N97 with zero copy vaapi in wayland mode". |
| [baseimage #142](https://github.com/linuxserver/docker-baseimage-selkies/issues/142): `/dev/shm` balloons on iGPUs when frames are read back (4:4:4, JPEG, forced CPU encode) | closed (pixelflux fix) | Keep `shm_size: 1gb` and avoid readback modes on the iGPU. |
| [baseimage #145](https://github.com/linuxserver/docker-baseimage-selkies/issues/145), [#115](https://github.com/linuxserver/docker-baseimage-selkies/issues/115), [#42](https://github.com/linuxserver/docker-baseimage-selkies/issues/42): DRI3 (X11) choppiness on AMD/Intel | closed | "Use Wayland mode". |

### 6.3 Creality Print AppImage GL packaging (verified, `src/platform/unix/build_appimage.sh.in`, `BuildLinuxImage.sh.in`)

- The AppImage copies **`libGLU.so.*`, `libOpenGL.so.*`, `libGLdispatch.so.*`** from the build host into `usr/lib`. The AppRun does `export LD_LIBRARY_PATH="$DIR/bin:$DIR/usr/lib"`, so the **bundled `libGLdispatch` shadows the container's glvnd 1.7.0** while `libGLX.so.0`/`libEGL.so.1` come from the container.
- **Inferred risk:** glvnd's `libGLX`/`libEGL` and `libGLdispatch` are meant to come from the same glvnd build. A mismatch could break vendor dispatch (NVIDIA especially).
- Phase 2 check: `ldd`/`LD_DEBUG=libs` on the extracted binary. If problems appear, delete the bundled `libGLdispatch.so*`/`libOpenGL.so*` after `--appimage-extract`, the same way docker-orcaslicer post-processes its AppImage.
- Mesa drivers, `libGL`, `libEGL`, `libdrm` and `libgbm` are **not** bundled, so the container's Mesa is used (verified by the copy list).

---

## 7. What docker-orcaslicer does about GPU

All verified at `4b114d9`:

- `Dockerfile`: `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie`, `ENV PIXELFLUX_WAYLAND=true`, and `sed -i "1a export GDK_BACKEND=x11" /opt/orcaslicer/AppRun`. The changelog entry for 18.10.26 reads "Force OrcaSlicer to use the X11 GDK backend to fix UI rendering issues under Wayland".
- It sets **no GL env vars**: no `__GLX_VENDOR_LIBRARY_NAME`, `LIBGL_ALWAYS_SOFTWARE`, `MESA_GL_VERSION_OVERRIDE` or `INTEL_DEBUG` (grep of the whole repo). It relies entirely on the baseimage's auto-GPU logic.
- README "GPU Acceleration": "A GPU is optional … When a GPU is mounted into the container it is automatically detected and configured for zero copy rendering and encoding, set `AUTO_GPU=false` to disable". It gives the Intel/AMD one-liner (`--device /dev/dri`) and the NVIDIA trio (`--runtime nvidia --gpus all --device /dev/nvidia-modeset`, driver ≥ 580 from `.run`), then links to the docs for `DRINODE`/`DRI_NODE`. `readme-vars.yml` has `show_nvidia: true`.
- So "GPU acceleration like orcaslicer" means: **inherit the baseimage unchanged, use Wayland mode, force `GDK_BACKEND=x11` for the app, and document `--device /dev/dri`**. Creality Print's own Wayland-native mode is broken upstream ([#451](https://github.com/CrealityOfficial/CrealityPrint/issues/451) open), which is one more reason to force X11 (inferred).

---

## 8. No GPU: llvmpipe and CPU cost

- **What runs:** the pixelflux compositor uses **Pixman**, labwc uses software, and XWayland has no glamor. The app's GLX goes to Mesa **llvmpipe** (multi-threaded; `LP_NUM_THREADS` defaults to the number of CPUs). Encoding uses **x264, striped across cores, with only dirty stripes sent** (verified for the encoder: `architecture.md`, `configuration.md`; GL path inferred).
- **Cost model (inferred, to be measured in §9):**
  - Idle screen: close to zero CPU ("Idle screens take a fast path").
  - Orbiting the 3D view: every frame is rasterized by llvmpipe on the CPU *and* fully re-encoded by x264. CPU use scales with resolution × FPS × scene complexity, and the two compete for the same cores.
  - The G-code preview of a sliced model (millions of line segments) is the worst case.
  - The upstream workaround `LIBGL_ALWAYS_SOFTWARE=1` "works" for crashes but is described as slow (CrealityPrint #473 comment: "rendering is borderline inefficient"; [docker-orcaslicer #19](https://github.com/linuxserver/docker-orcaslicer/issues/19): without GPU "unusable when a model is loaded due to the laggy stuttering", an older stack).
- **Mitigations without a GPU:**
  - Lower the stream FPS or resolution (`SELKIES_MANUAL_WIDTH`/`HEIGHT`, the FPS slider), and keep `h264enc` (striped) first.
  - Slicing itself is CPU-bound either way, so the GPU only matters for interaction smoothness.
  - The app's own "lite" G-code preview options reduce GL load (Creality Print's advanced viewer is off by default on non-RTX, §6.1).
- lsio's position: "A GPU is optional, the CPU pipeline is fast enough for smooth sessions on modest hardware" (README). That is true for 2D desktops; for a slicer's 3D view, the A/B in §9 will tell.

---

## 9. Diagnostics available in the container

| Tool | Where | What it shows | Status |
| --- | --- | --- | --- |
| Container log (`docker logs`) | init scripts plus selkies/pixelflux stdout | `**** adding /dev/dri/renderD128 to video group … ****`, `**** Intel i965 driver required … ****`, `[Wayland] Renderer: GL on …` / `software (Pixman)`, `[Wayland] Zero-copy capture … encoded in place on VAAPI` / `Readback capture … (<why>)`, `Encoders not served on this host are left off the menu`, `Stream settings active -> … Mode: H264 (VAAPI)` (from #170) | verified strings |
| `selkies gpu-probe` | in the image (selkies 2.2.1 `commands.py`) | `SELKIES_GPU_RENDER_NODE`, `_DRIVER`, `_PRESENT`, `_ACCELERATED`, `_GL_VENDOR`, `_EGL_X11`, `_MESA_DRIVER` (`native`/`zink`/""), `_VULKAN_PRESENTS` | verified it exists; invocation as `abc`/PATH to check |
| `/run/s6/container_environment/*` | runtime env the init scripts wrote | `DRINODE`, `DRI_NODE`, `AUTO_GPU`, `LIBVA_DRIVER_NAME`, `__GLX_VENDOR_LIBRARY_NAME` | verified mechanism |
| `vkcube` | `vulkan-tools` in the base | lsio's "go to in container GPU test" | verified (docs, package) |
| `glxinfo -B` / `eglinfo -B` | **not installed**; add `mesa-utils` | `OpenGL renderer string: Mesa Intel(R) UHD Graphics 630 (CFL GT2)` vs `llvmpipe (LLVM …)` | verified absent |
| `vainfo` | **not installed**; add `vainfo` | VA driver (iHD/i965) and encode entrypoints (`VAEntrypointEncSlice`/`EncSliceLP`, `VideoProc`) | verified absent |
| Selkies sidebar "Stats" | browser | capture path, encoder, whether hardware was expected, FPS | verified (docs) |
| Creality Print log | `~/.config/Creality/Creality Print/<ver>/log/` (path inferred) | `got opengl version X, glsl version Y, vendor Z` (`OpenGLManager.cpp` line ~256); the renderer string is not logged there | verified log text, path inferred |
| Creality Print System Info dialog | — | `SysInfoDialog` exists in the source, but its use in `GUI_App.cpp` is **commented out** (`//SysInfoDialog dlg;`) | verified; probably not reachable in the UI |
| Host: `intel_gpu_top` (`intel-gpu-tools`) | host | Render/3D and Video engine busy %, which directly proves (a) and (b) | — |
| Host: `ls -ln /dev/dri` | host | read-only check on 2026-11-21: `card1` = `root:983(video) 0660`, `renderD128` = `root:987(render) 0666`, driver `i915` | **verified on this host** |

---

## 10. Hands-on test plan (Intel UHD 630 host)

Host facts (verified read-only on 2026-11-21): `/dev/dri/card1` is `root:video(983)` with mode `0660`, `/dev/dri/renderD128` is `root:render(987)` with mode **`0666`**, kernel driver `i915`. `vainfo`, `glxinfo` and `intel_gpu_top` are not installed on the host. Docker is present.

Since `renderD128` is world-rw here, permissions on the render node cannot be the problem. `init-video` will still create groups for GIDs 983 and 987 and add `abc` to them (expected log lines).

### 10.0 Preparation (host)

```bash
# GPU engine monitor (Arch)
sudo pacman -S --needed intel-gpu-tools
ls -ln /dev/dri
readlink -f /sys/class/drm/renderD128/device/driver   # expect .../i915
```

Use a fixed workload for every run:

1. Open `3DBenchy.stl` plus one large model (≥ 1M triangles) and orbit the 3D view continuously for 30 s.
2. Slice, switch to Preview, drag the layer slider for 30 s.
3. Slice 5 times in a row (#604 hang check).

Use the same browser window size every time, or lock it with `SELKIES_MANUAL_WIDTH=1920 SELKIES_MANUAL_HEIGHT=1080`.

### 10.1 Run matrix

Run first with `lscr.io/linuxserver/orcaslicer:latest` as a **reference** (proves the host and stack), then with our Creality Print image.

| ID | Extra flags | Expect app GL | Expect encode |
| --- | --- | --- | --- |
| T1 CPU only | *(none)* | llvmpipe | x264 (CPU) |
| T2 GPU auto | `--device /dev/dri:/dev/dri` | iris (UHD 630) | VAAPI zero-copy |
| T3 GPU render, CPU encode | T2 + `-e SELKIES_USE_CPU=true` | iris | x264, readback |
| T4 CPU render, GPU encode | T2 + app launched with `LIBGL_ALWAYS_SOFTWARE=1` | llvmpipe | VAAPI zero-copy |
| T5 i965 VA driver | T2 + `-e LIBVA_DRIVER_NAME=i965` | iris | VAAPI (i965) |
| T6 X11 stack | T2 + `-e PIXELFLUX_WAYLAND=false` | iris via Xvfb glamor/DRI3 | VAAPI zero-copy (DRI3) |
| T7 AUTO_GPU off | T2 + `-e AUTO_GPU=false` | ? (§4.1 suspects the GPU is still used) | ? |

Template:

```bash
docker run --rm -d --name cp-test \
  --shm-size=1gb \
  -p 3001:3001 \
  -e PUID=1000 \
  -e PGID=1000 \
  --device /dev/dri:/dev/dri \
  <image>
```

### 10.2 Checks per run

```bash
# 1. init + pixelflux decisions
docker logs cp-test 2>&1 | grep -E 'video group|permissions for|i965|Renderer:|Zero-copy|Readback|VAAPI|NVENC|Encoders not served|Stream settings active|GPU renderer failed'

# 2. env the init scripts wrote
docker exec cp-test sh -c 'for v in DRINODE DRI_NODE AUTO_GPU LIBVA_DRIVER_NAME __GLX_VENDOR_LIBRARY_NAME PIXELFLUX_WAYLAND; do printf "%s=%s\n" "$v" "$(cat /run/s6/container_environment/$v 2>/dev/null)"; done'
docker exec cp-test id abc

# 3. selkies' own probe
docker exec cp-test with-contenv s6-setuidgid abc selkies gpu-probe

# 4. diag tools (until our image ships them)
docker exec cp-test bash -c 'apt-get update && apt-get install -y --no-install-recommends mesa-utils vainfo'

# 5. GL renderer as the app sees it (Wayland mode: XWayland is :0; X11 mode: Xvfb is :1)
docker exec cp-test with-contenv s6-setuidgid abc env DISPLAY=:0 glxinfo -B
docker exec cp-test with-contenv s6-setuidgid abc env DISPLAY=:0 eglinfo -B

# 6. VA-API, both drivers (relevant to the init-video i965 probe and #170)
docker exec cp-test vainfo --display drm --device /dev/dri/renderD128
docker exec cp-test env LIBVA_DRIVER_NAME=i965 vainfo --display drm --device /dev/dri/renderD128

# 7. which processes hold the render node (expect selkies/python, labwc, Xwayland, CrealityPrint)
docker exec cp-test sh -c 'for p in /proc/[0-9]*; do if ls -l $p/fd 2>/dev/null | grep -q renderD; then echo "$(basename $p) $(cat $p/comm)"; fi; done'

# 8. the app's own GL line
docker exec cp-test sh -c 'grep -rh "got opengl version" /config/.config 2>/dev/null | tail -3'

# 9. cost while running the workload (host)
sudo intel_gpu_top -s 1000          # watch Render/3D and Video %
docker stats cp-test                # CPU % of the container
docker exec cp-test top -b -n 1 -o %CPU | head -20   # Xwayland vs CrealityPrint vs python(selkies)

# 10. GPU hang check after the repeated slices
sudo dmesg | grep -iE 'gpu hang|i915.*reset'
```

Also record from the Selkies sidebar Stats: encoder, capture path, FPS reached while orbiting.

### 10.3 Pass criteria

- **T2:**
  - `glxinfo -B` shows `Mesa Intel(R) UHD Graphics 630`, not `llvmpipe`.
  - The log shows `Renderer: GL on /dev/dri/renderD128` and `Zero-copy capture … VAAPI`.
  - `intel_gpu_top` shows Render/3D busy while orbiting and Video busy while streaming.
  - Container CPU is clearly lower than T1 for the same workload.
- **T3 vs T4** isolate which half (render vs encode) saves more CPU on this box.
- If T2 falls back to `Readback capture` or `No GPU Encoder`, test T5 (i965). If i965 fixes it, our image must either ship `vainfo` (to repair the auto-probe) or set `LIBVA_DRIVER_NAME=i965`/document it.
- If the repeated slices hang the GPU, retry with `-e INTEL_DEBUG=noccs` (put it in the app's launch env) and record the result.

### Notes to carry into Phase 2

- Check that the bundled `libGLdispatch`/`libOpenGL` in the Creality Print AppImage do not break glvnd. Run `LD_DEBUG=libs` on the app, or compare GL with and without deleting them.
- Confirm that Creality Print runs under `GDK_BACKEND=x11`, as Orca does, and whether native Wayland (GDK default) gets a GL canvas at all.
- Confirm where Creality Print writes its log and whether any menu reaches the system info / GL info.
- Note the Mesa version in the container (`glxinfo -B` "OpenGL version string") against the #604/#14453 affected ranges (26.x).

---

## Hands-on results

Run on 2026-11-21, 15:15–15:50 CET, on the Intel UHD 630 host:

- Host: i9-9900K, 16 threads, 31 GiB RAM, Arch Linux, kernel 7.3.5. Device nodes `/dev/dri/card1` (video 983) and `/dev/dri/renderD128` (render 987, mode 0666), driver `i915`.
- Image `crp-research:baseline`: Creality Print **V7.3.1** on `ghcr.io/linuxserver/baseimage-selkies:debiantrixie` (selkies 2.2.1, pixelflux 2.2.3, Mesa 25.0.7), with `PIXELFLUX_WAYLAND=true` and `GDK_BACKEND=x11` patched into AppRun. This is exactly the docker-orcaslicer recipe.
- Variant `crp-research:gpu-diag`: baseline plus `mesa-utils`, `mesa-utils-bin` and `vainfo`.
- Scripts and raw outputs are in `…/scratchpad/agent-F/{scripts,out,shots}`.

**NVIDIA: untested.** There is no NVIDIA host. Everything in §5 stays desk research.

### Verdict

**GPU acceleration works out of the box, exactly like orcaslicer.** Adding `--device /dev/dri:/dev/dri` to the baseline image gives:

- hardware OpenGL for Creality Print (`iris`, UHD 630);
- a GPU-rendered compositor;
- **zero-copy VA-API H.264** encoding.

Container CPU while orbiting a 640k-triangle model drops from **~2.5 cores to ~0.65 cores** at a 1600×900 stream, and the stream carries ~5× more data (more frames). No env vars, no image changes and no group mapping by hand are needed.

> **Later measurement ([12 §4](12-remaining-hands-on.md)):** at a 3200×1800 stream (browser at devicePixelRatio 2), orbiting cost **~7 cores without the GPU vs ~0.6 cores with it**. The no-GPU cost grows with the number of streamed pixels; the GPU cost stays flat. 29-minute runs in both modes showed flat `/dev/shm` and memory (no sign of base issue #142).

```yaml
services:
  crealityprint:
    image: <ours>
    shm_size: "1gb"
    devices:
      - /dev/dri:/dev/dri
```
(`docker run … --shm-size=1gb --device /dev/dri:/dev/dri <image>`)

### Method

- **Workload:** a generated 640,000-triangle bumpy sphere (`scripts/sphere.py`, 32 MB binary STL), loaded at startup by editing the copied `/config/.config/labwc/autostart` to `/opt/crealityprint/AppRun /config/sphere.stl`. Each run starts from a fresh `cp -a` of agent-D's `config-run2`. The stream is locked to 1600×900 (`SELKIES_MANUAL_WIDTH/HEIGHT`).
- **Client:** headless **Google Chrome** (Playwright 1.49 image + `playwright install chrome`, tagged `crp-research:pw-chrome`).
  - The Playwright-bundled Chromium has **no H.264 decoder**, so the Selkies client stepped down to VP9/VP8. Testing with it therefore does not reflect what a real Chrome user gets.
  - With **right-button drag** in the 3D view (left-drag on empty space rubber-band-selects in Creality Print), the client orbits continuously for 40 s.
- **Counters:** sampled over a 30 s window inside the orbit (`scripts/measure.sh`, `snapshot.sh`, `delta.py`):
  - container CPU from the cgroup's `cpu.stat`;
  - per-process CPU from `/proc/<pid>/stat`;
  - **per-process GPU engine time from i915 DRM fdinfo** (`drm-engine-render`/`drm-engine-video`, deduplicated by `drm-client-id`);
  - container `eth0` tx bytes as a proxy for stream throughput.

  `intel_gpu_top` was not used (needs root); fdinfo gives the same data per process without it.
- **App-side screenshots** were taken straight from XWayland with `xwd -id <window>` (`scripts/appshot.sh`), independent of the stream.
- **Concurrency caveat:** two other agents ran containers at the same time (host loadavg 1.6–21 at run start). Configurations were run back-to-back and repeated. The repeats agree within about ±10 %.

### Results: Prepare view, orbiting the 640k-triangle sphere

| Run | Flags | App GL | Encoder (pixelflux log) | Container CPU (100 % = 1 core) | CrealityPrint CPU | selkies CPU | GPU render busy (app) | GPU video busy | Stream tx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **T1 no GPU** (×3) | — | llvmpipe | `H264 (x264) FullFrame`, Pixman readback | **245 / 261 / 261 %** | 229–246 % | 9–10 % | — | — | 1.6–2.0 Mbit/s |
| **T2 GPU auto** (×4) | `--device /dev/dri:/dev/dri` | **iris, UHD 630** | `H264 (VAAPI) FullFrame`, **Zero-copy** | **72 / 62 / 65 / 64 %** | 40–46 % | 11–13 % | 38–52 % | 10–13 % | 10.5–11.2 Mbit/s |
| T3 GPU render, CPU encode | T2 + `-e SELKIES_USE_CPU=true` | iris | `H264 (x264)`, readback | 114 % | 42 % | **59 %** | 55 % | — | 8.5 Mbit/s |
| T4 CPU render, GPU encode | T2 + app env `LIBGL_ALWAYS_SOFTWARE=1` | llvmpipe | `H264 (VAAPI)`, zero-copy | 280 % | **273 %** | 3 % | 0 (app not on GPU) | 1.5 % | 1.1 Mbit/s |
| T5 i965 VA driver | gpu-diag image (has `vainfo`) + device | iris | `H264 (VAAPI)` "zero-copy" | 68 % | 44 % | 12 % | 34 % | 15 % | **0.07 Mbit/s, stream black** |

G-code **Preview** after slicing the sphere (148 layers), same orbit:

| Run | Container CPU | CrealityPrint CPU | Stream tx |
| --- | --- | --- | --- |
| GPU (`--device /dev/dri`) | 69 % | 45 % | 9.7 Mbit/s |
| no GPU | 214 % | 199 % | 2.2 Mbit/s |

Reading the numbers:

- **App rendering is the big win.** Rendering with llvmpipe costs ~2.3–2.7 cores (T1, T4). Rendering on the GPU costs ~0.4 cores for the app process.
- **Encoding is the smaller win.** Moving encode from VA-API to x264 adds ~0.5 cores of selkies CPU at the GPU-rendered frame rate (T3 vs T2). Without a GPU the encode is cheap only because llvmpipe produces so few frames.
- The stream throughput gap (≈11 vs ≈2 Mbit/s at the same CRF) means the CPU-only session delivers far fewer frames while orbiting, i.e. it is visibly less fluid. I could not get an exact FPS: `GALLIUM_HUD=stdout,fps` printed nothing, even with `stdbuf -oL`.
- The 640k-triangle model on llvmpipe was still usable but sluggish. Both configurations ended up with correctly rendered views (screenshots `t1-cpu-r1-b-after-orbit.png`, `t2-gpu-r1-b-after-orbit.png`).

### Renderer strings and evidence the app itself is on the GPU

- `glxinfo -B` on XWayland `:0` (gpu-diag image, with the device):
  ```
  direct rendering: Yes
  Device: Mesa Intel(R) UHD Graphics 630 (CFL GT2) (0x3e98)   Accelerated: yes
  OpenGL renderer string: Mesa Intel(R) UHD Graphics 630 (CFL GT2)
  OpenGL version string: 4.6 (Compatibility Profile) Mesa 25.0.7-2+deb13u1
  ```
  The same result holds with the app's library path (`LD_LIBRARY_PATH=/opt/crealityprint/bin:/opt/crealityprint/usr/lib glxinfo -B`).
- **Bundled `libGLdispatch`/`libOpenGL` concern: not a problem.**
  - The running `CrealityPrint` process maps `/opt/crealityprint/usr/lib/libGLdispatch.so.0` and `libOpenGL.so.0` (bundled) together with the container's `libGLX.so.0`, `libGLX_mesa.so.0`, `libEGL_mesa.so.0` and `libgallium-25.0.7`.
  - It holds `/dev/dri/renderD128` and accumulates `drm-engine-render` time on it (3.95 s right after startup; 38–55 % of the render engine while orbiting).
  - So it gets a **hardware GL context** despite the bundled glvnd pieces. Without the device it holds no render node and burns CPU (llvmpipe).
- Init log with the device:
  ```
  **** creating video group videoz00o with id 987 ****
  **** adding /dev/dri/renderD128 to video group videoz00o with id 987 ****
  **** creating video group videoa7w1 with id 983 ****
  **** adding /dev/dri/card1 to video group videoa7w1 with id 983 ****
  ```
- pixelflux log with the device (baseline image, iHD):
  ```
  [pixelflux] Render node 0 encodes H264, VP8, H265 on vaapi.
  [Wayland] Renderer: GL on /dev/dri/renderD128.
  [Wayland] Encoder: VAAPI H264 4:2:0 8-bit on nv12 surfaces (render node 0, i915 driver).
  [Wayland] Zero-copy capture: output 1 1600x900 rendered on /dev/dri/renderD128, encoded in place on VAAPI.
  ```
- pixelflux log without the device:
  ```
  [pixelflux] No hardware encoder on render node 0 (nvenc): Could not load CUDA library (libcuda.so.1): dlopen failed
  [Wayland] Renderer: software (Pixman), no render node.
  [Wayland] Readback capture: … rendered in software (Pixman), read back for the encode thread (no GPU renderer).
  [Wayland] Readback encode: no hardware encoder opened; encoding in software (x264).
  ```
  The NVENC line is harmless noise.
- The processes holding `renderD128` with the GPU are selkies (pixelflux compositor and encoder), labwc, Xwayland, CrealityPrint and WebKitWebProcess. That confirms the §2.1 inference that nested labwc and XWayland inherit the render node from pixelflux's dmabuf feedback.

### Other findings

1. **i965 breaks the stream on the UHD 630 (important).**
   - In the gpu-diag image `vainfo` is present, so `init-video` prints `**** Intel i965 driver required for this GPU ****` and exports `LIBVA_DRIVER_NAME=i965`. pixelflux then reports `H264, VP8, VP9, H265 on vaapi` and logs a "successful" zero-copy VA-API encoder.
   - But Chrome shows a **black** picture: 0.07 Mbit/s for 30 s while the video engine is 15 % busy, with no console or server errors. Headless Chromium with VP9 on i965 was black too.
   - With the baseline image (no `vainfo`, so iHD is the default) the stream is correct.
   - So the i965 "fix" from [baseimage #170](https://github.com/linuxserver/docker-baseimage-selkies/issues/170) is harmful with pixelflux 2.2.3 on this GPU, and the VPP failure from #170 no longer happens with iHD. **Do not ship `vainfo`**, or the probe re-arms. Users cannot override it with `-e LIBVA_DRIVER_NAME=iHD`, because `init-video` writes the s6 env after reading the user's.
2. **`AUTO_GPU=false` does not disable the GPU on a single-GPU host** (confirms the §4.1 inference). `init-selkies-config` still writes `DRINODE=DRI_NODE=/dev/dri/renderD128`, and the log still shows `Renderer: GL on /dev/dri/renderD128` and zero-copy VA-API. To run without the GPU, don't mount `/dev/dri`. The docs/README claim otherwise.
3. **X11 mode also works** (`-e PIXELFLUX_WAYLAND=false` + device):
   - Log: `**** Xvfb using DRI3 on /dev/dri/renderD128 (i915) ****` and `[X11] Zero-copy capture (DRI3): 1600x900 blitted by the X server into 3 GPU buffers on /dev/dri/renderD128, encoded in place on VAAPI.`
   - `glxinfo -B` on `:1` reports UHD 630, and CrealityPrint accumulates render-engine time.
   - Note that the app autostart lives in the openbox config in X11 mode. Wayland stays the recommended default.
4. **Slicing on the GPU is stable here.** Slicing the 640k-triangle sphere, opening Preview, switching Prepare ↔ Preview and orbiting the G-code preview all worked, with no hang or "Not Responding" ([CrealityPrint #604](https://github.com/CrealityOfficial/CrealityPrint/issues/604) is about Mesa 26.x; we have 25.0.7). `INTEL_DEBUG=noccs` was not needed. Host `journalctl -k` was not readable without root, so a silent GPU reset can't be ruled out completely, but the app stayed responsive.
5. **`Unable to init GLAD OpenGL loader` errors** (three lines at startup) appear in the app log **with and without** the GPU. They come from early calls before the canvas context exists and are harmless. The app log at the default level does not contain the `got opengl version … vendor …` info line, so use `glxinfo -B` or the fdinfo check instead.
6. **Testing tip:** use Google Chrome, not Playwright's Chromium, for stream screenshots. Chromium lacks H.264, so the client silently switches codec (VP9/VP8 via VA-API), which changes what is being tested.

### Not done / open

- NVIDIA (no hardware).
- An exact frame-rate measurement: `GALLIUM_HUD` produced no output; a client-side stats scrape would be the next attempt.
- AMD (no hardware).
- `selkies gpu-probe` was not run.
- Long-session stability (`/dev/shm` growth, [baseimage #142](https://github.com/linuxserver/docker-baseimage-selkies/issues/142)) was not checked.
