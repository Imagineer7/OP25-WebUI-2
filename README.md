# This is a fork of boatbods fork of OP25
I’ve improved the web interface and added a **audio streaming** feature in a new file `streamer_multi_rx.py`. Users can enable streaming with simple flags (no hand-crafted `ffmpeg` services required). The installer can optionally set up all streaming dependencies (FFmpeg, Pulse/PipeWire utils, Icecast2) and a systemd unit.
---
#Sample of the new web interface.
![New webpage layout for op25](https://github.com/Imagineer7/OP25-WebUI-2/blob/master/2025-08-26_17-06.png)
---

## Quick start (Debian/Ubuntu/Raspberry Pi OS)
#- NOTE - If you already have op25 installed.
Then you only need to update your web server files for op25 which are under /op25/gr-op25_repeater/www/www-static. 
If you want the updated webpage then just replace your index.html, main.css, and main.js files with the ones from
this respritory. Also if you want the background images copy them from /op25/gr-op25_repeater/www/www-static/images
in this respirtory to the same directory on your machine. You will need to also update the http_server.py in order
to get the background images to load. The updated http_server.py file is under /op25/gr-op25_repeater/apps. Replace
it just like all previous files.

# Base install (builds OP25 like before)
./install.sh -f

# Optional: add streaming depenants (FFmpeg + pactl), Icecast, and a systemd service
./install.sh -f -S -I -a <password> -m op25.mp3 -U op25 -C /opt/op25/op25.json

Installer flags:

- `-f` — noninteractive apt (`-y`)
- `-S` — install streaming deps: **ffmpeg**, **pulseaudio-utils** (provides `pactl`)
- `-I` — install & enable **Icecast2** and set the source password
- `-a <pass>` — Icecast **source** password - REQUIRED -(default pass is "op25")
- `-m <mount>` — Icecast mount name (default: `op25.mp3`)
- `-U <user>` — create & enable a **systemd** service running as this user
- `-C <config>` — path to your OP25 **JSON** config for the service

After installing with `-I`, listen at:
http://<host>:8000/<mount>      # e.g., http://localhost:8000/op25.mp3

> You can still stream without Icecast: write to a file or use a TCP socket for development.

---

## Built-in audio streaming (streamer_multi_rx.py)

Launch OP25 with `--stream-*` flags. Under the hood, OP25 spawns and manages `ffmpeg` and cleans it up on exit. Pulse/PipeWire monitor detection is automatic (or use ALSA).

### Examples

**Icecast (recommended for web playback)**
python3 streamer_multi_rx.py -c op25.json   --stream-url "icecast://source:<password>@127.0.0.1:8000/op25.mp3"   --stream-device pulse   --stream-format mp3 --stream-bitrate 64k   --stream-rate 22050 --stream-channels 1   --stream-restart --stream-log /var/log/op25-ffmpeg.log

**File output (quick test)**
python3 multi_rx.py -c op25.json --stream-url "file:/tmp/op25-test.mp3"

**Simple TCP stream (dev only)**
python3 multi_rx.py -c op25.json --stream-url "tcp://0.0.0.0:8001"

### New command line options (multi_rx.py)

- `--stream-url` — Destination:  
  `icecast://source:pass@host:8000/mount.mp3`, `file:/path/out.mp3`, `tcp://0.0.0.0:8001`, etc.
- `--stream-device` *(default: `pulse`)* — Input for ffmpeg. `pulse` auto-detects a monitor; or use `alsa` or an explicit device (e.g. `alsa_output…monitor` or `hw:0,0`).
- `--stream-format` *(default: `mp3`)* — `mp3|aac|opus|flac`.
- `--stream-bitrate` *(default: `64k`)* — For lossy codecs (`mp3|aac|opus`).
- `--stream-rate` *(default: `22050`)* — Sample rate in Hz.
- `--stream-channels` *(default: `1`)*.
- `--stream-content-type` — Override content-type (auto-set for Icecast).
- `--stream-restart` — Auto-restart ffmpeg if it exits unexpectedly.
- `--stream-log` — Path to write ffmpeg stdout/stderr.

**Web UI integration:** when streaming is enabled, the backend includes a `direct_stream_url` in the status JSON so the web UI can show a single “Play” button for your configured stream.

---

## Dependencies for streaming

- **FFmpeg** with needed encoders (MP3 via `libmp3lame` is safest).
- **Pulse/PipeWire utilities** (for `pactl`) if using `--stream-device pulse`:  
  `pulseaudio-utils` on Debian/Ubuntu/Raspberry Pi OS (works with pipewire-pulse too).
- **Icecast2** *(optional)* if using `icecast://…` destinations.

The installer’s `-S` and `-I` flags handle these for you.

### Headless / service notes

- Pulse/PipeWire usually runs in a **user session**. If OP25 runs as a system service, `pactl` monitor detection may fail. Options:
  - Run the service as the **desktop user** that owns the Pulse/PipeWire session, or
  - Use `--stream-device alsa`, or
  - Provide an explicit Pulse monitor name to `--stream-device`.
- Check available monitors:
  pactl list short sources | grep monitor

---

## `rx.py` capabilities

- P25 Conventional (single frequency)  
- P25 Trunking Phase 1, Phase 2 and TDMA Control Channel  
- P25 Phase 2 tone synthesis  
- Single SDR (dongle) tuning regardless of bandwidth  
- TGID Blacklist, Whitelist with dynamic reloading  
- TGID Priority with mid-call preemption  
- Multi-system scanning (switches between multiple systems sequentially)  
- TGID text tagging and metadata upload to Icecast server for streaming  
- Dynamically controllable real-time plots: FFT, Constellation, Symbol, Datascope, Mixer, Tuning  
- Dynamically controllable log level  
- Curses or HTTP based terminal  
- Demodulator symbol capture and replay  
- Voice Encryption detection and skipping (configurable behavior)  
- Automatic fine tune tracking using Frequency Locked Loop (FLL)

---

## `multi_rx.py` capabilities

- P25 Conventional (multiple frequencies)  
- P25 Trunking Phase 1, Phase 2 and TDMA Control Channel  
- P25 Phase 2 tone synthesis  
- Motorola SmartZone Trunking (requires two dongles)  
- Motorola Connect+ TRBO DMR Trunking (experimental, requires two dongles)  
- DMR BS Mode (non-trunked)  
- NBFM analog (conventional or SmartZone trunked)  
- Multi-system/multi-channel concurrent operation (full time, not sequential)  
- Single, Multiple and Shared SDR devices (e.g., wideband devices such as Airspy)  
- TGID Blacklist, Whitelist with dynamic reloading  
- TGID Priority with mid-call preemption  
- TGID text tagging and metadata upload to Icecast server for streaming 
- RID text tagging  
- Dynamically controllable real-time plots: FFT, Constellation, Symbol, Datascope, Mixer, Tuning  
- Dynamically controllable log level  
- Awesome new HTTP based terminal by Outerdog(RR)/Triptolemus510(github)  
- JSON based configuration  
- DSD `.wav` and `.iq` file replay  
- Dynamic demodulator symbol capture and replay (commanded through terminal)  
- Voice Encryption detection and skipping (configurable behavior)  
- Automatic fine tune tracking using Frequency Locked Loop (FLL)

---

## Encryption capabilities

Real-time decryption of encrypted P25 voice traffic is supported for several commonly used protocols **when you provide the correct key**. OP25 does **not** break unknown keys.

- ADP/RC4  
- DES-OFB  
- AES-256

---

## Roadmap (under development)

- Demodulator improvements to speed up channel lock-time  
- Additional encryption algorithms  
- Well-written code contributions are welcome — please submit PRs against the **dev** branch

---

## History

- Forked from `git://git.osmocom.org/op25` “max” branch on 2017-09-10  
- Up to date with osmocom “max” branch as of 2018-03-03  
- Note: as of 2019, codebase has diverged too far to continue syncing with osmocom

### Many changes

- New DQPSK demodulator chain with automatic fine tuning & tracking  
- UDP python audio server `sockaudio.py` and remote player `audio.py`  
- Wireshark fixes (experimental)  
- Ability to configure NAC 0x000 in `trunk.tsv` and use first decoded NAC  
- Integrated N8UR logging changes to trunking.py  
- Real-time fine tune adjustment (,./<> keys)  
- Dynamically resizable curses terminal  
- Toggle plots from the terminal (keys 1-5)  
- New “mixer” and “fll” plots (keys 5 & 6)  
- Reworked trunking hold/release logic (improves Phase 1 audio on some systems)  
- Decode and log encryption sync info (“ESS”) at log level 10 (`-v 10`)  
- Option to silence playing of encrypted audio  
- Encrypted audio flag shown on terminal  
- Source radio ID displayed (if available)  
- `--wireshark-host` accepts IPs or hostnames  
- Voice-channel trunk signaling passed up to trunking module  
- Optional trunk group priority column in `tgid-tags.tsv`  
- Ranges in blacklist/whitelist files  
- Streaming metadata updates (both `rx.py` and `multi_rx.py`)  
- MotoTrbo Connect+ and Motorola SmartNet/SmartZone trunking (`multi_rx.py`)  
- Enhanced `multi_rx.py` with P25, DMR, SmartNet trunking, terminal, and built-in audio player  
- **New:** first-class `ffmpeg` streaming management in `multi_rx.py` (via `--stream-*`)

---

## New command line options (legacy & general)

- `--fine-tune` — sub-ppm tuning adjustment  
- `--wireshark-port` — facilitates multiple instances of `rx.py`  
- `--udp-player` — enable built-in audio player  
- `--nocrypt` — silence encrypted audio

**Note 1:** `--nocrypt` will silence encrypted audio, but trunking logic remains on the active TGID until the transmission ends. Prefer blacklisting always-encrypted TGIDs; use `--nocrypt` for mixed-use TGIDs.

**Note 2:** `tgid-tags.tsv` may include an optional 3rd numeric column for **priority** (lower number = higher priority). Columns are TAB-separated.

Example:
11501	TB FIRE DISP	2
11502	TB FIRE TAC2	3
11503	TB FIRE TAC3	3
11504	TB FIRE TAC4	4
11505	TB FIRE TAC5	3

---

## Troubleshooting streaming

- **No Pulse monitor detected**  
  Use `--stream-device alsa` or specify an explicit `.monitor`. Check with:  
  `pactl list short sources | grep monitor`

- **Icecast 401/403**  
  Ensure Icecast `<source-password>` matches the one in `--stream-url`.

- **Choppy audio**  
  Try `--stream-rate 22050` (default) or `16000`, and keep `--stream-bitrate` modest (e.g., `64k`).

- **Service can’t see Pulse**  
  Run the service as your desktop user, or switch to `--stream-device alsa`.

---

## Security notes

If you embed credentials in `--stream-url`, they may show up in process lists. Prefer environment variables in systemd (installer unit uses `Environment=ICECAST_PASS=…` and substitutes it into the URL).
