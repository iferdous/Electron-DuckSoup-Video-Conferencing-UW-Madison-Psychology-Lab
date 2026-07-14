import { describe, expect, it } from 'vitest'
import {
  SmileOnsetDetector,
  defaultSmileDetectorConfig,
  smileCueRejectionReason,
  smileOffsetMatchRejectionReason,
  smileOffsetRejectionReason,
  smileOffsetReturnDelayMs,
  type SmileDetectorEvent,
  type SmileFrame
} from './smile-onset'

const frame = (timestampMs: number, smile = 0.05, facePresent = true): SmileFrame => ({
  timestampMs,
  facePresent,
  faceInBounds: facePresent,
  mouthSmileLeft: smile,
  mouthSmileRight: smile,
  jawOpen: 0
})

const feed = (
  detector: SmileOnsetDetector,
  from: number,
  to: number,
  smile: number,
  facePresent = true,
  step = 50
) => {
  const events: SmileDetectorEvent[] = []
  for (let timestamp = from; timestamp <= to; timestamp += step) {
    events.push(...detector.ingest(frame(timestamp, smile, facePresent)))
  }
  return events
}

const calibrate = (detector: SmileOnsetDetector): number => {
  detector.startCalibration(0)
  feed(detector, 0, 8_000, 0.05)
  let cursor = 8_050
  for (let index = 0; index < 3; index += 1) {
    feed(detector, cursor, cursor + 300, 0.65)
    cursor += 350
    feed(detector, cursor, cursor + 350, 0.05)
    cursor += 400
  }
  expect(detector.snapshot(cursor).phase).toBe('ready')
  return cursor
}

describe('SmileOnsetDetector', () => {
  it('calibrates from a neutral baseline and three prompted smiles', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    const snapshot = detector.snapshot(cursor)
    expect(snapshot.calibration?.neutralMedian).toBeCloseTo(0.05)
    expect(snapshot.calibration?.smileReference).toBeGreaterThan(0.5)
    expect(snapshot.promptedSmiles).toBe(3)
  })

  it('requires the onset dwell and emits only one event for a continuous smile', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    expect(feed(detector, cursor + 50, cursor + 200, 0.5).filter((event) => event.kind === 'smile-onset')).toHaveLength(0)
    const events = feed(detector, cursor + 250, cursor + 1_500, 0.5)
    expect(events.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)
  })

  it('does not emit an onset for subthreshold mouth movement', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    const events = feed(detector, cursor + 50, cursor + 3_000, 0.12)
    expect(events.some((event) => event.kind === 'smile-onset')).toBe(false)
  })

  it('requires release and cooldown before another onset', () => {
    const detector = new SmileOnsetDetector()
    let cursor = calibrate(detector)
    let events = feed(detector, cursor + 50, cursor + 500, 0.6)
    expect(events.some((event) => event.kind === 'smile-onset')).toBe(true)
    cursor += 550
    events = feed(detector, cursor, cursor + 500, 0.05)
    expect(events.some((event) => event.kind === 'smile-offset')).toBe(true)
    cursor += 550
    events = feed(detector, cursor, cursor + 600, 0.6)
    expect(events.some((event) => event.kind === 'smile-onset')).toBe(false)
    cursor += 2_000
    feed(detector, cursor, cursor + 350, 0.05)
    events = feed(detector, cursor + 400, cursor + 800, 0.6)
    expect(events.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)
  })

  it('cancels an active cue and blocks detection while the face is missing', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    feed(detector, cursor + 50, cursor + 500, 0.6)
    const lost = detector.ingest(frame(cursor + 550, 0, false))
    expect(lost.some((event) => event.kind === 'face-lost')).toBe(true)
    expect(detector.snapshot(cursor + 550).phase).toBe('face-missing')
    expect(feed(detector, cursor + 600, cursor + 1_500, 0.8, false)).toHaveLength(0)
  })

  it('uses a three-frame median and dwell before confirming smile offset', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    feed(detector, cursor + 50, cursor + 500, 0.6)

    const briefDip = [
      ...detector.ingest(frame(cursor + 550, 0.05)),
      ...detector.ingest(frame(cursor + 600, 0.6)),
      ...detector.ingest(frame(cursor + 650, 0.6))
    ]
    expect(briefDip.some((event) => event.kind === 'smile-offset')).toBe(false)

    const offsetEvents = feed(detector, cursor + 700, cursor + 1_150, 0.05)
    const offset = offsetEvents.find((event) => event.kind === 'smile-offset')
    expect(offset).toBeDefined()
    if (offset?.kind === 'smile-offset') {
      expect(offset.smoothedNormalizedSmile).toBeLessThanOrEqual(0.2)
      expect(offset.normalizedSmile).toBeLessThanOrEqual(0.2)
    }
  })

  it('does not emit an offset while a smile remains active', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    const activeEvents = feed(detector, cursor + 50, cursor + 5_500, 0.6)
    expect(activeEvents.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)
    expect(activeEvents.some((event) => event.kind === 'smile-offset')).toBe(false)
  })

  it('emits only one offset for one onset', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    feed(detector, cursor + 50, cursor + 500, 0.6)
    const offsetEvents = feed(detector, cursor + 550, cursor + 2_500, 0.05)
    expect(offsetEvents.filter((event) => event.kind === 'smile-offset')).toHaveLength(1)
  })

  it('defaults maxCueActiveMs to 8000', () => {
    expect(defaultSmileDetectorConfig.maxCueActiveMs).toBe(8_000)
  })

  it('force-emits an offset after maxCueActiveMs when a smile never releases, then re-arms', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)

    // A smile held well above the release threshold the whole time. Without the safety
    // valve this holds the cue forever and suppresses every later smile; maxCueActiveMs
    // must force a normal offset once the cue has been active for 8s.
    const held = feed(detector, cursor + 50, cursor + 9_500, 0.6)
    expect(held.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)
    const forced = held.filter((event) => event.kind === 'smile-offset')
    expect(forced).toHaveLength(1)

    // The forced offset is the same shape/type as a natural offset (all fields present),
    // even though the participant is still smiling (score well above release).
    const forcedOffset = forced[0]
    expect(forcedOffset.kind).toBe('smile-offset')
    let offsetTs = cursor
    if (forcedOffset.kind === 'smile-offset') {
      expect(forcedOffset.rawSmile).toBeGreaterThan(0.2)
      expect(forcedOffset.normalizedSmile).toBeGreaterThan(0.2)
      expect(forcedOffset.smoothedNormalizedSmile).toBeGreaterThan(0.2)
      offsetTs = forcedOffset.timestampMs
    }

    // After the forced offset the detector is in cooldown/refractory. Drop to neutral so
    // cooldown can clear, then confirm a brand-new onset can fire again.
    let next = offsetTs + 50
    feed(detector, next, next + 2_000, 0.05)
    next += 2_050
    const reArmed = feed(detector, next, next + 800, 0.6)
    expect(reArmed.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)
  })

  it('still emits a natural offset when the smile drops below release well before maxCueActiveMs', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    const onsetEvents = feed(detector, cursor + 50, cursor + 500, 0.6)
    expect(onsetEvents.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)

    // Drop to neutral; a natural offset should fire after the release dwell (~300ms),
    // far sooner than the 8s force-offset safety valve.
    const offsetEvents = feed(detector, cursor + 550, cursor + 1_200, 0.05)
    const offset = offsetEvents.find((event) => event.kind === 'smile-offset')
    expect(offset).toBeDefined()
    if (offset?.kind === 'smile-offset') {
      expect(offset.smoothedNormalizedSmile).toBeLessThanOrEqual(0.2)
      expect(offset.timestampMs).toBeLessThan(cursor + 8_000)
    }
  })

  it('recovers to ready after the reacquire dwell once the face returns', () => {
    const detector = new SmileOnsetDetector()
    const cursor = calibrate(detector)
    detector.ingest(frame(cursor + 50, 0, false))
    expect(detector.snapshot(cursor + 60).phase).toBe('face-missing')
    // Face returns but must stay missing until reacquireMs (500ms) of stable presence elapses,
    // then recovers to ready and can detect a fresh onset again.
    feed(detector, cursor + 100, cursor + 700, 0.05)
    expect(detector.snapshot(cursor + 700).phase).toBe('ready')
    const events = feed(detector, cursor + 750, cursor + 1_400, 0.6)
    expect(events.filter((event) => event.kind === 'smile-onset')).toHaveLength(1)
  })

  it('fails calibration when smile movement is not distinguishable from neutral', () => {
    const detector = new SmileOnsetDetector({ provisionalSmileDelta: 0.01 })
    detector.startCalibration(0)
    feed(detector, 0, 8_000, 0.05)
    let cursor = 8_050
    for (let index = 0; index < 3; index += 1) {
      feed(detector, cursor, cursor + 300, 0.08)
      cursor += 350
      feed(detector, cursor, cursor + 350, 0.05)
      cursor += 400
    }
    expect(detector.snapshot(cursor).phase).toBe('failed')
  })
})

describe('smile offset validation', () => {
  const valid = {
    mode: 'live' as const,
    cueTargetUserId: 'p2',
    localUserId: 'p2',
    cueSourceUserId: 'p1',
    senderUserId: 'p1',
    sourceIsParticipant: true,
    ageMs: 120,
    maxAgeMs: 2_000,
    duplicate: false,
    activeEventId: 'smile-p1-1',
    activeSourceUserId: 'p1',
    returnAlreadyStarted: false,
    duckSoupActive: true
  }

  it('accepts a fresh participant offset for an active response', () => {
    expect(smileOffsetRejectionReason(valid)).toBe('')
    expect(smileOffsetMatchRejectionReason('smile-p1-1', 'p1', 'smile-p1-1', 'p1')).toBe('')
  })

  it('rejects stale, duplicate, spoofed, inactive, and mismatched offsets', () => {
    expect(smileOffsetRejectionReason({ ...valid, ageMs: 2_500 })).toContain('Stale')
    expect(smileOffsetRejectionReason({ ...valid, duplicate: true })).toContain('Duplicate')
    expect(smileOffsetRejectionReason({ ...valid, senderUserId: 'other' })).toContain('sender')
    expect(smileOffsetRejectionReason({ ...valid, activeEventId: '' })).toContain('No smile response')
    expect(smileOffsetRejectionReason({ ...valid, returnAlreadyStarted: true })).toContain('already returning')
    expect(smileOffsetMatchRejectionReason('other-event', 'p1', 'smile-p1-1', 'p1')).toContain('event')
    expect(smileOffsetMatchRejectionReason('smile-p1-1', 'other', 'smile-p1-1', 'p1')).toContain('source')
  })

  it('queues an early offset until ramp and minimum peak hold complete', () => {
    expect(smileOffsetReturnDelayMs(1_000, 1_300, 350, 400)).toBe(450)
    expect(smileOffsetReturnDelayMs(1_000, 1_900, 350, 400)).toBe(0)
  })
})

describe('smileCueRejectionReason', () => {
  const valid = {
    mode: 'live' as const,
    cueTargetUserId: 'p2',
    localUserId: 'p2',
    cueSourceUserId: 'p1',
    senderUserId: 'p1',
    sourceIsParticipant: true,
    ageMs: 150,
    maxAgeMs: 2_000,
    duplicate: false,
    responseAlreadyActive: false,
    duckSoupActive: true,
    localFaceReady: true
  }

  it('accepts a fresh, correctly targeted participant cue', () => {
    expect(smileCueRejectionReason(valid)).toBe('')
  })

  it('rejects stale, duplicate, stacked, and incorrectly targeted cues', () => {
    expect(smileCueRejectionReason({ ...valid, ageMs: 2_500 })).toContain('Stale cue')
    expect(smileCueRejectionReason({ ...valid, duplicate: true })).toContain('Duplicate')
    expect(smileCueRejectionReason({ ...valid, responseAlreadyActive: true })).toContain('stacking')
    expect(smileCueRejectionReason({ ...valid, cueTargetUserId: 'p1' })).toContain('target')
    expect(smileCueRejectionReason({ ...valid, senderUserId: 'other' })).toContain('sender')
    expect(smileCueRejectionReason({ ...valid, localFaceReady: false })).toContain('not calibrated')
  })

  it('tolerates small negative cue ages (cross-machine clock skew) but rejects large ones', () => {
    // Cues are stamped/compared in the signaling server's clock domain, but a residual skew can still
    // yield a slightly negative age. The window tolerates down to -1000ms and rejects beyond it.
    expect(smileCueRejectionReason({ ...valid, ageMs: -500 })).toBe('')
    expect(smileCueRejectionReason({ ...valid, ageMs: -1_500 })).toContain('Stale cue')
    expect(smileCueRejectionReason({ ...valid, ageMs: 0 })).toBe('')
  })
})
