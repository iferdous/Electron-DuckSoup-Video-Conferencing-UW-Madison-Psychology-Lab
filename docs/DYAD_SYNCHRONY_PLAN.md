# Dyad synchrony: execution and validation plan

## Scientific target

The first target is not a generic "emotion reader." It is a closed-loop behavioral manipulation:

1. Measure a clearly defined facial action from participant A's clean camera stream.
2. Decide whether that event meets a preregistered cue rule.
3. Apply a predefined Mozza response to participant B's outgoing altered stream.
4. Record the cue, decision, command, application acknowledgement, and return to baseline.

This distinction matters. A smile or lip-corner depression is observable facial behavior; it is not
proof that a participant internally feels happy or sad. Emotion labels should only be used when the
study validates them against self-report or another measure.

## What exists now

- `Aligned`, `Suppressed`, and `Reactive` can be changed during the conversation.
- The experimenter can target one participant or the whole room.
- Reactive cue buttons send a temporary alpha pulse and then return to the current baseline.
- Commands and timing are written to `manipulation_events.csv`.
- Automatic smile onset is implemented for internal dyad validation in `Off`, `Detect`, and `Live
  aligned` modes. Detection and decisions occur locally from each participant's clean camera; the
  experimenter does not evaluate individual cues.
- Each participant completes an 8-second neutral calibration and three prompted natural smiles.
- A validated onset sends a direct participant-to-partner cue. The target ramps `0 -> +0.25` over
  350 ms. A matched participant-driven offset then returns the added alpha to `0` over 650 ms after a
  400 ms minimum peak hold. A five-second watchdog prevents a lost offset from leaving the effect on.
- Automatic events are written centrally to `smile_synchrony_events.csv`; the former
  `smile_onset_events.csv` is retained as a compatibility copy. This implementation is not
  research-ready until the cue, timing, manipulation, and research validation gates below pass.

## Recommended cue model

Run cue detection locally on each participant's **clean/raw** camera stream. Never detect cues from an
altered stream, or the manipulation can detect itself and create a feedback loop.

For the first validated version, use face blendshapes or Action Units rather than seven-category emotion
classification:

| Cue name | Candidate observable signal | First manipulation to validate |
| --- | --- | --- |
| Smile onset | bilateral lip-corner pull plus optional cheek raise (AU12, optionally AU6) | align, dampen, or invert the partner's smile |
| Smile offset | AU12 falls below its personalized release threshold | return the target to baseline |
| Laugh-like event | smile plus jaw opening and optional audio-energy burst | stronger but short suppression pulse |
| Lip-corner depression | bilateral mouth-frown/AU15-like movement | neutralize or provide a brief repair smile |
| Brow tension | brow lowerer/AU4-like movement | log first; do not manipulate until validated |
| Turn response | voice activity begins shortly after the partner stops speaking | manipulate voice delay only in a separately approved condition |

MediaPipe Face Landmarker is the practical browser-side prototype because it can provide real-time
landmarks and blendshape coefficients inside Electron. Py-Feat is better suited to offline validation
and rescoring of recorded clean videos. The real-time detector and offline scorer should be compared
before automatic treatment assignment is enabled.

## Detector state machine

Per participant, maintain this state:

- `face_missing`: no reliable face; emit no cue and apply no new automatic manipulation.
- `calibrating`: collect a neutral/prompted baseline for 10-20 seconds.
- `ready`: evaluate normalized cue scores.
- `cue_active`: onset threshold and minimum dwell have been met.
- `refractory`: ignore repeat onsets for a short preregistered interval.

Use two thresholds instead of one. An onset threshold starts an event; a lower release threshold ends
it. Require a minimum dwell (for example 150-250 ms) and a refractory period (for example 1-2 seconds).
This hysteresis prevents frame-level noise from repeatedly firing the manipulation.

Thresholds are participant-relative:

`normalized score = (current score - neutral median) / (prompted smile reference - neutral median)`

Keep the raw score, normalized score, face confidence, and decision in the log. Do not silently replace
missing detections with zero; missing is its own state.

## Closed-loop policies to test

Start with a small, interpretable policy matrix:

- **Natural control:** detect and log only; alpha remains 0.
- **Aligned response:** A smile onset triggers a short positive alpha on B.
- **Suppressed response:** A smile onset triggers B's configured negative/dampened alpha.
- **Incongruent response:** A smile onset triggers a negative alpha on B; a lip-corner depression can
  trigger a small positive repair response.
- **Delayed response:** use the same response with a controlled delay. Keep transport delay separate
  from the experimental delay.

Do not deploy every possible mapping in one study. Validate each manipulation's detectability,
plausibility, and timing first. Randomization should occur in a policy layer, not inside the detector.

## Timing and synchrony analysis

Use monotonic client time for local sequencing and ISO/server time for cross-machine reconciliation.
For every automatic event, log:

- clean cue onset and offset
- detector score, confidence, and face-presence state
- selected policy and target participant
- decision timestamp
- command sent timestamp
- command received timestamp
- DuckSoup control request timestamp
- return-to-baseline timestamp
- current WebRTC RTT, jitter, packet loss, and jitter-buffer delay

Offline, compute synchrony from clean behavioral time series so the manipulation itself cannot inflate
the measure. Use maximum cross-correlation over a preregistered lag window (the cited smile-alignment
work used approximately +/-5 seconds) and a complementary dependence measure such as mutual
information. Analyze altered streams separately as a manipulation check.

## Validation gates

1. **Plugin gate:** patched Mozza passes face-present, face-missing, reacquisition, still-head, and
   fast-head-motion tests.
2. **Transport gate:** a 10-minute dyad stays connected and `media_quality.csv` shows acceptable loss,
   jitter, and frame drops on the actual lab network.
3. **Cue gate:** automated cue onsets agree with blinded human coding or an approved offline AU model.
4. **Timing gate:** measured cue-to-visible-response delay is stable enough for the planned lag window.
5. **Manipulation gate:** clean video is unchanged, altered video shows the intended action, and
   background motion remains below the acceptance threshold.
6. **Research gate:** mappings, thresholds, probabilities, timing, exclusions, and debriefing are
   approved before participant data collection.

## Immediate test sequence

1. Rebuild the patched plugin with `docker/ducksoup/fetch-mozza-plugins.sh`.
2. Run a one-camera mirror test at 480x360, 15 fps, beta 0.02, fc 0.3.
3. Hold still for 30 seconds, move quickly for 30 seconds, leave frame, and return.
4. Confirm `face-thresh`, `beta`, and `fc` visibly change behavior.
5. Run a two-computer dyad for 10 minutes and retain `media_quality.csv`, dry/wet recordings, and logs.
6. Run automatic mode in **Detect** first: 20 intentional smiles plus two neutral/talking minutes.
7. Require at least 18/20 detected smiles, no more than two neutral false detections, no duplicate
   event for one continuous smile, and no event while the face is missing.
8. Test P1-to-P2 and P2-to-P1 separately before enabling **Live aligned** in both directions.
9. Run a 10-minute bidirectional internal dyad and review clean/wet recordings,
   `smile_onset_events.csv`, `manipulation_events.csv`, and `media_quality.csv`.
