# DuckSoup Conference Lab

Research-oriented video conferencing console for live affective manipulation studies.

This app is an Electron + React + TypeScript desktop application designed to sit on top of the DuckSoup/Mozza stack:

```text
Participant camera/mic
→ DuckSoup WebRTC room
→ GStreamer + Mozza media effects
→ partner-facing altered stream
→ local clean/altered recordings + manipulation CSV
→ downstream PPS rating/survey app
```

## What Works In This MVP

- Connects to a self-hosted DuckSoup server at `http://localhost:8100` or another LAN/server URL.
- Loads DuckSoup's browser client script from the DuckSoup server.
- Joins a named two-person DuckSoup room over WebRTC.
- Hides participant self-view by default while retaining an optional diagnostic self check.
- Shows LAN host IPs for two-computer testing.
- Shows WebRTC latency, jitter, and packet-loss stats when DuckSoup stats are available.
- Exposes live Mozza controls for:
  - smile alpha
  - face detection threshold
  - landmark beta
  - smoothing cutoff
  - debug overlay
- Exposes DuckSoup `audioFx` presets for basic pitch and gain changes.
- Records:
  - clean local webcam/mic stream
  - altered returned DuckSoup/Mozza stream
- Writes:
  - clean `.webm`
  - altered `.webm`
  - `session_manifest.json`
  - `manipulation_events.csv`

## Why Electron / React / TypeScript

Electron gives us Chromium's WebRTC, `MediaRecorder`, and camera/microphone behavior with fewer platform surprises than a custom native shell. React + TypeScript keeps the research UI easy to maintain. Rust/Tauri remains a good fit for the PPS rating app, but this conferencing tool benefits from Electron's media support and the existing FES/DuckSoup app patterns.

## Running Locally

Start DuckSoup first:

```bash
cd /Users/iferdous001/Documents/ducksoup-research/ducksoup-server
docker compose up -d
```

Start this app:

```bash
cd "/Users/iferdous001/Desktop/Video Conferencing Software"
npm install
npm run dev
```

For two-laptop testing, see [docs/TWO_COMPUTER_TESTING.md](docs/TWO_COMPUTER_TESTING.md).

## Two-Computer Session Model

For two participants, both stations should point to the same DuckSoup server and use the same Room ID. Each station should use a unique station/participant ID. The experimenter can choose which target user receives live Mozza control commands.

If the two computers are not on the same machine, `localhost:8100` must be replaced with a reachable DuckSoup host URL, and `DUCKSOUP_ALLOWED_WS_ORIGINS` must allow the Electron renderer origin. A production deployment should also use HTTPS/WSS and a TURN server for difficult networks.

## Current Constraints

- Voice pitch and gain are wired as DuckSoup `audioFx` presets. The running DuckSoup image still needs the matching GStreamer elements available.
- More advanced voice warmth, eye-contact redirection, gaze changes, and true synchrony delay still need dedicated DuckSoup/GStreamer pipeline work.
- The clean and altered streams may have different latency because the altered stream travels through DuckSoup/WebRTC/GStreamer before returning.
- Recordings stay as `.webm`. If PPS needs to load these files directly, PPS should accept `.webm`.

## Recommended Next Engineering Steps

1. Validate the DuckSoup audio presets against the lab Docker image and document which GStreamer elements are installed.
2. Add TURN configuration for two-computer sessions outside the same network.
3. Add a true delay/synchrony buffer in the media pipeline, not just a logged design variable.
4. Update PPS to accept `.webm` if DuckSoup recordings should be loaded directly.
5. Add automated pre-session checks for camera, mic, DuckSoup, returned altered stream, recording support, and output folder writability.
