# Render Signaling Server

The hosted signaling server lets every computer use the same public room link instead of typing LAN IP addresses.

It handles:

- room presence
- WebRTC offer/answer/candidate messages
- room chat
- Experimenter live-control messages
- basic health checks

It does not handle:

- video recording
- local camera effects
- local Docker media/effects processing
- TURN media relay

## Deploy

1. Push the repo to GitHub.
2. Open the Render Blueprint page:

   ```text
   https://dashboard.render.com/blueprint/new?repo=https://github.com/iferdous/Electron-DuckSoup-Video-Conferencing-UW-Madison-Psychology-Lab
   ```

3. Apply the Blueprint from `render.yaml`.
4. Wait until the `nelf-call-signaling` service is live.
5. Check:

   ```text
   https://nelf-call-signaling.onrender.com/health
   ```

## App URL

The desktop app defaults to:

```text
https://nelf-call-signaling.onrender.com
```

If the Render service gets a different URL, update `hostedSignalUrl` in `src/renderer/src/App.tsx`.

## Important

Render coordinates the call, but WebRTC media still travels between computers when possible. If a strict campus, hospital, corporate, or guest network blocks direct media, the next step is to add a TURN server.
