# SyncLink

A real-time platform for studying social connection.

The app supports participant rooms, an Experimenter-only control view, 2-person (dyad) sessions, hosted room links, live chat, self-view hide/show, simple latency display, dual clean + altered `.mp4` recordings, and session timing logs.

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
4. Click `Copy link` (sessions are 2-person / dyad).
5. Send that session link to participants.
6. Click `Continue to room`, then `Join room`.

On each participant computer:

1. Open the app.
2. Paste the session link from the Experimenter.
3. Enter the participant session details.
4. Click `Continue to room`, then `Join room`.

Participants should see each other after they join the same session link. The Experimenter can stay in the room for chat and study controls without appearing as a video participant.

## Local Media / Effects Server

The media/effects server (DuckSoup SFU + Mozza face-only smile warp) carries the live A/V and the
face/voice manipulation. See `docs/DUCKSOUP_INTEGRATION.md` for the full picture.

One-time, fetch/build the Mozza plugin + models (gitignored binaries) via Docker. This builds a patched
plugin, so it can take a few minutes:

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

**Where the media server runs — read before a multi-computer lab install.** The app currently connects
to the media/effects server at `localhost:8100`, so out of the box that server must run on the **same
computer** as each app instance (this is why the single-machine test setup "just works"). To run **one
shared** media server — e.g. on the lab's NVIDIA "gaming PC" — that the participant machines reach over
the LAN, the app has to point at that machine's LAN IP instead of `localhost`, and the field for that is
**not currently in the UI** (a known to-do). Coordinate with Aditya before the multi-machine install. On
the Windows/NVIDIA media-server machine, also set `docker/ducksoup/.env`
(`DUCKSOUP_IMAGE=ducksouplab/ducksoup:latest`, GPU flags off → CPU x264); see `docs/DUCKSOUP_INTEGRATION.md`.

## Local Signaling Test

If Render is unavailable and you need a local-only fallback:

```bash
npm run signal:dev
```

Then use `http://localhost:8765` on the same computer, or the host computer LAN URL from another computer. This is only for troubleshooting.

## Recording

In the default DuckSoup mode, each participant is recorded server-side as a clean (`-dry.mp4`) and an
altered (`-wet.mp4`) file. The Experimenter collects these plus the session files on **Conclude study**.

Each saved session can include:

- a clean `-dry.mp4` and an altered `-wet.mp4` per participant
- `session_manifest.json`
- `pps_playback_manifest.json`
- `manipulation_events.csv`
- `chat_log.csv`
- `media_quality.csv`

For PPS/empathic accuracy ratings, use `pps_playback_manifest.json`. It tells the RA which clean
self video and altered partner video should be shown together for each participant.

The `-dry`/`-wet` videos are written by the media server under
`docker/ducksoup/data/<namespace>/<room>/recordings/`, and are copied to the chosen output folder when
the media server runs on the same machine as the Experimenter app. If no output folder is selected, the
app saves session files to the default lab sessions folder in Documents.

## Update The App

```bash
git pull origin main
npm install
npm run dev
```
