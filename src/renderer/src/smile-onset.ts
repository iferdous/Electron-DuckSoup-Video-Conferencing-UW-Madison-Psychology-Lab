export type SmileOnsetMode = 'off' | 'detect' | 'live'

export type SmileDetectorPhase =
  | 'idle'
  | 'calibrating-neutral'
  | 'calibrating-smiles'
  | 'ready'
  | 'onset-candidate'
  | 'cue-active'
  | 'cooldown'
  | 'face-missing'
  | 'failed'

export type SmileFrame = {
  timestampMs: number
  facePresent: boolean
  mouthSmileLeft: number
  mouthSmileRight: number
  jawOpen: number
  faceInBounds: boolean
}

export type SmileCalibration = {
  neutralMedian: number
  neutralMad: number
  smileReference: number
  smileRange: number
}

export type SmileDetectorEvent =
  | {
      kind: 'calibration-ready'
      timestampMs: number
      calibration: SmileCalibration
    }
  | {
      kind: 'calibration-failed'
      timestampMs: number
      reason: string
    }
  | {
      kind: 'smile-onset'
      timestampMs: number
      rawSmile: number
      normalizedSmile: number
      mouthSmileLeft: number
      mouthSmileRight: number
      jawOpen: number
    }
  | {
      kind: 'smile-reset'
      timestampMs: number
    }
  | {
      kind: 'face-lost'
      timestampMs: number
    }

export type SmileDetectorSnapshot = {
  phase: SmileDetectorPhase
  facePresent: boolean
  rawSmile: number
  normalizedSmile: number
  calibration: SmileCalibration | null
  neutralRemainingMs: number
  promptedSmiles: number
  calibrationFailure: string
}

export type SmileOnsetCue = {
  eventId: string
  cue: 'smile-onset'
  sourceUserId: string
  sourceParticipantId: string
  targetUserId: string
  observedAtIso: string
  observedAtEpochMs: number
  observedAtMonotonicMs: number
  rawSmile: number
  normalizedSmile: number
  mouthSmileLeft: number
  mouthSmileRight: number
  jawOpen: number
}

export type SmileOnsetAuditEvent = {
  eventId: string
  timestamp: string
  elapsedMs: number
  roomId: string
  sourceUserId: string
  sourceParticipantId: string
  targetUserId: string
  targetParticipantId: string
  stage:
    | 'detected'
    | 'sent'
    | 'applied'
    | 'returned'
    | 'cancelled'
    | 'rejected'
    | 'calibration-ready'
    | 'calibration-failed'
  mode: SmileOnsetMode
  rawSmile: number | ''
  normalizedSmile: number | ''
  mouthSmileLeft: number | ''
  mouthSmileRight: number | ''
  jawOpen: number | ''
  reason: string
  videoRttMs: number | ''
  videoJitterMs: number | ''
  videoPacketsLost: number | ''
  framesDropped: number | ''
}

export type SmileCueValidation = {
  mode: SmileOnsetMode
  cueTargetUserId: string
  localUserId: string
  sourceIsParticipant: boolean
  ageMs: number
  maxAgeMs: number
  duplicate: boolean
  responseAlreadyActive: boolean
  duckSoupActive: boolean
  localFaceReady: boolean
}

export const smileCueRejectionReason = (validation: SmileCueValidation): string => {
  if (validation.mode !== 'live') return 'Automatic smile onset is not in live mode.'
  if (validation.cueTargetUserId !== validation.localUserId) return 'Cue target does not match this station.'
  if (!validation.sourceIsParticipant) return 'Cue source is not a participant in this room.'
  if (validation.ageMs < -1_000 || validation.ageMs > validation.maxAgeMs) {
    return `Stale cue (${validation.ageMs} ms old).`
  }
  if (validation.duplicate) return 'Duplicate cue ignored.'
  if (validation.responseAlreadyActive) return 'A smile response is already active; stacking is disabled.'
  if (!validation.duckSoupActive) return 'DuckSoup/Mozza is not active.'
  if (!validation.localFaceReady) return 'Target face is not calibrated and visible.'
  return ''
}

export type SmileDetectorConfig = {
  neutralCalibrationMs: number
  promptedSmilesRequired: number
  smileCalibrationTimeoutMs: number
  minimumCalibrationRange: number
  provisionalSmileDelta: number
  onsetThreshold: number
  releaseThreshold: number
  onsetDwellMs: number
  releaseDwellMs: number
  refractoryMs: number
  reacquireMs: number
}

export const defaultSmileDetectorConfig: SmileDetectorConfig = {
  neutralCalibrationMs: 8_000,
  promptedSmilesRequired: 3,
  smileCalibrationTimeoutMs: 20_000,
  minimumCalibrationRange: 0.15,
  provisionalSmileDelta: 0.12,
  onsetThreshold: 0.35,
  releaseThreshold: 0.2,
  onsetDwellMs: 200,
  releaseDwellMs: 300,
  refractoryMs: 1_500,
  reacquireMs: 500
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * quantile)))
  return sorted[index]
}

const bilateralSmile = (frame: SmileFrame): number =>
  clamp01((clamp01(frame.mouthSmileLeft) + clamp01(frame.mouthSmileRight)) / 2)

export class SmileOnsetDetector {
  private readonly config: SmileDetectorConfig
  private phase: SmileDetectorPhase = 'idle'
  private calibration: SmileCalibration | null = null
  private calibrationStartedAt = 0
  private smileCalibrationStartedAt = 0
  private neutralSamples: number[] = []
  private smileSamples: number[] = []
  private promptedSmiles = 0
  private provisionalCandidateSince: number | null = null
  private provisionalResetSince: number | null = null
  private provisionalActive = false
  private onsetCandidateSince: number | null = null
  private releaseCandidateSince: number | null = null
  private cooldownUntil = 0
  private faceStableSince: number | null = null
  private calibrationFailure = ''
  private lastRawSmile = 0
  private lastNormalizedSmile = 0
  private lastFacePresent = false

  constructor(config: Partial<SmileDetectorConfig> = {}) {
    this.config = { ...defaultSmileDetectorConfig, ...config }
  }

  startCalibration(timestampMs: number): void {
    this.phase = 'calibrating-neutral'
    this.calibration = null
    this.calibrationStartedAt = timestampMs
    this.smileCalibrationStartedAt = 0
    this.neutralSamples = []
    this.smileSamples = []
    this.promptedSmiles = 0
    this.provisionalCandidateSince = null
    this.provisionalResetSince = null
    this.provisionalActive = false
    this.onsetCandidateSince = null
    this.releaseCandidateSince = null
    this.cooldownUntil = 0
    this.faceStableSince = null
    this.calibrationFailure = ''
  }

  reset(): void {
    this.phase = 'idle'
    this.calibration = null
    this.neutralSamples = []
    this.smileSamples = []
    this.promptedSmiles = 0
    this.provisionalCandidateSince = null
    this.provisionalResetSince = null
    this.provisionalActive = false
    this.onsetCandidateSince = null
    this.releaseCandidateSince = null
    this.cooldownUntil = 0
    this.faceStableSince = null
    this.calibrationFailure = ''
    this.lastRawSmile = 0
    this.lastNormalizedSmile = 0
    this.lastFacePresent = false
  }

  ingest(frame: SmileFrame): SmileDetectorEvent[] {
    const events: SmileDetectorEvent[] = []
    const validFace = frame.facePresent && frame.faceInBounds
    const rawSmile = validFace ? bilateralSmile(frame) : 0
    this.lastRawSmile = rawSmile
    this.lastFacePresent = validFace
    this.lastNormalizedSmile = this.normalize(rawSmile)

    if (this.phase === 'idle' || this.phase === 'failed') return events

    if (this.phase === 'calibrating-neutral') {
      if (validFace) this.neutralSamples.push(rawSmile)
      if (frame.timestampMs - this.calibrationStartedAt >= this.config.neutralCalibrationMs) {
        if (this.neutralSamples.length < 30) {
          return this.failCalibration(frame.timestampMs, 'Face was not visible long enough during neutral calibration.')
        }
        this.phase = 'calibrating-smiles'
        this.smileCalibrationStartedAt = frame.timestampMs
      }
      return events
    }

    if (this.phase === 'calibrating-smiles') {
      if (frame.timestampMs - this.smileCalibrationStartedAt > this.config.smileCalibrationTimeoutMs) {
        return this.failCalibration(frame.timestampMs, 'Three clear smiles were not detected before calibration timed out.')
      }
      if (!validFace) return events

      const neutralBaseline = median(this.neutralSamples)
      const provisionalOnset = neutralBaseline + this.config.provisionalSmileDelta
      const provisionalRelease = neutralBaseline + this.config.provisionalSmileDelta * 0.45

      if (!this.provisionalActive) {
        if (rawSmile >= provisionalOnset) {
          this.provisionalCandidateSince ??= frame.timestampMs
          this.smileSamples.push(rawSmile)
          if (frame.timestampMs - this.provisionalCandidateSince >= this.config.onsetDwellMs) {
            this.provisionalActive = true
            this.promptedSmiles += 1
            this.provisionalCandidateSince = null
          }
        } else {
          this.provisionalCandidateSince = null
        }
      } else if (rawSmile <= provisionalRelease) {
        this.provisionalResetSince ??= frame.timestampMs
        if (frame.timestampMs - this.provisionalResetSince >= this.config.releaseDwellMs) {
          this.provisionalActive = false
          this.provisionalResetSince = null
          if (this.promptedSmiles >= this.config.promptedSmilesRequired) {
            const ready = this.finishCalibration(frame.timestampMs)
            events.push(...ready)
          }
        }
      } else {
        this.provisionalResetSince = null
        this.smileSamples.push(rawSmile)
      }
      return events
    }

    if (!validFace) {
      const enteredFaceMissing = this.phase !== 'face-missing'
      this.phase = 'face-missing'
      this.faceStableSince = null
      this.onsetCandidateSince = null
      this.releaseCandidateSince = null
      if (enteredFaceMissing) events.push({ kind: 'face-lost', timestampMs: frame.timestampMs })
      return events
    }

    if (this.phase === 'face-missing') {
      this.faceStableSince ??= frame.timestampMs
      if (frame.timestampMs - this.faceStableSince < this.config.reacquireMs) return events
      this.phase = 'ready'
      this.faceStableSince = null
    }

    const normalized = this.lastNormalizedSmile

    if (this.phase === 'cooldown') {
      if (frame.timestampMs >= this.cooldownUntil && normalized <= this.config.releaseThreshold) {
        this.phase = 'ready'
      }
      return events
    }

    if (this.phase === 'cue-active') {
      if (normalized <= this.config.releaseThreshold) {
        this.releaseCandidateSince ??= frame.timestampMs
        if (frame.timestampMs - this.releaseCandidateSince >= this.config.releaseDwellMs) {
          events.push({ kind: 'smile-reset', timestampMs: frame.timestampMs })
          this.phase = 'cooldown'
          this.cooldownUntil = frame.timestampMs + this.config.refractoryMs
          this.releaseCandidateSince = null
        }
      } else {
        this.releaseCandidateSince = null
      }
      return events
    }

    if (normalized >= this.config.onsetThreshold) {
      if (this.phase !== 'onset-candidate') {
        this.phase = 'onset-candidate'
        this.onsetCandidateSince = frame.timestampMs
      }
      if (
        this.onsetCandidateSince !== null &&
        frame.timestampMs - this.onsetCandidateSince >= this.config.onsetDwellMs
      ) {
        this.phase = 'cue-active'
        this.onsetCandidateSince = null
        events.push({
          kind: 'smile-onset',
          timestampMs: frame.timestampMs,
          rawSmile,
          normalizedSmile: normalized,
          mouthSmileLeft: frame.mouthSmileLeft,
          mouthSmileRight: frame.mouthSmileRight,
          jawOpen: frame.jawOpen
        })
      }
    } else {
      this.phase = 'ready'
      this.onsetCandidateSince = null
    }

    return events
  }

  snapshot(timestampMs: number): SmileDetectorSnapshot {
    return {
      phase: this.phase,
      facePresent: this.lastFacePresent,
      rawSmile: this.lastRawSmile,
      normalizedSmile: this.lastNormalizedSmile,
      calibration: this.calibration,
      neutralRemainingMs:
        this.phase === 'calibrating-neutral'
          ? Math.max(0, this.config.neutralCalibrationMs - (timestampMs - this.calibrationStartedAt))
          : 0,
      promptedSmiles: this.promptedSmiles,
      calibrationFailure: this.calibrationFailure
    }
  }

  private normalize(rawSmile: number): number {
    if (!this.calibration || this.calibration.smileRange <= 0) return 0
    return clamp01((rawSmile - this.calibration.neutralMedian) / this.calibration.smileRange)
  }

  private finishCalibration(timestampMs: number): SmileDetectorEvent[] {
    const neutralMedian = median(this.neutralSamples)
    const neutralDeviations = this.neutralSamples.map((value) => Math.abs(value - neutralMedian))
    const neutralMad = median(neutralDeviations)
    const smileReference = percentile(this.smileSamples, 0.9)
    const smileRange = smileReference - neutralMedian

    if (smileRange < this.config.minimumCalibrationRange) {
      return this.failCalibration(timestampMs, 'Smile movement was too small to separate reliably from the neutral baseline.')
    }

    this.calibration = { neutralMedian, neutralMad, smileReference, smileRange }
    this.phase = 'ready'
    this.lastNormalizedSmile = this.normalize(this.lastRawSmile)
    return [{ kind: 'calibration-ready', timestampMs, calibration: this.calibration }]
  }

  private failCalibration(timestampMs: number, reason: string): SmileDetectorEvent[] {
    this.phase = 'failed'
    this.calibrationFailure = reason
    return [{ kind: 'calibration-failed', timestampMs, reason }]
  }
}
