# DuckSoup Conference Lab

Desktop app for running live video-conference sessions for psychology studies.

The app supports:

- participant and controller views
- dyad, triad, and quad rooms
- live video and audio between computers
- controller-only face and voice controls
- room chat
- self-view hide/show
- `.webm` recordings
- session metadata and manipulation timing logs

## What You Need

- Node.js
- npm
- Git
- Docker Desktop, only if you are running the local DuckSoup/Mozza server

## Get The App

```bash
git clone git@github.com:iferdous/Electron-DuckSoup-Video-Conferencing-UW-Madison-Psychology-Lab.git
cd Electron-DuckSoup-Video-Conferencing-UW-Madison-Psychology-Lab
npm install
```

If SSH is not set up on your computer, use the HTTPS clone URL from GitHub instead.

## Start The App

```bash
npm run dev
```

If the window does not open, use:

```bash
npm run build:manual
npm run start:manual
```

## Start The Local DuckSoup Server

Only one computer needs to run this for a local lab test.

```bash
cd docker/ducksoup
cp env.example .env
docker compose up -d
```

Check it:

```bash
curl http://localhost:8100/health
```

Stop it:

```bash
cd docker/ducksoup
docker compose down
```

## Run A Session

Use one computer as the controller/host.

On the controller computer:

1. Open the app.
2. Choose `Controller`.
3. Choose `Dyad`, `Triad`, or `Quad`.
4. Click `Start server here`.
5. Copy the server URL shown in the app.
6. Keep the Meeting ID visible.
7. Click `Continue to room`.
8. Click `Join room`.

On each participant computer:

1. Open the app.
2. Choose `Participant`.
3. Enter the same Meeting ID.
4. Enter the controller/host server URL.
5. Enter a display name and station ID.
6. Click `Continue to room`.
7. Click `Join room`.

Participants should appear in the room after they join.

## Recording

Participant stations save their own files.

Each recording creates:

- `clean.webm`
- `altered.webm`
- `session_manifest.json`
- `manipulation_events.csv`

The output format is `.webm`.

## Important Notes

- The controller is the only role that sees the face and voice controls.
- Participants can hide self view without turning off the camera.
- Chat can go to everyone, the control room, or one person.
- For a local lab test, all computers should be on the same network.
- If Windows cannot connect, set the Windows Wi-Fi network profile to `Private`.
- If macOS asks about incoming connections, allow the app on the local network.

## Update The App

```bash
git pull origin main
npm install
```

Then start the app again with:

```bash
npm run dev
```
