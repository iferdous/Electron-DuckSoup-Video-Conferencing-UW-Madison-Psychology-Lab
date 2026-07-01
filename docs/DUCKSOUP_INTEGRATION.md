# DuckSoup / Mozza media path (face-only smile)

This app now routes live A/V **and** the face/voice manipulation through the **DuckSoup** WebRTC SFU
with the **Mozza** GStreamer plugin (a landmark-based, **face-only** smile warp), instead of the old
2D-canvas warp that deformed the whole frame. This is the fix for blocking bug **#1**.

It is a **hybrid** design:

- **Lobby / coordination** stays on the hosted Render signaling server: session links, roles, presence,
  chat, experimenter login, and the experimenter→participant control channel (`director-control`).
- **Media + manipulation** flow through DuckSoup: each participant connects to a DuckSoup *interaction*
  (`interactionName = roomId`) with `videoFx = "mozza … name=video_fx"`. The experimenter's Face
  Modulation sliders are relayed over `director-control`; each participant's own client then calls
  `player.controlFx("video_fx","alpha",…)` on its own pipeline. The transformed stream is what the
  **partner** receives and what gets recorded; the participant's **self-view is the raw, unedited camera**.

Switch it off (fall back to the legacy canvas mesh) with the **"Face-only smile via DuckSoup/Mozza"**
toggle in the experimenter setup → Advanced, or by clearing the media-server URL.

## Control mapping (verified via `gst-inspect-1.0 mozza`)

| App slider (`smileAlpha` etc.) | Mozza property | Notes |
| --- | --- | --- |
| Smile alpha | `alpha` (float, neutral **0**, positive = smile, negative = frown) | interpolated live (~300 ms) |
| Detection threshold | `face-thresh` (double, 0–1) | dlib detector confidence |
| Landmark beta | `beta` (float, 0–1) | One-Euro filter lag |
| Smoothing cutoff | `fc` (float) | One-Euro filter jitter cutoff |
| Debug overlay | `overlay` (bool) | render-time only (landmark debug) |
| Outgoing voice tone | `pitch` on `audio_fx` | other voice controls remain canvas-only for now |

## Run it (this machine / prototype)

1. **One-time: build the lab-patched Mozza plugin + fetch its models** (gitignored binaries):
   ```bash
   cd docker/ducksoup && bash fetch-mozza-plugins.sh
   ```
   Leaves `libgstmozza.so`, `libimgwarp.so`, `smile10.dfm`, `shape_predictor_68_face_landmarks.dat` in
   `docker/ducksoup/plugins/`. The build applies `mozza-jitter-fix.patch`, which makes the warp use
   filtered landmarks, wires live `face-thresh`, `beta`, and `fc` values into the active tracker, and
   resets stale filter history when a face is reacquired.
2. **Start the media server**: `npm run media:up` (or `cd docker/ducksoup && docker compose up`).
   The default image is `ducksouplab/ducksoup:arm_latest` for Apple Silicon lab Macs; advanced hosts can
   change `DUCKSOUP_IMAGE` in `docker/ducksoup/.env`.
   Sanity: `http://localhost:8100/test/mirror/` (login `admin`/`admin`), Video FX
   `mozza deform=smile10 alpha=1.1 beta=0.001 fc=1.0` → your face smiles, background unchanged.
3. **Run the app**: `npm run dev`. The experimenter's media-server URL defaults to `http://localhost:8100`
   (editable in Advanced; it is also carried to participants in the session link as `?ds=`).
4. **Dyad test** needs **two participant instances with cameras**, and both must press **Join within
   ~15 s of each other** (DuckSoup aborts an interaction that doesn't fill in time).

## Quick tests (no app / no second computer needed)

The media server's built-in test pages exercise the exact same DuckSoup + Mozza + `controlFx` path the
app uses. Login is `admin` / `admin`. The app now requests **480×360 at 15 fps** for both capture and
processing. Use the same values on the test page. The dlib face detector is the CPU bottleneck; higher
resolution/frame-rate settings can create a processing backlog that looks like network jitter.

**A) Face-only smile (1 webcam):** open `http://localhost:8100/test/mirror/`, set Frame rate `15`,
Width `480`, Height `360`, GPU off unless the host has NVIDIA support, and Video FX:
```
mozza deform=smile10 alpha=1.1 beta=0.02 fc=0.3 name=video_fx
```
Start → your face smiles, background unchanged.

**`alpha` value reference (smile intensity):** `0` = neutral (no warp) · positive (`0.5`, `1`) = bigger smile ·
negative (`-0.5`, `-0.9`) = frown. Keep it roughly `-1` to `1` for natural results.

**Change it live** (no restart): in the **"Update Video FX"** box → property `alpha`, value `-0.9`,
transition `1000`, **Send** → morphs to a frown over 1 s. Lower `fc` (e.g. `0.3`) = smoother/less jitter.

**B) Full dyad on ONE machine (two browser tabs):** open `http://localhost:8100/test/interaction/` in a
normal window AND an Incognito window (Ctrl+Shift+N). Tab 1: User name `alice`; Tab 2: User name `bob`.
Both: Interaction name `lab1`, Size `2`, Frame rate `15`, 480×360, GPU off unless the host has NVIDIA
support, same Video FX as above. Click
**Start in both within ~15 s**. Each tab shows the other peer's warped video (same face twice — one
webcam, expected). Then in Tab 1's "Update Video FX": User name `bob`, property `alpha`, value `1.6`,
transition `1000`, **Send** → bob's face smiles. That's exactly what the app's Smile-alpha slider does.

## Recording

`recordingMode = "reenc"`: the server writes, per participant, a **clean `-dry`** and an **altered `-wet`**
file under `docker/ducksoup/data/<namespace>/<interaction>/recordings/` (namespace = study ID slug,
interaction = room ID), plus its own ms event log. When a station leaves or the experimenter clicks
**Conclude study**, the app writes `session_manifest.json`, `pps_playback_manifest.json`, and
`manipulation_events.csv` to the chosen output folder and, **if the media server is on this machine**,
copies the dry/wet files into the session's `video/` folder. If the server is on another computer, the
files stay there and the manifest records their server-side location.

`pps_playback_manifest.json` is the bridge to empathic accuracy ratings. For each participant, it points
to the intended playback pair: **unmanipulated self video** (`clean`/`dry`) and **manipulated partner
video** (`altered`/`wet`). If the filename pattern is unclear, the manifest keeps the best candidate
files so the RA can verify before loading the PPS task.

## Live synchrony controls

The experimenter can now change synchrony during the conversation instead of choosing the condition only
beforehand:

- **Aligned** returns the target to neutral smile alpha.
- **Suppressed** applies the configured suppressed smile alpha to the selected participant or everyone.
- **Reactive** keeps the session in cue-response mode. Cue buttons can trigger a temporary frown/dampened
  smile or a repair smile, then return to baseline after the configured pulse duration.

Controls are target-aware: choose one live participant in **Control target**, or leave it on **All
participants**. Every synchrony mode change and cue response is written to `manipulation_events.csv`.
The original cue buttons remain manual experimenter triggers. The separate automatic smile-onset module
runs from participant clean feeds and supports **Off**, **Detect**, and **Live aligned** modes. It never
detects from altered video, and the experimenter does not approve individual events. Live mode sends the
validated event directly to the dyad partner and applies a fixed, non-stacking Mozza envelope. Automatic
events and response stages are written to `smile_onset_events.csv`. Keep this feature in internal testing
until lighting, camera angle, speech false positives, target routing, timing, face loss, and awareness have
passed the validation gates in `DYAD_SYNCHRONY_PLAN.md`.

Each DuckSoup participant also writes `media_quality.csv` at session finalization. It samples WebRTC
transport data about once per second (RTP jitter, RTT when reported, packet loss, dropped frames, bitrate,
and mean jitter-buffer delay). Use this file to distinguish network/playback instability from Mozza
landmark shake. See `DYAD_SYNCHRONY_PLAN.md` for the proposed closed-loop cue architecture and validation
gates.

## Known limitations / follow-ups

- **No live experimenter video monitoring in DuckSoup mode.** A DuckSoup peer always sends media, so the
  experimenter can't be a silent observer the way the legacy mesh's recv-only path allowed. The
  experimenter drives manipulation from the panel and reviews the recordings. *Follow-up:* join the
  experimenter as a hidden observer peer (dummy/black track) and filter it out on participant tiles.
- **Interaction duration is capped at 1200 s (20 min)** server-side; longer conversations must rejoin.
- **Packaged builds load the renderer from `file://`** (Origin `null`), which the SFU's strict
  `DUCKSOUP_ALLOWED_WS_ORIGINS` check rejects. The dev server (`http://localhost:5173`, pinned) is fine.
  *Follow-up for production:* load the renderer over `http://localhost` from the main process, or add the
  packaged origin to the allow-list.
- **Voice:** only outgoing pitch is routed through DuckSoup so far; gain / delay / tone-shelving remain on
  the legacy canvas/WebAudio path.
- Mozza is CPU-heavy (dlib landmarks + warp). A full dyad on one laptop may strain; the intended topology
  is the gaming PC as the DuckSoup server with Electron on the lab Macs.
