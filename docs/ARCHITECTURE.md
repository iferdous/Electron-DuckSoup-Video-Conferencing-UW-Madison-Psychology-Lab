# Architecture Notes

## Research Framing

The attached affective-predictability notes describe social connection as emerging partly from whether an interaction partner's emotional responses are predictable, responsive, and felt as socially meaningful. This app is designed to let an experimenter manipulate pieces of that emotional signal during a live conversation, then preserve the exact timing of those manipulations for later analysis.

## Relationship To Existing Apps

```text
DuckSoup/Mozza app
  live stream transport and manipulation
  records clean and altered video

PPS Tauri app
  downstream playback, rating, and survey task
  writes ratings.csv and transitions.csv

FES Electron app
  useful desktop-app pattern for webcam calibration, participant metadata, and local file output
```

The bridge between this app and PPS is currently the video artifact plus manifest metadata. The apps do not need to call each other directly.

## Stack Choice

### Chosen

- Electron
- React
- TypeScript
- DuckSoup
- GStreamer/Mozza

Electron is the most practical desktop shell here because the core workflow depends on WebRTC, camera/mic access, and `MediaRecorder`. Tauri is excellent for the PPS app's CSV-writing workflow, but Chromium-in-Electron is a better first target for live media.

### Video Infrastructure Options

- DuckSoup remains the best fit for this project because it already combines WebRTC with GStreamer effects.
- LiveKit is a strong open-source SFU option if the project later needs a modern, scalable conferencing backbone, but integrating Mozza-style GStreamer manipulation would require an additional media-processing bridge.
- Jitsi is a strong open-source meeting platform, but it is harder to turn into a controlled research manipulation pipeline.
- mediasoup is powerful and flexible, but it would require building much more application and media-control logic from scratch.

## Data Model

Each session should produce:

- `video/<room>-<participant>-clean.webm`
- `video/<room>-<participant>-altered.webm`
- `data/session_manifest.json`
- `data/manipulation_events.csv`

The manipulation CSV is the key experimental audit trail. It includes timestamps, elapsed time from recording start, target user, condition, control name, value, and whether the command was applied to DuckSoup.

## Latency Strategy

Lowest latency comes from:

- keeping both participants on the same LAN where possible
- using an SFU-style server rather than relaying through consumer cloud meetings
- using wired internet when possible
- preferring H264 hardware acceleration where available
- avoiding heavy analysis models in the hot path
- keeping emotion analysis asynchronous or sampled, not blocking frame delivery
- adding TURN only as fallback, not first-choice relay

For scientific timing, the app should log when a control was requested and later add server-side acknowledgement timestamps if DuckSoup exposes them.

## Manipulations Worth Considering

Face:

- smile/frown intensity
- face detection strictness
- landmark smoothing/responsiveness
- eyebrow raise/lower
- eye aperture/squint
- head pose exaggeration or attenuation
- gaze/eye-contact redirection
- blink frequency or blink timing
- mouth openness
- nod amplitude

Voice:

- volume/gain
- warmth/brightness
- pitch
- formant shift
- speaking-rate perception through delay or prosody transformation
- response delay

Interaction timing:

- partner response delay
- subtle audiovisual desynchrony
- turn-taking delay
- mimicry timing alignment/misalignment

The first production-safe manipulations should be the ones DuckSoup/Mozza already supports: smile alpha, face threshold, beta, fc, and overlay.

