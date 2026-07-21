# SyncLink

A video-call app for studying social connection. Two people have a conversation while an
experimenter privately adjusts each person's face and voice in real time, and both the real
and adjusted video are recorded.

## Two roles

**Participants** — the two people talking. They just install the app and click a link. No setup.

**Experimenter / host machine** — one technical computer per lab. It runs the engine (Docker)
and the control panel, sends the join link, and collects the recordings.

---

## For participants

1. Download the installer from the **Releases** page (Mac = `.dmg`, Windows = `.exe`).
2. Open it and click the **link the experimenter sends you**.
3. Allow the camera and microphone. You're in.

First-time-open steps (the app is free/unsigned, so your computer warns you once) are in
[`docs/INSTALL_GUIDE.md`](docs/INSTALL_GUIDE.md).

---

## For the experimenter / host machine

This is the one computer that needs a proper setup. You need **Node.js**, **Git**, and
**Docker Desktop**.

### 1. Get the app

```bash
git clone <repo-url>
cd <repo-folder>
npm install
```

### 2. Start the engine (Docker)

This is the part that adjusts faces/voices and records. One-time build (takes a few minutes),
then start it:

```bash
cd docker/ducksoup && bash fetch-mozza-plugins.sh   # one time
npm run media:up                                    # start
npm run media:down                                  # stop
```

If this runs on a **different** computer from the app, put that computer's network address
(e.g. `http://192.168.1.50:8100`) in the setup screen under **Media Server**. It gets added to
the join link automatically, so participants never type it. Details:
[`docs/DUCKSOUP_INTEGRATION.md`](docs/DUCKSOUP_INTEGRATION.md).

### 3. Run the app and start a session

```bash
npm run dev
```

1. Open the app → **Experimenter login** → `admin` / `admin`.
2. **Copy link** and send it to the two participants.
3. **Continue to room**, then **Join room**.

The experimenter stays in the room for chat and controls without showing up as a video tile.
Before a real lab run, walk through [`docs/RUGGED_TESTING_CHECKLIST.md`](docs/RUGGED_TESTING_CHECKLIST.md).

---

## Recordings

Each participant is recorded twice: a clean video (`-dry.mp4`) and an adjusted one (`-wet.mp4`).
The experimenter saves everything on **Conclude study**. A saved session can include:

- clean + adjusted `.mp4` per participant
- `session_manifest.json`, `pps_playback_manifest.json`
- `manipulation_events.csv`, `chat_log.csv`, `media_quality.csv`

`pps_playback_manifest.json` says which clean and adjusted videos to play together for ratings.

---

## Building the installers

The `.dmg` and `.exe` are built by GitHub, so you don't need a Mac to make the Mac version.
Push a version tag (e.g. `v0.1.0`) or open the **Actions** tab and click **Run workflow**, then
grab the files from the **Releases** page. See [`.github/workflows/build.yml`](.github/workflows/build.yml).

## Updating

```bash
git pull origin main
npm install
npm run dev
```
