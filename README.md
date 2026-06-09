# DuckSoup Conference Lab

Research-oriented video conferencing console for live affective manipulation studies at the Niedenthal Emotions Lab.

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

- Connects to a self-hosted DuckSoup server at `http://localhost:8100`.
- Loads DuckSoup's browser client script from the DuckSoup server.
- Joins a named two-person DuckSoup room over WebRTC.
- Hides participant self-view by default while retaining an optional diagnostic self check.
- Exposes live Mozza controls for:
  - smile alpha
  - face detection threshold
  - landmark beta
  - smoothing cutoff
  - debug overlay
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

## Two-Computer Session Model

For two participants, both stations should point to the same DuckSoup server and use the same Room ID. Each station should use a unique station/participant ID. The experimenter can choose which target user receives live Mozza control commands.

If the two computers are not on the same machine, `localhost:8100` must be replaced with a reachable DuckSoup host URL, and `DUCKSOUP_ALLOWED_WS_ORIGINS` must allow the Electron renderer origin. A production deployment should also use HTTPS/WSS and a TURN server for difficult networks.

## Current Constraints

- Voice warmth, pitch, eye-contact redirection, and true synchrony delay are represented as UI/logging hooks. To make those manipulations scientifically controlled for both participants, they should be implemented as DuckSoup/GStreamer effects.
- The clean and altered streams may have different latency because the altered stream travels through DuckSoup/WebRTC/GStreamer before returning.
- Recordings are `.webm`; the PPS app currently accepts MP4/MOV, so either PPS should accept `.webm` or the session export should add conversion.

## Recommended Next Engineering Steps

1. Add a small DuckSoup deployment profile for lab LAN and remote testing.
2. Add TURN configuration for two-computer sessions outside the same network.
3. Implement audio effects as GStreamer elements or DuckSoup audioFx presets.
4. Add a true delay/synchrony buffer in the media pipeline, not just a logged design variable.
5. Decide whether PPS should consume `.webm` directly or whether this app should export MP4.
6. Add automated pre-session checks for camera, mic, DuckSoup, returned altered stream, recording support, and output folder writability.

