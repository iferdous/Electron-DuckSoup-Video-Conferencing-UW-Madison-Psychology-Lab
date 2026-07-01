import { describe, expect, it } from 'vitest'
import {
  SmileOnsetDetector,
  smileCueRejectionReason,
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
    expect(events.some((event) => event.kind === 'smile-reset')).toBe(true)
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

describe('smileCueRejectionReason', () => {
  const valid = {
    mode: 'live' as const,
    cueTargetUserId: 'p2',
    localUserId: 'p2',
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
    expect(smileCueRejectionReason({ ...valid, localFaceReady: false })).toContain('not calibrated')
  })
})
