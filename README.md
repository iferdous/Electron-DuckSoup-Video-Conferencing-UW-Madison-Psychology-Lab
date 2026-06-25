# Niedenthal Emotions Lab

Desktop app for running live emotion-study video sessions.

The app supports participant rooms, an Experimenter-only control view, dyad/triad/quad meeting sizes, hosted room links, live chat, self-view hide/show, simple latency display, `.webm` recordings, and session timing logs.

## Install

You need Node.js, npm, Git, and Docker Desktop if you plan to run the local media/effects server.

```bash
git clone <repo-url>
cd <repo-folder>
npm install
```

## Start The Desktop App

```bash
npm run dev
```

If the Electron window does not open, run:

```bash
npm run build:manual
npm run start:manual
```

## Hosted Call Server

The app is set up to use the hosted signaling server:

```text
https://nelf-call-signaling.onrender.com
```

This server coordinates rooms, chat, and WebRTC connection messages. It does not record video and does not replace the local media/effects server.

To deploy or redeploy the hosted signaling server on Render, use the Blueprint in `render.yaml`.

## Run A Lab Session

On the Experimenter computer:

1. Open the app.
2. Click `Experimenter login`.
3. Login with `admin` / `admin`.
4. Choose `Dyad`, `Triad`, or `Quad`.
5. Click `Copy link`.
6. Send that session link to participants.
7. Click `Continue to room`, then `Join room`.

On each participant computer:

1. Open the app.
2. Paste the session link from the Experimenter.
3. Enter the participant session details.
4. Click `Continue to room`, then `Join room`.

Participants should see each other after they join the same session link. The Experimenter can stay in the room for chat and study controls without appearing as a video participant.

## Local Media / Effects Server

The media/effects server (DuckSoup SFU + Mozza face-only smile warp) carries the live A/V and the
face/voice manipulation. See `docs/DUCKSOUP_INTEGRATION.md` for the full picture.

One-time, fetch the Mozza plugin + models (gitignored binaries) via Docker:

```bash
cd docker/ducksoup && bash fetch-mozza-plugins.sh
```

Then start it:

```bash
npm run media:up
npm run media:status
```

To stop it:

```bash
npm run media:down
```

This Docker server runs on the computer that starts it. The hosted Render signaling server is separate.

## Local Signaling Test

If Render is unavailable and you need a local-only fallback:

```bash
npm run signal:dev
```

Then use `http://localhost:8765` on the same computer, or the host computer LAN URL from another computer. This is only for troubleshooting.

## Recording

Recordings are saved as `.webm`.

Each saved session can include:

- `clean.webm`
- `altered.webm`
- `session_manifest.json`
- `pps_playback_manifest.json`
- `manipulation_events.csv`

For PPS/empathic accuracy ratings, use `pps_playback_manifest.json`. It tells the RA which clean
self video and altered partner video should be shown together for each participant.

If no output folder is selected, the app saves sessions to the default lab sessions folder in Documents.

## Update The App

```bash
git pull origin main
npm install
npm run dev
```
