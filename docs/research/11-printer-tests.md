# 11 — Tests against a real Creality K1C

Date: 2026-11-21 · Author: research agent P (hands-on, real printer) · Host: Docker 29, x86_64 Arch Linux, LAN 192.168.1.0/24 on `eno1` (host 192.168.1.204), **ufw active**

Printer: Creality **K1C** "K1C-264A", `creality.home` = **192.168.1.251**, MAC `FCEE2806264A`, stock firmware (not rooted). Before the tests, TCP 80, 8080 and 9999 were open from the host; 443, 4408, 7125 and 8000 were closed.

Legend: **[V]** = verified (observed in this session), **[I]** = inferred.

## Summary

| # | Test | Result |
|---|---|---|
| 1 | Auto-discovery, bridge network | **FAIL (as expected)**: "No data" in the wizard's LAN scan and on "Scan again" [V] |
| 2 | Add by IP, bridge network | **PASS**: connects over WS 9999, shows status and temperatures, and auto-selects the "Creality K1C" printer preset [V] |
| 3 | Camera, bridge network | **PASS**: live MJPEG from `http://192.168.1.251:8080/?action=stream`, fetched directly by WebKit [V] |
| 4 | Camera without the extra gstreamer packages | **PASS**: both MJPEG (before the update) and WebRTC (after the update) camera work in `crp-research:no-gst`, which is 250 MB smaller [V] |
| 5 | Upload sliced G-code without printing | **PASS**: "Send Only" put `crp-cube.stl_PLA_18m9s.gcode` on the printer, and the printer stayed Idle [V] |
| 6 | Harmless print | **PARTIAL / SAFETY FINDING**: start, progress and completion all showed up in the app, but **the K1C firmware ran its own heat-and-move prepare routine even though the file had no heating or motion, and left the heaters on (150 °C / 50 °C) afterwards** [V] |
| 7 | Discovery with host networking | **FAIL on this host, but not because of Docker**: the app queries from ephemeral UDP ports, and **ufw** on the host drops the printer's unicast replies. The printer does answer mDNS (`_Creality-2116062806264A`) [V]. macvlan skipped (the user declined) |
| 8 | Re-create persistence | **PASS**: after `docker rm -f` and re-create on the same `/config`, the printer is still listed and connects immediately (`deviceInfo.json`) [V] |
| — | After the K1C firmware update (17:48) | Idle, heater targets 0. The K1C now uses **TLS on 443 and a WebRTC camera** (the app switched by itself), and the camera **works through bridge NAT** (UDP) [V]. The firmware version isn't shown in the app for a K1C |

**Safety summary (what ran on the printer):** two G-code uploads (Send Only: the sliced cube; Import: the dummy file), and **one** start of the dummy file (`printprt:…crp-research-test.gcode`, `enableSelfTest:0`). The firmware's own prepare routine then heated (nozzle peak 224 °C, held at 150 °C; bed 50 °C) and moved the toolhead, and **left the heaters on** after "complete". No cancel, and no heat/move/fan/light/calibration control was pressed. A K1C firmware update (not started by the app, see §6) began at about 17:22, and all printer contact paused until 17:48. Afterwards the printer was idle with heater targets 0 [V]. **The user deleted the two uploaded files** (`crp-cube.stl_PLA_18m9s.gcode`, `crp-research-test.gcode`) on the printer, and this session confirmed read-only that they're gone (91 files) [V]. After 17:48 only read-only actions and the test 8 re-create were done.

---

## 0. Setup and tooling

Scratch dir (`$P`): `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P`

- Image `crp-research:baseline` (from doc [07](07-hands-on-baseline.md)), plus `crp-research:no-gst`, which I built for test 4.
- UI driver: `$P/scripts/driver.js`, a **persistent** Playwright session (Google Chrome from `crp-research:pw-chrome`, viewport 1600×900, `deviceScaleFactor: 1`, so screenshot pixels equal click coordinates). It takes JSON action lists over HTTP on `127.0.0.1:3690`. Wrappers: `$P/scripts/driver.sh <suffix> <url>` and `$P/scripts/act.sh '<json>'`. Keeping one browser session open avoids Selkies resizing and reconnecting between steps, which made driving the device page reliable.
- Socket-to-process mapper: `$P/scripts/sockproc.sh <container>`. It must run as `abc` (`docker exec -u abc`), because root inside the lsio container lacks `CAP_SYS_PTRACE` and can't read the app user's `/proc/<pid>/fd`. For the same reason, `ss -p` inside the container shows no process names [V].
- Read-only temperature logger: `$P/scripts/templog.py`. It opens `ws://192.168.1.251:9999`, reads the status frames the printer pushes unprompted for 4 s, and closes. It **never sends a message**. Log: `$P/out/templog.txt`.
- mDNS probes: `$P/scripts/mdns_probe.py` (query from an ephemeral port, as the app does) and `$P/scripts/mdns_probe_5353.py` (query from port 5353 with group membership).
- App log: `/config/.config/Creality/Creality Print/7.3/log/debug_<date>.log.0`. It is at warning level, so the device page's WebSocket traffic is **not** logged.

Bridge container (tests 1, 2, 3, 5, 6):

```
docker run -d \
  --name crp-research-P-bridge \
  -p 3600:3000 \
  -p 3601:3001 \
  --shm-size=1gb \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -e TZ=Europe/Copenhagen \
  -v $P/config-bridge:/config \
  crp-research:baseline
$P/scripts/driver.sh bridge http://localhost:3600
```

## 1. Discovery, bridge network — FAIL (expected)

First-run wizard: Professional Edition → Europe → **Connect Printer via LAN**. The "Add devices" dialog scanned for about 10 s and showed **"No data / Total number of devices: 0"**. "Scan again" gave the same result [V]. The dialog offers **Scan again / Connect via IP / Add**.

- `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t1-03-welcome-ready.png`: welcome page (Cloud / LAN / Skip)
- `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t1-05-lan-12s.png`: empty "Add devices" list
- `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t1-06-scan-again.png`: after "Scan again", still empty

The app log has no discovery lines at its default level.

## 2. Add by IP, bridge network — PASS

"Connect via IP" opens a "Scan Devices" dialog with **four separate octet fields** (labelled "IP地址"). There is **no hostname field**, so `creality.home` can't be entered there [V]. I entered `192.168.1.251` and clicked **Confirm Add**.

- The printer was added immediately. The UX-program opt-in window came next (Cancel), then the main window, where the printer preset had been **switched automatically to "Creality K1C"** with a Wi-Fi icon. The wizard had not asked for a printer model [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t2-04-after-ux.png`).
- Device tab: card "K1C-264A", **Idle**, `192.168.1.251` [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t2-05-device-tab.png`).
- Details page: **nozzle 20 °C, bed 19 °C, chamber 0 °C, targets 0**, fan and LED states, and the speed mode were all live [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t3-00-details.png`).
- Connections from the container (`ss -tn` + `sockproc.sh`) [V]:
  - `192.168.1.251:9999` (control WebSocket). This is held by the **`CrealityPrint`** process itself, not by WebKit. The "Send to LAN printer" page opens its own second WS from a `WebKitNetworkProcess`.
  - `192.168.1.251:80`, from a `WebKitNetworkProcess` (HTTP: `/info` probe, thumbnails, uploads).
  - Outbound HTTPS to Creality's cloud CDN (104.18.28.114:443) for the home page.
- `deviceInfo.json` right after the add [V]:

```json
{"groups":[{"group":"New Group1","list":[{"address":"192.168.1.251","addressRevision":0,"connectType":3,
 "deviceUI":"","fluiddPort":0,"mac":"FCEE2806264A","mainsailPort":0,"model":"K1C","moonrakerPort":0,
 "name":"","oldPrinter":false,"secureConnection":false,"videoPort":0,"wssPort":0}]}]}
```

Full paths: `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t2-01-ip-typed.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t2-04-after-ux.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t2-05-device-tab.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t3-00-details.png`.

## 3. Camera, bridge network — PASS

The Details page shows a **live camera image** of the printer's interior, and so does the "Send to Lan Printer" dialog [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t3-00-details.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t5-14-send-dialog.png`).

- URL: **`http://192.168.1.251:8080/?action=stream`** (mjpg-streamer MJPEG). Two connections to `:8080` are held by a **`WebKitNetworkProcess`** [V: `sockproc.sh`]. The C++ WebRTC decoder and the local `127.0.0.1:13666/videostream` relay are **not** used for the K1C.
- Why, from the device UI source (`resources/web/deviceMgr/assets/DZfa5pAs.js`) [V]: `if (printer.webrtcSupport) → WebRTC; else if (printer.linuxVideoUrl) → app relay (switch_webrtc_source); else url = "http://${ip}:8080/?action=stream"`. The K1C has no WebRTC (port 8000 is closed), so the page loads plain MJPEG as an image probe.
- Unicast TCP 8080 through bridge NAT works. No UDP is involved for this model [V].
- Models that use WebRTC (`:8000/call/webrtc_local`, e.g. K2-class) were **not** tested, because no such printer was available [I: they would need UDP media through NAT].

## 4. Camera without gstreamer — PASS

Variant Dockerfile: `$P/image-no-gst/Dockerfile`. It is a copy of `agent-D/image` with the `gstreamer1.0-{gl,libav,plugins-bad,plugins-base,plugins-good,tools,x}` lines removed and only `libwebkit2gtk-4.1-0` kept.

```
cd $P/image-no-gst && docker build -t crp-research:no-gst .
cp -a $P/config-bridge $P/config-nogst          # reuse the configured /config (printer already added)
docker run -d \
  --name crp-research-P-nogst \
  -p 3600:3000 \
  -p 3601:3001 \
  --shm-size=1gb \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -e TZ=Europe/Copenhagen \
  -v $P/config-nogst:/config \
  crp-research:no-gst
```

- Size: **4.77 GB vs 5.02 GB** (−249 MB) [V].
- `gstreamer1.0-plugins-base` and `gstreamer1.0-plugins-good` are **still installed**. They are hard `Depends:` of Debian's `libwebkit2gtk-4.1-0`, so they can't be dropped [V: `apt-cache depends`]. What actually goes away is `gstreamer1.0-gl`, `-libav`, `-plugins-bad`, `-tools` and `-x` (`-gl`, `-libav` and `-plugins-bad` are only webkit *Recommends*).
- Result: the printer was listed from the copied `/config` without re-adding it. **Details → camera shows live video** [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-02-details-nogst.png`). Two shots 3 s apart differ (189 changed pixels in a static scene, i.e. sensor noise, so new frames are arriving) (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-03-live-a.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-04-live-b.png`).
- Processes: `CrealityPrint` and every `WebKitWebProcess` map only the **core** gst libs (`libgstreamer`, `libgstbase`, `libgstvideo`, `libgstapp`, `libgstgl`, …), which come from the base image and webkit's hard dependencies. No plugin from the removed packages is loaded [V: `/proc/<pid>/maps`].
- **WebRTC camera on no-gst (after the K1C firmware update, 17:58): PASS** [V]. Container `crp-research-P-nogst-webrtc` (same `docker run` as above, bridge, 3600/3601) on a fresh copy of `$P/config-bridge` (`secureConnection:true`, `wssPort`/`videoPort` 443). Details → Camera shows **live video**: 1,267 changed pixels between two shots 3 s apart (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4w-01-details-a.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4w-02-details-b.png`).
  - The container's UDP `InDatagrams` rose from 2454 to 3175 in 3 s (**≈240/s**).
  - App↔printer TCP is a single connection to `:443`, and WebKit reads the picture from the app's relay at `127.0.0.1:13666`.
  - `CrealityPrint` maps the **bundled** `libsrtp2.so.1` and `libx264.so.164` plus only the core gst libs. No plugin from the removed packages is used.
- **Conclusion:** neither camera path needs the extra gstreamer packages [V]. That covers MJPEG on `:8080` (K1C before the update, K1/Ender-3 V3 family) and WebRTC (K1C after the update; the same C++ `WebRTCDecoder` path the K2 family uses [I for K2]).

## 5. Upload sliced G-code without printing — PASS

1. Prepare → Ctrl+I → `/config/crp-cube.stl` (a generated 20 mm cube) → **Slice plate** with "0.20mm Standard @Creality K1C 0.4 nozzle", Hyper PLA: 18m9s, 3.48 g [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t5-13-send-menu.png`).
2. The arrow next to **Send print** opens a menu: *Send print / Send to Multi-device / Export G-code / Export all sliced file / Upload to CrealityCloud* [V].
3. *Send print* opens the **"Send to Lan Printer"** window [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t5-14-send-dialog.png`). It has the file name (`crp-cube.stl_PLA_18m9s`), a device picker (192.168.1.251, Local Network, Idle), a live camera, a **"Print Calibration" toggle that is ON by default**, and two buttons: **Start Print** (green) and **Send Only**.
   - Source check before clicking (`resources/web/sendToPrinterPage/assets/D9jJoaG2.js`) [V]: for a LAN device (`deviceType 0`), `visibleSendBtn = true`. `onOnlySend` sets `isOnlySend = true` and uploads; on upload success, `if (isOnlySend) { …; openModal = false; return }`, so no `send_start_print_cmd` is sent.
4. Clicked **Send Only**. App log [V]:
   `fire_print_send_event: frontend_data - {"command":"send_gcode","deviceType":0,"ipAddress":"192.168.1.251",…,"uploadName":"crp-cube.stl_PLA_18m9s.gcode",…}` → `error_code - OK`. No progress modal was visible (the file is small), and the window stayed open with the printer **Idle**.
5. Device → Details → **Local Files**: 91 → **92** files, with `crp-cube.stl_PLA_18m9s.gcode` at the top (thumbnail, layer 0.2, 1.17 m, 0.27 MB). Printer **Idle**, temperatures unchanged at 20/19 °C, targets 0 [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t5-19-device-after-send.png`).

Upload transport: HTTP to `192.168.1.251:80` (two short-lived connections in TIME-WAIT after the upload) [V]. This is the `KlipperCXInterface` path from [03 §7.2](03-creality-print.md).

## 6. Harmless "print" — PARTIAL, with a safety finding

### How the app prints an arbitrary G-code file

There's no "print a local file" button in the send window, because it always sends the current sliced plate. The usable path is the **printer's file list** [V]:

1. Device → Details → **Local Files** → the **Import** icon (tooltip "Import"; next to it are "Export" and a trash icon). A native GTK chooser opens with the filter "Printable files (*.gcode;*.3mf)". I picked `/config/crp-research-test.gcode`, which uploads it to the printer (93 files) [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-00-import-dialog.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-03-after-import-7s.png`).
2. **Right-click** a file card to get the menu **Start printing / Start Printing (Calibrate First) / Export / Delete** [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-04-context-menu.png`).
   - Source (`deviceMgr/assets/DZfa5pAs.js`, `FileContextBtnComponent`) [V]: for a LAN, non-multi-color printer and a `.gcode` file, "Start printing" sends **at once, with no confirmation dialog**: `{"method":"set","params":{"opGcodeFile":"printprt:/usr/data/printer_data/gcodes/crp-research-test.gcode","enableSelfTest":0}}`. `enableSelfTest` comes from a component-local ref that is `false` unless "Calibrate First" was used.

The dummy file, `$P/out/crp-research-test.gcode` (227 bytes):

```
; crp-research dummy print file (Creality Print container research, 2026-11-21)
; Contains no heating, no homing, no motion and no macros.
; The only command below sets the display message.
M117 crp-research test
; end of file
```

Pre-check [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-03-after-import-7s.png`): state **Idle**, nozzle 20 °C, bed 19 °C, all targets 0.

### Timeline (local time, CET)

Sources: the app's Details page (screenshots) up to 17:15:28, then `templog.py` (read-only WS).

| Time | App state | Nozzle cur / target | Bed cur / target | Camera / notes |
|---|---|---|---|---|
| 17:10:12 | Clicked **Start printing** (hovered first: `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-05-hover-start-crop.png`) | 20 / 0 | 19 / 0 | |
| 17:10:13 – 17:10:43 | **Printing**, file `crp-research-test.gcode`, progress bar, no ETA | 20 / 0 | 19 / 0 | No change (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-progress-strip.png`) |
| ≈17:11:23 | Printing | **152 / 150** | **28 / 50** | **Toolhead had moved** into view near the bed (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-11-print-60s.png`) |
| 17:12:08 | Printing | **224** / 150 | 41 / 50 | Nozzle overshot to 224 °C; the target had probably been higher briefly (wipe/clean step?) [I] |
| 17:12:28 | Printing | 190 / 150 | 47 / 50 | |
| 17:12:48 | Printing | 161 / 150 | 48 / 50 | |
| 17:13:08 | Printing | 149 / 150 | 49 / 50 | Toolhead moved again (closer to the camera) |
| 17:13:28 | Printing | 149 / 150 | 50 / 50 | |
| 17:13:48 | **Printing Complete**, "Completion time 11/21 17:13", green 100 % bar | 151 / 150 | 49 / 50 | (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-watch-strip.png`) |
| 17:14:27 – 17:15:28 | Printing Complete | 149–150 / **150** | 49–50 / **50** | **Heaters stay on** (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t6-after-strip.png`) |
| 17:16:36 – 17:21:20 | WS: `state=2`, `printProgress=100`, `err.errcode=0` | ≈150 / **150** | ≈50 / **50** | `$P/out/templog.txt` (6 samples) |
| ≈17:22 | The user reports that a K1C **firmware update** is running and the printer may reboot. All polling stopped | | | See below |

### Findings

- **The K1C firmware runs its own "print prepare" routine when a print starts from its file list, whatever the file contains** [V]. With `enableSelfTest: 0` and a file holding only comments and `M117`, the printer heated the nozzle (peak 224 °C, then held at 150 °C), heated the bed to 50 °C and moved the toolhead, for about 2.5 min, before reporting the job complete [V]. The source of the routine is not visible to us. [I]: Creality's `master-server`/Klipper `START_PRINT`-style preparation with default temperatures (150 °C nozzle for probing/wipe, 50 °C bed).
- **Heaters stay on after completion.** The file had no end G-code, and the firmware didn't turn the heaters off when the job finished. Targets stayed at 150/50 for at least 8 minutes (until polling stopped) [V]. Whether Klipper's `idle_timeout` would eventually turn them off was not observed.
- **I did not cancel the print and did not touch any heater, fan, light or motion control** [V]. The caller and the user were told at about 17:15.
- The app showed print start, live state ("Printing"), temperatures, the camera, and completion ("Printing Complete", completion time, 100 %) [V]. With no slicer metadata, the ETA and layers stay "--" [V].
- The completion time the app shows isn't stable: a second container that opened the page at 17:17 showed "Completion time: 11/21 17:17" for the same job [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-02-details-nogst.png`).
- **Consequence:** there is **no harmless way to test "start print" on a K1C**. Any start, even from a dummy file, heats and moves the printer. Future tests should stop at "Send Only" (test 5).

### The firmware update during the test

About 17:22 the user reported that the K1C was installing a firmware update. Checks [V]:

- The app logs in all three `/config` dirs have **no firmware/OTA/upgrade entries**. The only printer-directed C++ log line is the `send_gcode` upload.
- Every `"method":"set"` command the bundled UI can send over the LAN WebSocket (deviceMgr + sendToPrinterPage):
  - `abortSlice, autoDry, autohome, autoRefill, auxiliaryFanPct, bedTempControl, boxConfig, boxTempControl, caseFanPct, cAutoFeed, cId, cleanErr, colorMatch, cSelfTest, cToRepCutter, ctrlVideoFiles, deleteHistory, deleteLocalFiles, dryBox, enableSelfTest, errorHandling, excludeObjectIds, excludeObjects, fan, fanAuxiliary, fanCase, feed, feedInOrOut, feedOption, feedStateTemp2, gcodeCmd, hostname, ignoreColorToRefill, led, lightSw, loadNozzle, modelFanPct, modifyMaterial, multiColorPrint, nozzleTempControl, opGcodeFile, pause, refreshBox, replaceCutter, repoPlrStatus, setFeedratePct, setNozzleInfo, setNozzleTemp, setPosition, sleepMode, speedMode, stop, switchBox, videoElapse`, plus `parseGCode`/`cancelParseGCode`.
  - None of them is a firmware upgrade. Firmware appears in the UI only as a read-only "Firmware version" field and an "Upgrading" status label.
- What this session actually sent to the printer: status reads from the device pages, two HTTP uploads (Send Only, Import), and one `opGcodeFile: printprt:… enableSelfTest:0`. The temperature logger sent nothing. No update prompt appeared in any screenshot.
- Conclusion: **nothing in this session could start the firmware update** [V for the app's command set; I for what triggered it, probably the printer's own OTA prompt or the user].

All printer contact stopped at about 17:22, on instruction, and resumed at 17:48 once the user confirmed the printer was back and idle.

**After the update (17:48, read-only first)** [V]:
- Passive WS read (`templog.py`, listen only): `state=0` (idle), **`targetNozzleTemp=0`, `targetBedTemp0=0`**, nozzle 37.8 °C, bed 39.4 °C (cooling), `err.errcode=0`. The app's Details page showed the same a minute later (Idle, 36/38 °C, targets 0) (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t8-02-run1-details.png`).
- **Firmware version:**
  - The "before" version was **not recorded**.
  - The "after" version **can't be read in the app for a K1C**. The "Device Information" popover (which holds "Firmware version") only appears when the printer advertises the feature `printInfo.deviceInfo` (or model `F022`) [V: source `cr=computed(... features.includes("printInfo.deviceInfo") ...)`], and the K1C doesn't.
  - The printer's own status frame reports `modelVersion = "printer hw ver:;printer sw ver:;DWIN hw ver:CR4CU220812S11;DWIN sw ver:1.3.5.22;"`, i.e. only the touchscreen (DWIN) versions. The printer software version is empty there.
  - The C++ log has `get_version, get_version not supported, return 00.00.00.00!`. The firmware version has to be read on the printer's own screen.
- **The update changed how the K1C talks to the LAN** [V]. Before the update, 443 and 8000 were closed and the app used `ws://:9999` plus MJPEG on `:8080`. After it, on first connect the app **rewrote `deviceInfo.json` by itself** to `"secureConnection":true,"wssPort":443,"videoPort":443` (before: `false/0/0`). All app↔printer TCP is now a single TLS connection to **`:443`**, held by `CrealityPrint`, plus short-lived connections to **`:8000`** (WebRTC signalling). 9999 still answers too: the passive read at 17:48 used it.
- **Camera after the update: WebRTC, and it works through bridge NAT** [V]. The video is live (1,144 changed pixels between two shots 3 s apart; `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t8-05-run2-details.png`). `CrealityPrint` holds a UDP socket (`0.0.0.0:23949`), the container's UDP `InDatagrams` grew by ≈215/s, and WebKit fetches the picture from the app's relay at `127.0.0.1:13666` (established loopback connections). This is the C++ `WebRTCDecoder` path from [03 §7.3](03-creality-print.md), and outbound-initiated WebRTC UDP works under Docker's default NAT. That was measured on `crp-research:baseline` (with gstreamer). The same path on `crp-research:no-gst` was **not** re-tested [I: likely fine, because decoding happens in the app's bundled FFmpeg and WebKit only shows MJPEG from 13666].
- The two test files had been **deleted by the user** on the printer. A read-only look at Local Files shows **91** files (the original count) and neither test file (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t8-08-localfiles-after.png`).

## 7. Discovery with host networking — FAIL on this host (ufw), printer itself answers

```
docker run -d \
  --name crp-research-P-host \
  --network host \
  --shm-size=1gb \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -e TZ=Europe/Copenhagen \
  -e CUSTOM_PORT=3610 \
  -e CUSTOM_HTTPS_PORT=3611 \
  -v $P/config-host:/config \
  crp-research:baseline
$P/scripts/driver.sh host http://localhost:3610
```

- Ports [V]: 3610 and 3611 were free beforehand, and so was 8082 (Selkies' internal websocket). After start, nginx listens on `0.0.0.0:3610/3611`, and **Selkies' 8082 and the app's internal HTTP server 13666 listen on host loopback only** (`127.0.0.1:8082`, `[::1]:8082`, `127.0.0.1:13666`). `CUSTOM_WS_PORT` didn't need changing. Two app containers in host mode on one machine would clash on 8082 (set `CUSTOM_WS_PORT`) and 13666 (the app retries +1…+19) [I].
- Wizard → **Connect Printer via LAN** → **"No data"**, and the same after "Scan again" [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t7-03-lan-12s.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t7-04-scan-again.png`).
- Root cause [V]:
  - During a scan, `CrealityPrint` has one UDP socket **per interface on an ephemeral port** (`ss -uanp`: 0.0.0.0:35480, :36380, :39303, :51350 and `*:52935`; `$P/out/t7-udp-sockets.txt`). This matches `mjansson/mdns` one-shot queries.
  - Responders answer such queries by **unicast to the source port** (RFC 6762 §6.7). The host runs **ufw** (`systemctl is-active ufw` = active). Its default `before.rules` accept multicast to `224.0.0.251:5353`, but a unicast reply from 192.168.1.251 to a random port matches no conntrack entry (the query went to the multicast address), so it's dropped.
  - Proof: the same DNS-SD enumeration sent from the host on an ephemeral port (`mdns_probe.py`) got **no answers from any device**. Sent from port 5353 with group membership (`mdns_probe_5353.py`), answers arrive by multicast from 14 devices, **including `192.168.1.251 → _Creality-2116062806264A`** (the app's filter matches the `Creality` prefix).
- So on a host **without** a stateful INPUT firewall (or with a rule like `ufw allow proto udp from 192.168.1.0/24 port 5353`), host networking should discover the printer [I, the ufw rule couldn't be tested: no sudo].

**macvlan: skipped.** The user declined it. The ufw finding above stands as is. Whether auto-discovery works with host networking on a host without a stateful firewall, or with macvlan, is **unverified**.

## 8. Re-create persistence

**PASS** [V]. Commands (after the firmware update, 17:49–17:53). `$P/scripts/run-bridge.sh` is the same `docker run` as in §0, on `$P/config-bridge`:

```
$P/scripts/run-bridge.sh                                     # run 1: container 6ca43aa7…
# Device tab → K1C-264A listed, Idle; Details → live data, camera
docker rm -f crp-research-P-bridge
$P/scripts/run-bridge.sh                                     # run 2: new container 8784a947…, same /config
```

- Run 2 shows no wizard. The Device tab lists **K1C-264A / 192.168.1.251, Idle**, still in the list view picked in run 1, and it connects straight away: Details shows temperatures (35/37 °C, targets 0) and live WebRTC video [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t8-04-run2-device.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t8-05-run2-details.png`).
- The secure-connection settings the app learned in run 1 (`secureConnection:true`, 443/443, see §6) were in `deviceInfo.json` and used directly in run 2 (its md5 changed from `8356f5cd…` before run 1 to `55d7f034…` after) [V].

Earlier evidence from test 4, a *different* container (another image) on a *copy* of the `/config` [V]:

- `crp-research-P-bridge` was **stopped**, its `/config` copied (`cp -a $P/config-bridge $P/config-nogst`), and `crp-research-P-nogst` started on the copy.
- Without the wizard and without re-adding anything, Device tab → the "K1C-264A / 192.168.1.251" card, then **connected straight away** (live state "Printing Complete", temperatures, camera) [V] (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-01-device-list.png`, `/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-02-details-nogst.png`). The preset stayed "Creality K1C" too (`/tmp/claude-1000/-home-micdah-git-creality-print--claude-worktrees-bridge-cse-01HFdmZzYuVi21y3XthT5eio/2e84c96b-ac09-50aa-8ba7-4f695573a4c1/scratchpad/agent-P/shots/t4-00-start.png`).
- Where it's stored: **`/config/.config/Creality/Creality Print/7.3/deviceInfo.json`** (groups → list of `{address, mac, model, connectType 3, secureConnection, wssPort, videoPort, …}`; see §2) [V]. The app finds the printer by IP and MAC, so the container's own MAC/IP doesn't matter for LAN printers [V: different container, same result].
- `deviceInfo.json` is keyed by the printer's IP. A printer that gets a new DHCP lease will probably need re-adding or the app's address correction (`addressRevision`, mDNS-based, so not under bridge networking) [I]. Recommend a DHCP reservation for the printer.

## Implications for the image

1. **Default to bridge networking. Document "Add by IP" as the main way to connect a printer** [V]. Status, control WS 9999, HTTP upload (port 80) and the MJPEG camera (8080) all work through NAT, and the printer is detected as K1C, so the preset switches by itself. Tell users the IP dialog takes **IP octets only (no hostname)**, and recommend a **DHCP reservation**, because the stored entry is keyed by IP.
2. **Host networking for auto-discovery: offer it as optional, with a caveat** [V/I]. With host networking, Selkies' 8082 and the app's 13666 bind to host loopback only, so the only ports exposed are `CUSTOM_PORT`/`CUSTOM_HTTPS_PORT`. But discovery **still fails on hosts with a stateful firewall (ufw/firewalld)**: the app queries mDNS from ephemeral ports and gets unicast replies. Document a firewall rule (e.g. `ufw allow proto udp from <lan>/24 port 5353`) or macvlan. Host-mode discovery on a firewall-free host, and macvlan, are **still unverified**.
3. **Drop the optional gstreamer packages** (`gstreamer1.0-gl`, `-libav`, `-plugins-bad`, `-tools`, `-x`). That saves about 250 MB, and **both camera paths work without them**: MJPEG on `:8080` and WebRTC via the app's own decoder and `127.0.0.1:13666` relay. Both were verified on `crp-research:no-gst` with the real K1C [V]. `-plugins-base`/`-good` come in anyway as webkit dependencies.
3a. **WebRTC camera works under Docker's default bridge NAT** [V]: outbound-initiated UDP media, about 215 datagrams/s. No `network_mode: host` is needed for the camera. The R5 note in [09](09-roadblocks-and-risks.md) ("WebRTC/UDP under NAT untested") can be closed.
3b. **Printers can switch to TLS (443) after a firmware update, and the app follows by itself** (`deviceInfo.json` is rewritten) [V]. Nothing in the image needs to change, but docs should not hard-code "port 9999" as the requirement.
4. **Persist all of `/config`**. The printer list is `…/7.3/deviceInfo.json` and survives a new container [V]. Nothing about LAN printers depends on the container's MAC or hostname [V].
5. **Docs warning: starting a print on a Creality OS printer always runs the printer's own prepare routine (heating, homing/wipe), even for a G-code file without start code, and a file without end code leaves the heaters on** [V]. This is printer behaviour, not a container problem, but it matters for anyone (or any CI) that wants to "smoke test" printing through the container. **Never automate a start-print test against a real printer.** Upload-only ("Send Only" or the file list's Import) is the safe end-to-end check.
6. The send dialog's **"Print Calibration" toggle defaults to ON** (`calibration: !0`), and the file list's "Start printing" item starts **without a confirmation dialog** [V]. Worth a line in the user docs.
7. UI and process notes for whoever writes tests or healthchecks: the camera stream belongs to `WebKitNetworkProcess`, and the control WS belongs to `CrealityPrint` [V]. The app log (warning level) doesn't record printer traffic, so use `ss`/`/proc` as `abc` for diagnostics [V].

## Cleanup and artefacts

- All `crp-research-P-*` containers removed (`docker ps -a --filter name=crp-research-P` is empty). No docker network was created [V].
- Images built and kept: **`crp-research:no-gst`** (4.77 GB, Dockerfile `$P/image-no-gst/Dockerfile`). Images used: `crp-research:baseline`, `crp-research:pw-chrome`.
- The test files on the printer were removed **by the user**, confirmed read-only (91 files, neither test file listed) [V].
- Scratch artefacts under `$P`:
  - `config-bridge/`: configured `/config` with the K1C added (now `secureConnection:true`); used for test 8.
  - `config-nogst/`, `config-host/`
  - `shots/`: 81 PNGs, 1600×900. The t1–t8 prefixes match the test numbers. Strips: `t6-progress-strip.png`, `t6-watch-strip.png`, `t6-after-strip.png`
  - `out/`: `templog.txt`, `t7-udp-sockets.txt`, `build-no-gst.log`, `cube.stl`, `crp-research-test.gcode`
  - `scripts/`: `driver.js`, `driver.sh`, `act.sh`, `run-bridge.sh`, `sockproc.sh`, `templog.py`, `mdns_probe.py`, `mdns_probe_5353.py`, plus copies of agent-D's `pw.sh`, `steps.js`, `cube.py`
- **Open points**:
  - Firmware version before the update was not recorded, and the version after can't be read in the app; read it on the printer's screen.
  - Host-mode discovery on a host without a stateful firewall is unverified, and so is the suggested ufw rule. macvlan was skipped (the user declined).
  - K2-family printers are untested.
