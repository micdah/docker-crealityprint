# Printers

How Creality Print in this image finds, controls and feeds a printer on the LAN, what works through Docker's network, and what never to test.

Tags: **[V]** verified (seen in source, or tested with this image or its research builds), **[I]** inferred.
Verified against: a Creality K1C (stock firmware) and Creality Print 7.3.1 (source read at v7.3.2), Docker bridge network; host networking for the discovery test, on a host running ufw.

- Use Docker's default bridge network and add the printer **by IP**. Status, control, Send Only uploads and both camera types (MJPEG and WebRTC) work through NAT [V].
- Automatic discovery (mDNS) fails on the bridge network. With host networking it also fails behind a stateful host firewall, because the replies come back unicast to random ports [V]. A firewall rule should fix that, but it is unverified [I].
- The IP dialog takes IP octets only, and the printer is stored by IP, so give the printer a DHCP reservation [V].
- A firmware update can move a K1C to TLS on 443 and a WebRTC camera. The app follows by itself [V], so don't document fixed printer ports.
- **Never start a print as a test.** Any start runs the printer's own heat-and-move routine, even for a file with only comments, and can leave the heaters on [V]. **Send Only** is the safe check.

## Connections

| What | Printer endpoint | Through bridge NAT |
|---|---|---|
| Discovery | mDNS query to 224.0.0.251 / ff02::fb, UDP 5353 | No [V] |
| Control and status | `ws://<printer-ip>:9999`, or `wss://<printer-ip>:<wssPort>` (443) | Yes [V] |
| HTTP: `/info`, thumbnails, G-code upload | `<printer-ip>:80` (or 443 with TLS) | Yes [V on 80] |
| MJPEG camera | `http://<printer-ip>:8080/?action=stream` | Yes [V] |
| WebRTC camera | signalling `http://<printer-ip>:8000/call/webrtc_local`, then UDP media | Yes [V] |
| Creality Cloud printing | MQTT and Aliyun OSS uploads, outbound only | Yes [V source] |

Cloud login is covered in [app.md](app.md).

## Adding a printer

- Use the first-run wizard's **Connect Printer via LAN**, or the Device tab. On the bridge network the scan runs about 10 s and shows "No data". Choose **Connect via IP** [V].
- The IP dialog has four octet fields and no hostname field, so a local DNS name can't be used [V].
- After **Confirm Add**, the app detects the model and switches the printer preset to it (e.g. "Creality K1C") without asking [V].
- The add probes TCP 443 and 80 and reads `http(s)://<printer-ip>/info`, which gives `wssPort` and `videoPort` for printers that use TLS (`LanDeviceProbe`) [V source].
- `CP_PRINTER` only seeds the printer profile and its presets in `Creality.conf`. It doesn't connect a network printer; that is always added by IP [V, code].
- Printers are stored in `deviceInfo.json` in the data directory, keyed by IP, with the printer's MAC, model, `secureConnection`, `wssPort` and `videoPort`. The entry survives a re-create, and the container's own MAC and hostname don't matter [V]. Details in [persistence.md](persistence.md).
- If the printer gets a new IP, expect to re-add it. The app's address correction (`addressRevision`) relies on mDNS, which doesn't work on the bridge network [I].

## Automatic discovery

How it works [V source]: `cxnet::syncDiscoveryService` (`cxmdns.cpp`, built on the `mjansson/mdns` library) sends a DNS-SD service enumeration (`_services._dns-sd._udp.local.`) to the mDNS group on every interface. It waits about 5 s and keeps service names that start with `creality`, `Creality` or `CXSWBox` (`_creality…` encodes the model; `_CXSWBox…` is the older Creality WiFi Box). The device page's scan, its address correction and `GUI_App::update_devices_list` use it. The inherited Orca `Bonjour` code, for OctoPrint-type printers, is also present.

| Network mode | Result |
|---|---|
| Bridge (default) | Fails: "No data" [V]. Docker's bridge doesn't forward multicast. |
| Host, on a host running ufw | Fails [V]. The printer does answer mDNS; the replies are dropped (below). |
| Host, no stateful firewall, or with the rule below | Expected to work [I, untested] |
| macvlan / ipvlan | Untested |
| mDNS reflector (e.g. avahi) | Untested. The app uses its own raw sockets, not avahi [I]. |

Why host networking fails behind a stateful firewall [V, on a ufw host]:

- During a scan, `CrealityPrint` sends one-shot queries from one UDP socket per interface, each on an ephemeral port, not 5353.
- Responders answer such queries by unicast to the source port (RFC 6762 §6.7, legacy unicast).
- The query went to a multicast address, so the unicast reply matches no conntrack entry and the firewall drops it. ufw's default rules only accept multicast to 224.0.0.251:5353.
- The same enumeration sent from the host on an ephemeral port got no answer from any device. Sent from port 5353 with group membership, answers came back, the printer's included.

Suggested rule, **unverified**: `ufw allow proto udp from <lan>/24 port 5353`. firewalld needs the equivalent [I].

Host networking, port notes:

- Only `CUSTOM_PORT` and `CUSTOM_HTTPS_PORT` (nginx) listen on all interfaces; compose `ports:` no longer apply. Selkies' websocket (8082) and the app's HTTP server (13666) bind to loopback only [V].
- Two host-mode containers of this image on one machine would clash on 8082 (set `CUSTOM_WS_PORT`) and on 13666 (the app then tries the next 19 ports) [I].

## Control and status

- Creality OS printers (K1 series, Ender-3 V3 family, K2) use `ws://<printer-ip>:9999`. Printers that report `secureConnection` use `wss://<printer-ip>:<wssPort>`, default 443 [V source].
- The Device tab and Details page show live state, nozzle, bed and chamber temperatures with targets, fans, LED and speed mode [V].
- A firmware update can switch a K1C from `ws://…:9999` plus an MJPEG camera to TLS on 443 plus a WebRTC camera. On the next connect the app rewrites `deviceInfo.json` itself (`secureConnection: true`, `wssPort` and `videoPort` 443) [V]. Control then runs over one TLS connection to 443, plus short-lived connections to 8000 for WebRTC signalling; 9999 still answers [V].
- The app's LAN UI can't start a firmware update. None of the `"method":"set"` commands in the bundled device and send pages is an upgrade; firmware appears only as a read-only field and an "Upgrading" label [V source].
- The app can't show a K1C's firmware version. The "Device Information" popover appears only for printers that advertise the `printInfo.deviceInfo` feature, the printer's `modelVersion` field carries only the touchscreen (DWIN) versions, and the app logs `get_version not supported` [V]. Read the version on the printer's own screen.

## Sending G-code

- After slicing, the arrow next to **Send print** offers: Send print, Send to Multi-device, Export G-code, Export all sliced file, Upload to CrealityCloud [V].
- **Send print** opens "Send to Lan Printer": a device picker, a live camera, a **"Print Calibration" toggle that is ON by default** (`calibration: !0`), and two buttons, **Start Print** and **Send Only** [V].
- **Send Only** uploads the sliced plate (`send_gcode`, HTTP to port 80, the `KlipperCXInterface` path) and returns before any start command is sent. The printer stays Idle [V source and test].
- The send dialog always sends the current sliced plate. To put any other file on the printer, use **Import** in the printer's file list (Device → Details → Local Files). It takes `.gcode` and `.3mf` from the container [V].
- Upload code paths by printer type (`RemotePrinterManager`) [V source; only the first tested]:

| Type | Upload |
|---|---|
| `CX` (Creality OS, e.g. K1C) | HTTP to port 80 (`KlipperCXInterface`) |
| `KLIPPER4408` | `POST http://<printer-ip>/upload/<file>`, or HTTPS on 443 |
| `KLIPPER` (Moonraker) | `POST http://<printer-ip>:<port>/server/files/upload`, typically port 7125 |
| `LAN` (CXSWBox, older) | FTP to `/mmcblk0p1/creality/gztemp/`. Passive FTP should pass NAT, active won't [I]. |
| `OCTOPRINT` | HTTP |

With `IDLE_QUIT`, closing the app stops an upload in progress (it may leave a partial file); a print already running carries on. See [idle-quit.md](idle-quit.md).

## Camera

- The device page picks the path [V source]: `webrtcSupport` → WebRTC; else `linuxVideoUrl` → the app's relay; else MJPEG straight from `http://<printer-ip>:8080/?action=stream`.
- **MJPEG** (the K1C on older firmware; likely the K1 and Ender-3 V3 families [I]): WebKit fetches the stream itself, over TCP only [V].
- **WebRTC** (the K1C on newer firmware; the K2 family is expected to use the same path [I]): the app's C++ `WebRTCDecoder` (metartc with bundled FFmpeg, x264, srtp2, usrsctp and opus) decodes the stream and serves it as MJPEG at `127.0.0.1:13666/videostream`, which the page shows. The media is outbound-initiated UDP, so it passes Docker's NAT; a live picture took about 215–240 datagrams/s [V].
- The relay port is `LOCALHOST_PORT`: 13666 (15888 in `CUSTOMIZED` builds). It tries up to 19 higher ports on conflict and binds to loopback only [V source].
- The source also has an RTSP path (`rtsp://<printer-ip>/ch0_0`, served as `/rtspvideostream`) [V source, untested].
- Neither path needs the optional gstreamer packages: WebKit only displays MJPEG, and decoding uses the app's bundled libraries [V]. See [decisions.md](decisions.md).
- Upstream reports a low frame rate for the WebRTC path on Linux (Creality Print #547).
- Status and camera reconnect from scratch whenever the app starts, including after idle quit ([idle-quit.md](idle-quit.md)).

## Starting a print: safety finding

Measured on the K1C [V]:

- **Any start runs the printer's own prepare routine.** A file holding only comments and `M117`, started with `enableSelfTest: 0`, made the printer heat the nozzle (peak 224 °C, then held at 150 °C), heat the bed to 50 °C and move the toolhead for about 2.5 minutes. Then it reported the job complete. The routine lives in the firmware, likely a `START_PRINT`-style preparation with default temperatures [I].
- **The heaters stayed on after "complete":** targets held at 150/50 °C for at least 8 minutes. Whether Klipper's idle timeout turns them off later wasn't observed.
- **Right-click → Start printing in the file list has no confirmation.** It sends `{"method":"set","params":{"opGcodeFile":"printprt:/usr/data/printer_data/gcodes/<file>","enableSelfTest":0}}` at once [V source and test]. "Start Printing (Calibrate First)" sets `enableSelfTest`.
- **The send dialog's "Print Calibration" toggle defaults to ON.**

Rule: **never start a print as a test**, by hand or in automation. Send Only (or Import in the file list) is the safe end-to-end check, and CI never talks to a printer. This is printer behaviour, not a container problem; other Creality OS printers likely behave the same [I].

## Diagnostics

- The app log (`…/Creality Print/7.3/log/debug_<date>_<pid>.log.0`) is at warning level. It records neither discovery nor device-page traffic; a Send Only shows up as a `fire_print_send_event … "command":"send_gcode"` line [V].
- Run `ss` and read `/proc` as the app user (`docker exec -u abc …`). Root in the container lacks `CAP_SYS_PTRACE`, so it can't read the app's `/proc/<pid>/fd`, and `ss -p` shows no process names [V].
- Socket owners [V]: the control WebSocket and the WebRTC UDP socket belong to `CrealityPrint`. HTTP to port 80 (`/info`, thumbnails) and the MJPEG stream belong to a `WebKitNetworkProcess`, and so does the second WebSocket that the "Send to Lan Printer" page opens. With WebRTC, WebKit reads the picture from `CrealityPrint` over loopback (13666).

## Untested

- Every printer except the K1C, the K2 family in particular.
- Discovery with host networking on a host without a stateful firewall, with the ufw rule, with macvlan/ipvlan, or with an mDNS reflector.
- Send Only on TLS firmware (443); the RTSP camera; FTP, Moonraker and OctoPrint uploads.
