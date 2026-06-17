# DuckSoup Conference Lab

Desktop app for running live psychology video sessions with participant video, controller-only face/voice controls, chat, recording, and study metadata.

## What This App Does

- Creates a live video room for dyads, triads, or quads.
- Lets one person join as the controller/RA.
- Lets participants join without seeing the experiment controls.
- Sends controller changes to participant streams during the call.
- Records `.webm` files from participant stations.
- Saves a session manifest and a CSV of live control changes.

## Requirements

- Node.js and npm
- Docker Desktop
- The DuckSoup repo at:

```bash
/Users/iferdous001/Documents/ducksoup-research
```

- This app at:

```bash
/Users/iferdous001/Desktop/Video Conferencing Software
```

## Start DuckSoup

Open a terminal:

```bash
cd /Users/iferdous001/Documents/ducksoup-research/ducksoup-server
docker compose up -d
```

Check that it is up:

```bash
curl http://localhost:8100/health
```

If that command does not respond, DuckSoup is not running.

## Start The Electron App

Open a second terminal:

```bash
cd "/Users/iferdous001/Desktop/Video Conferencing Software"
npm install
npm run dev
```

The app window should open automatically.

If the dev runner does not open a window, use the manual fallback:

```bash
npm run build:manual
npm run start:manual
```

## Mac/Host Setup

Use the Mac as the host for the call server.

1. Open the app.
2. Choose `Controller`.
3. Choose `Dyad`, `Triad`, or `Quad`.
4. Click `Start server here`.
5. Copy the LAN server URL shown by the app. It will look like:

```bash
http://192.168.1.xxx:8765
```

6. Use the same Meeting ID on every computer.
7. Click `Continue to room`.
8. Click `Join room`.

## Participant Computer Setup

On each participant computer:

1. Open the app.
2. Choose `Participant`.
3. Enter the same Meeting ID as the Mac/host.
4. Enter the Mac/host server URL.
5. Enter a display name and station ID.
6. Click `Continue to room`.
7. Click `Join room`.

Participants should then appear in the room.

## Recording

Participant stations record their own local files.

Each recording saves:

- `clean.webm`
- `altered.webm`
- `session_manifest.json`
- `manipulation_events.csv`

The app keeps `.webm` as the output format.

## Notes

- The controller owns the face and voice controls.
- Participants can hide self view without turning off the camera.
- Chat works inside the room and can be sent to everyone, the control room, or one person.
- For a local lab test, all computers should be on the same network.
- If a Windows participant cannot connect, make sure the Windows Wi-Fi profile is set to Private and that the Mac firewall allows incoming connections.

## Stop DuckSoup

```bash
cd /Users/iferdous001/Documents/ducksoup-research/ducksoup-server
docker compose down
```
