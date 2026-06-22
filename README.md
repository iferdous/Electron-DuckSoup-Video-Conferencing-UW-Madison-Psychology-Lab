# Niedenthal Emotions Lab

Desktop app for running live emotion-study video sessions.

The app supports participant rooms, an Experimenter-only control view, dyad/triad/quad meeting sizes, live chat, self-view hide/show, simple latency display, `.webm` recordings, and session timing logs.

## Install

You need Node.js, npm, Git, and Docker Desktop if you plan to run the local media/effects server.

```bash
git clone <repo-url>
cd <repo-folder>
npm install
```

## Start The App

```bash
npm run dev
```

If the Electron window does not open, run:

```bash
npm run build:manual
npm run start:manual
```

## Start The Local Media Server

Only the host computer needs to run this.

```bash
npm run media:up
npm run media:status
```

To stop it:

```bash
npm run media:down
```

## Run A Lab Session

Use one computer as the host. In our testing this is usually the Mac.

On the host computer:

1. Open the app.
2. Click `Experimenter login`.
3. Login with `admin` / `admin`.
4. Choose `Dyad`, `Triad`, or `Quad`.
5. Click `Start call server`.
6. Give participants the Meeting ID and the host server URL shown in the app.
7. Click `Continue to room`, then `Join room`.

On each participant computer:

1. Open the app.
2. Enter the same Meeting ID.
3. Enter the host server URL.
4. Enter the participant session details.
5. Click `Continue to room`, then `Join room`.

Participants should see each other after they join the same Meeting ID. The Experimenter can stay in the room for chat and study controls without appearing as a video participant.

## Notes For Two Computers

- On the host computer, `localhost` is okay because the server is running there.
- On another computer, do not use `localhost`; use the host computer URL shown in the app.
- Both computers should be on the same network for local testing.
- If Windows cannot connect, set the Wi-Fi network profile to `Private`.
- If macOS asks about incoming connections, allow the app on the local network.

## Recording

Recordings are saved as `.webm`.

Each saved session can include:

- `clean.webm`
- `altered.webm`
- `session_manifest.json`
- `manipulation_events.csv`

If no output folder is selected, the app saves sessions to the default lab sessions folder in Documents.

## Update The App

```bash
git pull origin main
npm install
npm run dev
```
