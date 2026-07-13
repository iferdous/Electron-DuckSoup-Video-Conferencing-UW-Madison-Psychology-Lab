# SyncLink Rugged Testing Checklist

Use this before any demo or lab testing session. Mark each item pass/fail and keep notes for anything that fails twice.

## 1. Machine Setup

- [ ] Experimenter app opens without a blank screen.
- [ ] Both participant apps open without a blank screen.
- [ ] Docker Desktop is running on the media/effects host.
- [ ] Media/effects server is reachable at `http://<media-host-ip>:8100/health`.
- [ ] Render signaling is reachable at `https://nelf-call-signaling.onrender.com/health`.
- [ ] All computers are on the intended network.
- [ ] Cameras and microphones are allowed by the operating system.
- [ ] Windows firewall allows the app/network being tested.

## 2. Session Setup

- [ ] Experimenter logs in.
- [ ] Study ID, RA, dyad/session ID, and participant IDs are filled in.
- [ ] Media Server points to the computer running Docker/Mozza.
- [ ] Participant session link is copied from the Experimenter app.
- [ ] Participants paste the link and click `Use` before continuing.
- [ ] Participants do not see Experimenter-only controls.
- [ ] Back/setup navigation works from participant and experimenter views.

## 3. Joining The Room

- [ ] Participant 1 joins and sees a waiting/connected state.
- [ ] Participant 2 joins the same Meeting ID.
- [ ] Each participant sees the other participant's video.
- [ ] Each participant hears the other participant's audio.
- [ ] Experimenter can join without appearing as a visible participant tile.
- [ ] Leave room disconnects cleanly and allows a rejoin.
- [ ] Rejoin does not create duplicate peers or stale chat.

## 4. Face Modulation

- [ ] Smile Alpha changes the selected participant's altered stream.
- [ ] Return Baseline brings the selected participant back to neutral.
- [ ] Reward Smile preset fires and returns smoothly.
- [ ] Affiliative Smile preset fires and returns smoothly.
- [ ] Dominance Smile preset fires as the current alpha-based approximation.
- [ ] Control Target applies to the intended participant only.
- [ ] All Participants applies to both participants.
- [ ] Automatic smile synchrony can be left Off, Detect-only, or Live.
- [ ] In Live mode, participant-driven onset and offset do not stack or get stuck.
- [ ] Face loss does not leave a permanent manipulation.

## 5. Timed Schedule

- [ ] Min/Sec fields remove leading zeroes.
- [ ] Smile Alpha timed event fires at the correct time.
- [ ] Smile Type timed event fires at the correct time.
- [ ] Target is snapshotted when the timed event is added.
- [ ] Timed events skip with a warning while automatic smile synchrony is Live.
- [ ] Removed timed events do not fire.

## 6. Chat And Notifications

- [ ] Participant can send a room message.
- [ ] Experimenter receives a notification if chat is off-screen.
- [ ] Clicking the notification scrolls to chat.
- [ ] Chat clears after leaving and rejoining a room.
- [ ] No old-room chat appears in a new session.

## 7. Recording And Files

- [ ] Start recording works from the Experimenter view.
- [ ] Stop/conclude study finishes without hanging.
- [ ] Clean/unmanipulated video is saved for each participant.
- [ ] Altered/manipulated video is saved for each participant.
- [ ] `session_manifest.json` is written.
- [ ] `pps_playback_manifest.json` is written.
- [ ] `manipulation_events.csv` is written.
- [ ] `chat_log.csv` is written.
- [ ] `media_quality.csv` is written.
- [ ] PPS playback pairing is correct: unmanipulated self video plus manipulated partner video.

## 8. Latency And Stability

- [ ] Participant latency display stays readable and simple.
- [ ] No repeated connection dropped messages during a stable call.
- [ ] 10-minute dyad completes without disconnecting.
- [ ] Packet loss is below 1% when possible.
- [ ] Jitter is below 30 ms when possible.
- [ ] Dropped frames stay below 2% when possible.
- [ ] Fast head movement does not create long visual glitches.
- [ ] Poor lighting is documented if it affects detection.

## 9. Recovery Tests

- [ ] One participant leaves and rejoins.
- [ ] Experimenter leaves and rejoins.
- [ ] Media server down shows a clear error.
- [ ] Render signaling down shows a clear error.
- [ ] Wrong participant link requires `Use` and shows a warning.
- [ ] App can return to setup and start a fresh session.

## 10. Final Pass Rule

Do not use the setup for real data collection until:

- [ ] Two full dyad tests pass on the actual lab machines.
- [ ] One full dyad test includes recording and PPS manifest review.
- [ ] One test includes leaving/rejoining.
- [ ] One test includes all manual smile presets and one timed preset.
- [ ] The team agrees which media host is standard for the lab.
