# Participant-driven smile offset

## Purpose

Smile offset ends the subtle smile that automatic smile onset added to the partner's altered stream.
It is driven entirely by participant behavior:

1. P1's clean camera detects a calibrated smile onset.
2. P2's Mozza alpha ramps from `0.00` to `+0.25`.
3. P1's clean camera detects that the same smile has ended.
4. A matched offset message is sent directly to P2.
5. P2's added Mozza alpha returns to `0.00`.

The experimenter selects `Off`, `Detect`, or `Live aligned` for the session but does not evaluate or
approve individual cues. Returning to `0.00` removes only the digital addition; it does not force P2's
physical expression to neutral.

## Detector rules

- Detection always uses the clean local camera, never an altered stream.
- Offset is considered only after a valid onset is active.
- The personalized normalized smile score must be at or below `0.20`.
- A three-frame median reduces one-frame tracking dips.
- The smoothed score must remain below threshold for `300 ms`.
- The face must be present and inside the valid tracking area.
- After offset, the detector uses the existing `1.5 s` refractory period.
- After face loss, detection waits for `500 ms` of stable reacquisition.

The detector remains at 15 samples per second. This matches the configured DuckSoup video rate and
avoids repeatedly processing the same frame at 30 Hz.

## Partner response

- Onset ramp: `350 ms`
- Minimum peak hold after the ramp: `400 ms`
- Offset return to Mozza alpha `0.00`: `650 ms`
- Maximum wait for a matched offset: `5 s`

If offset arrives before the ramp and minimum hold finish, it is queued. If offset is lost, the
five-second watchdog starts the return. Face loss, leaving the room, disabling automatic mode, or the
source participant leaving also returns the effect safely.

Mozza's real API is:

```ts
player.controlFx('video_fx', 'alpha', 0, 650)
```

There is no object-style `easing` parameter in the current DuckSoup client. The implementation uses
Mozza's native timed transition to avoid flooding GStreamer with frame-by-frame control messages.

## Message matching and rejection

Onset and offset share one `eventId`. A target accepts an offset only when:

- automatic mode is `live`;
- sender, declared source, target, and active event all match;
- the source is still a participant in the room;
- the message is no more than two seconds old;
- it is not a duplicate;
- the response has not already started returning; and
- DuckSoup/Mozza is active.

Stale, duplicate, spoofed, incorrectly targeted, and mismatched events are rejected and audited.
Responses never stack.

## Output

`smile_synchrony_events.csv` contains onset and offset stages, including:

- event ID and cue type;
- source and target IDs;
- raw, normalized, and smoothed normalized smile scores;
- detection, send, receive, queue, return, cancellation, rejection, and watchdog timestamps;
- latest video RTT, jitter, packet loss, and dropped frames.

`smile_onset_events.csv` is also written with the same rows for compatibility with earlier analysis
scripts.

## Validation before research use

Run the following with the actual Mac/host, Windows participant station, and lab network:

1. Detect-only: 20 deliberate smiles and at least two minutes of neutral speech.
2. P1 to P2 live, then P2 to P1 live.
3. Bidirectional 10-minute dyad.
4. Still face, normal speech, short smile, long smile, fast head movement, dim light, face exit/re-entry,
   participant departure, and emergency reset.
5. Review clean and altered recordings with `smile_synchrony_events.csv` and `media_quality.csv`.

Initial acceptance targets:

- at least 18 of 20 deliberate offsets detected;
- no more than two premature offsets in the test set;
- zero wrong-target, face-missing, stacked, or permanently stuck effects;
- return starts roughly 300-500 ms after a sustained source offset;
- the added smile reaches baseline roughly 900-1,200 ms after the sustained source offset;
- packet loss below 1%, jitter below 30 ms, and dropped frames below 2% on the lab network.

Automated tests verify detector hysteresis, median smoothing, minimum-hold scheduling, stale/duplicate/
spoofed/mismatched rejection, and targeted onset-plus-offset signaling. They cannot prove visual
naturalness or lab-network performance; those require the physical dyad test and blinded recording
review.
