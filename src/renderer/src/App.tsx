import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  renderDuckSoup,
  applyMozzaControlChanges,
  applyMozzaControls,
  buildMozzaVideoFx,
  buildAudioFx,
  MOZZA_FX_NAME,
  MOZZA_AUDIO_FX_NAME,
  type DuckSoupPlayer,
  type DuckSoupCallbackMessage,
  type LiveMozzaFaceParams
} from './ducksoup-client'
import { getSmileFaceLandmarker, sampleSmileFrame } from './smile-landmarker'
import {
  SmileOnsetDetector,
  smileCueRejectionReason,
  smileOffsetMatchRejectionReason,
  smileOffsetRejectionReason,
  smileOffsetReturnDelayMs,
  type SmileDetectorEvent,
  type SmileDetectorSnapshot,
  type SmileOnsetAuditEvent,
  type SmileOffsetCue,
  type SmileOnsetCue,
  type SmileSynchronyCue
} from './smile-onset'
import type {
  CallPeer,
  CallRole,
  CallState,
  ChatMessage,
  ChatTarget,
  ControlEvent,
  LogEvent,
  ManipulationControls,
  RecordingState,
  SessionForm,
  SessionFormat
} from './types'

// DuckSoup interactions are capped server-side at 1200s (20 min). Lab conversations longer
// than this must rejoin. Kept as a constant so it's easy to surface as a setting later.
const DUCKSOUP_DURATION_SEC = 1200
const DUCKSOUP_VIDEO_WIDTH = 480
const DUCKSOUP_VIDEO_HEIGHT = 360
const DUCKSOUP_VIDEO_FPS = 15
const MOZZA_CONTROL_INTERVAL_MS = 75
const SMILE_DETECTOR_INTERVAL_MS = Math.round(1000 / 15)
const SMILE_RESPONSE_ALPHA = 0.25
const SMILE_RESPONSE_RAMP_MS = 350
const SMILE_OFFSET_MIN_PEAK_HOLD_MS = 400
const SMILE_OFFSET_RETURN_MS = 650
const SMILE_RESPONSE_WATCHDOG_MS = 5_000
const SMILE_CUE_MAX_AGE_MS = 2_000

const hostedSignalUrl = 'https://nelf-call-signaling.onrender.com'

const initialForm: SessionForm = {
  role: 'participant',
  sessionFormat: 'dyad',
  mediaTransport: 'ducksoup',
  serverName: 'Emotions Lab Host',
  studyId: 'NELF2026',
  raId: '',
  dyadId: '',
  displayName: 'Participant',
  participantId: 'P001',
  partnerId: 'P002',
  roomId: `nelf-room-${Date.now()}`,
  targetUserId: '',
  duckSoupUrl: 'http://localhost:8100',
  callSignalUrl: hostedSignalUrl,
  outputFolder: '',
  condition: 'Neutral / Sham'
}

const initialControls: ManipulationControls = {
  // Mozza `alpha`: 0 = neutral (no warp), positive = smile, negative = frown. The sham
  // baseline must be a true neutral face, so this starts at 0 (not 1, which is a full smile).
  smileAlpha: 0,
  // dlib detector confidence floor: lower = stickier detection (fewer dropped frames that
  // snap the warp on/off and cause fast flicker), at the cost of occasional false positives.
  faceThreshold: 0.1,
  // Mozza One-Euro filter speed coefficient (beta): lower = steadier (less jitter, more lag).
  landmarkBeta: 0.02,
  // Mozza One-Euro filter min cutoff (fc): lower = smoother/less jitter when still (more lag).
  // 0.3 matches the validated smooth test settings (beta=0.02 fc=0.3); fine-tune via the slider.
  smoothingCutoff: 0.3,
  overlay: false,
  synchronyMode: 'aligned',
  suppressSmileAlpha: -0.45,
  reactivePulseMs: 1800,
  audioPreset: 'none',
  audioPitch: 1,
  audioGain: 1,
  partnerVolume: 1,
  synchronyDelayMs: 0,
  automaticSmileOnsetMode: 'off'
}

type SignalEnvelope = {
  type: string
  payload?: {
    from?: string
    to?: string
    type?: string
    payload?: unknown
    peer?: CallPeer
    peers?: CallPeer[]
    role?: CallRole
    displayName?: string
    userId?: string
  } & Partial<ChatMessage>
}

type RoomPresence = {
  ok: boolean
  roomId: string
  peers: CallPeer[]
  checkedAt: string
}

type LiveMediaProcessor = {
  rawStream: MediaStream
  processedStream: MediaStream
  rawVideo: HTMLVideoElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  animationId: number
  currentSmileAlpha: number
  audioContext?: AudioContext
  audioDelay?: DelayNode
  audioGain?: GainNode
  audioLowShelf?: BiquadFilterNode
  audioHighShelf?: BiquadFilterNode
}

type RemoteTile = {
  userId: string
  displayName: string
  role: CallRole
  stream: MediaStream
}

// A single feed in the experimenter's 4-view monitor: one participant's clean or altered stream.
type MonitorTile = {
  key: string // `${userId}:${kind}`
  kind: 'clean' | 'altered'
  userId: string
  displayName: string
  stream: MediaStream
}

// Stream descriptor a participant sends with its monitor offer so the controller knows what each
// forwarded MediaStream is, by its msid (stream.id), without inspecting the media.
type MonitorStreamDescriptor = { streamId: string; kind: 'clean' | 'altered'; userId: string; displayName: string }

type DuckSoupRtpStats = {
  jitter?: number
  packetsLost?: number
  framesDropped?: number
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
  roundTripTime?: number
}

type DuckSoupStatsPayload = {
  videoUp?: string
  videoDown?: string
  audioUp?: string
  audioDown?: string
  inboundRTPVideo?: DuckSoupRtpStats
  inboundRTPAudio?: DuckSoupRtpStats
  remoteInboundRTPVideo?: DuckSoupRtpStats
  remoteInboundRTPAudio?: DuckSoupRtpStats
}

type MediaQualitySample = {
  timestamp: string
  elapsedMs: number
  videoUpKbps: string
  videoDownKbps: string
  audioUpKbps: string
  audioDownKbps: string
  videoJitterMs: number | null
  audioJitterMs: number | null
  videoRttMs: number | null
  audioRttMs: number | null
  videoPacketsLost: number
  audioPacketsLost: number
  framesDropped: number
  videoJitterBufferMs: number | null
}

type DirectorPayload =
  | {
      kind: 'live-control'
      key: keyof ManipulationControls
      value: ManipulationControls[keyof ManipulationControls]
      targetUserId?: string
      label?: string
    }
  | {
      kind: 'cue-response'
      cue: string
      targetUserId?: string
      alpha: number
      returnAlpha: number
      durationMs: number
      label: string
    }
  | {
      kind: 'session-conclude'
    }

const sessionCapacity: Record<SessionFormat, number> = {
  dyad: 2,
  triad: 3,
  quad: 4
}

const sessionLabels: Record<SessionFormat, string> = {
  dyad: 'Dyad',
  triad: 'Triad',
  quad: 'Quad'
}

const secondsToMs = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000 * 100) / 100 : null

const meanJitterBufferMs = (stats?: DuckSoupRtpStats): number | null => {
  if (
    !stats ||
    typeof stats.jitterBufferDelay !== 'number' ||
    typeof stats.jitterBufferEmittedCount !== 'number' ||
    stats.jitterBufferEmittedCount <= 0
  ) {
    return null
  }
  return Math.round((stats.jitterBufferDelay / stats.jitterBufferEmittedCount) * 1000 * 100) / 100
}

const mediaQualitySamplesToCsv = (samples: MediaQualitySample[]): string => {
  const headers: Array<keyof MediaQualitySample> = [
    'timestamp',
    'elapsedMs',
    'videoUpKbps',
    'videoDownKbps',
    'audioUpKbps',
    'audioDownKbps',
    'videoJitterMs',
    'audioJitterMs',
    'videoRttMs',
    'audioRttMs',
    'videoPacketsLost',
    'audioPacketsLost',
    'framesDropped',
    'videoJitterBufferMs'
  ]
  const rows = samples.map((sample) => headers.map((header) => csvEscape(sample[header])).join(','))
  return [headers.join(','), ...rows].join('\n')
}

const smileSynchronyEventsToCsv = (events: SmileOnsetAuditEvent[]): string => {
  const header: Array<keyof SmileOnsetAuditEvent> = [
    'eventId',
    'timestamp',
    'elapsedMs',
    'observedAtIso',
    'observedAtEpochMs',
    'observedAtMonotonicMs',
    'roomId',
    'sourceUserId',
    'sourceParticipantId',
    'targetUserId',
    'targetParticipantId',
    'cueType',
    'stage',
    'mode',
    'rawSmile',
    'normalizedSmile',
    'smoothedNormalizedSmile',
    'mouthSmileLeft',
    'mouthSmileRight',
    'jawOpen',
    'reason',
    'videoRttMs',
    'videoJitterMs',
    'videoPacketsLost',
    'framesDropped'
  ]
  const rows = events.map((event) => header.map((key) => csvEscape(event[key])).join(','))
  return [header.join(','), ...rows].join('\n') + '\n'
}

const appTitle = 'Niedenthal Emotions Lab'
const appSubtitle = 'Live emotion study session'

// "Alice · P001" once the participant's study ID has been relayed; otherwise just the name.
const peerStripLabel = (peer: CallPeer): string => {
  const id = peer.role === 'participant' ? peer.participantId : ''
  return id ? `${peer.displayName} · ${id}` : peer.displayName
}

const audioPresets: Array<{
  label: string
  preset: string
  effectName: 'pitch' | 'volume' | ''
  property: string
  value: number
  note: string
}> = [
  {
    label: 'Voice neutral',
    preset: 'none',
    effectName: '',
    property: '',
    value: 1,
    note: 'No voice change.'
  },
  {
    label: 'Warmer voice',
    preset: 'warmer',
    effectName: 'pitch',
    property: 'pitch',
    value: 0.92,
    note: 'Warmer/deeper outgoing voice tone.'
  },
  {
    label: 'Brighter voice',
    preset: 'brighter',
    effectName: 'pitch',
    property: 'pitch',
    value: 1.08,
    note: 'Brighter outgoing voice tone.'
  },
  {
    label: 'Quieter voice (not wired)',
    preset: 'quieter',
    effectName: 'volume',
    property: 'volume',
    value: 0.75,
    note: 'Lower outgoing microphone gain.'
  },
  {
    label: 'Louder voice (not wired)',
    preset: 'louder',
    effectName: 'volume',
    property: 'volume',
    value: 1.25,
    note: 'Higher outgoing microphone gain.'
  }
]

const makeId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const browserVolume = (value: number): number => clamp(Number.isFinite(value) ? value : 1, 0, 1)

const isLocalSignalUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)
  } catch {
    return false
  }
}

const parseSessionLink = (value: string): Partial<SessionForm> & { callSignalUrl: string; roomId: string } => {
  const url = new URL(value.trim())
  const roomId = url.searchParams.get('roomId')?.trim()
  if (!roomId) throw new Error('Session link is missing a Meeting ID.')

  const nextFormat = url.searchParams.get('format') as SessionFormat | null
  const parsed: Partial<SessionForm> & { callSignalUrl: string; roomId: string } = {
    callSignalUrl: url.origin,
    roomId
  }
  const studyId = url.searchParams.get('studyId')?.trim()
  const dyadId = url.searchParams.get('dyadId')?.trim()
  if (studyId) parsed.studyId = studyId
  if (dyadId) parsed.dyadId = dyadId
  if (nextFormat && nextFormat in sessionCapacity) parsed.sessionFormat = nextFormat
  const transport = url.searchParams.get('transport')
  if (transport === 'ducksoup' || transport === 'mesh') parsed.mediaTransport = transport
  const ds = url.searchParams.get('ds')?.trim()
  if (ds) parsed.duckSoupUrl = ds
  return parsed
}

const applyMediaElementVolume = (video: HTMLVideoElement, value: number): void => {
  try {
    video.volume = browserVolume(value)
  } catch {
    video.volume = 1
  }
}

const csvEscape = (value: unknown): string => {
  const text = value == null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/\r?\n|\r/g, ' ').replace(/"/g, '""')}"` : text
}

type TimedPreset = {
  id: string
  atSeconds: number
  smileAlpha: number
  // The control target snapshotted when the preset was scheduled, so it fires against the
  // participant the experimenter had selected then — not whoever happens to be selected at fire
  // time. Empty targetUserId = all participants.
  targetUserId: string
  targetLabel: string
  fired: boolean
}

const secondsToMmSs = (total: number): string => {
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const controlEventsToCsv = (events: ControlEvent[], recordingStartMs?: number | null): string => {
  const header = [
    'timestamp',
    'elapsedMs',
    'roomId',
    'participantId',
    'partnerId',
    'targetUserId',
    'condition',
    'control',
    'value',
    'appliedToDuckSoup',
    'notes'
  ]
  const rows = events.map((event) => {
    // elapsedMs = milliseconds from the recording start (video t=0). Recomputing it here from the
    // absolute UTC timestamp keeps it correct even for events logged before recording began
    // (negative) and after the experimenter re-anchors the start to the real interaction start.
    const elapsedMs =
      recordingStartMs != null ? Math.round(Date.parse(event.timestamp) - recordingStartMs) : event.elapsedMs
    return [
      event.timestamp,
      elapsedMs,
      event.roomId,
      event.participantId,
      event.partnerId,
      event.targetUserId,
      event.condition,
      event.control,
      event.value,
      event.appliedToDuckSoup,
      event.notes
    ]
      .map(csvEscape)
      .join(',')
  })
  return [header.join(','), ...rows].join('\n') + '\n'
}

const chatMessagesToCsv = (messages: ChatMessage[], peers: CallPeer[]): string => {
  const nameFor = (id?: string): string =>
    id ? peers.find((peer) => peer.userId === id)?.displayName ?? id : ''
  const header = ['sentAt', 'fromId', 'fromName', 'fromRole', 'audience', 'toName', 'targetRole', 'text']
  const rows = messages.map((message) => {
    const audience = message.to
      ? `direct:${nameFor(message.to)}`
      : message.targetRole
        ? `role:${message.targetRole}`
        : 'everyone'
    return [
      message.sentAt,
      message.from,
      message.fromName,
      message.fromRole,
      audience,
      nameFor(message.to),
      message.targetRole ?? '',
      message.text
    ]
      .map(csvEscape)
      .join(',')
  })
  return [header.join(','), ...rows].join('\n') + '\n'
}

type ChatAudience = { label: string; tone: 'everyone' | 'role' | 'private' }

// What audience a chat message went to, from the viewer's perspective — drives the
// per-message badge so a private/directed experimenter message is visibly distinct
// from a room-wide one (covert direct-messaging is a core study need).
const chatAudienceFor = (message: ChatMessage, selfId: string, peers: CallPeer[]): ChatAudience => {
  if (message.to) {
    const fromMe = message.from === selfId
    const otherId = fromMe ? message.to : message.from
    const otherName = peers.find((peer) => peer.userId === otherId)?.displayName
    return { label: fromMe ? `to ${otherName ?? 'participant'}` : 'to you', tone: 'private' }
  }
  if (message.targetRole) {
    const toExperimenter = message.targetRole === 'controller'
    return {
      label: toExperimenter ? 'to Experimenter' : 'to all participants',
      tone: toExperimenter ? 'private' : 'role'
    }
  }
  return { label: 'Everyone', tone: 'everyone' }
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').toLowerCase()

const classifyRecordingFile = (value: string): 'clean' | 'altered' | 'unknown' => {
  const normalized = normalizePath(value)
  if (/(^|[-_])(dry|clean|unmanipulated)([-_.]|$)/.test(normalized)) return 'clean'
  if (/(^|[-_])(wet|altered|manipulated)([-_.]|$)/.test(normalized)) return 'altered'
  return 'unknown'
}

const fileLooksLikeParticipant = (value: string, participant: CallPeer): boolean => {
  const normalized = normalizePath(value)
  return [participant.userId, participant.displayName]
    .filter(Boolean)
    .some((candidate) => normalized.includes(String(candidate).trim().toLowerCase()))
}

const buildPpsPlaybackPlan = (
  files: string[],
  participants: CallPeer[],
  fallbackSelfId: string,
  fallbackPartnerId: string
): Array<Record<string, unknown>> => {
  const activeParticipants =
    participants.length > 0
      ? participants
      : [
          { userId: fallbackSelfId, displayName: fallbackSelfId, role: 'participant' as const, joinedAt: Date.now() },
          { userId: fallbackPartnerId, displayName: fallbackPartnerId, role: 'participant' as const, joinedAt: Date.now() }
        ].filter((participant) => participant.userId.trim())

  const cleanFiles = files.filter((file) => classifyRecordingFile(file) === 'clean')
  const alteredFiles = files.filter((file) => classifyRecordingFile(file) === 'altered')

  return activeParticipants.map((participant) => {
    const partners = activeParticipants.filter((candidate) => candidate.userId !== participant.userId)
    const selfClean = cleanFiles.find((file) => fileLooksLikeParticipant(file, participant)) ?? cleanFiles[0] ?? null
    const partnerAltered =
      partners
        .map((partner) => alteredFiles.find((file) => fileLooksLikeParticipant(file, partner)))
        .find(Boolean) ??
      alteredFiles.find((file) => !fileLooksLikeParticipant(file, participant)) ??
      alteredFiles[0] ??
      null

    return {
      participantUserId: participant.userId,
      participantDisplayName: participant.displayName,
      ratingView: {
        selfVideo: selfClean,
        partnerVideo: partnerAltered,
        selfVideoMeaning: 'Unmanipulated self recording (clean/dry).',
        partnerVideoMeaning: 'Manipulated partner recording as seen during the conversation (altered/wet).'
      },
      partnerCandidates: partners.map((partner) => ({ userId: partner.userId, displayName: partner.displayName }))
    }
  })
}

const supportedRecorderType = (): string => {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

const applyAudioControlsToProcessor = (
  processor: LiveMediaProcessor | null,
  controlState: ManipulationControls
): void => {
  if (!processor?.audioContext) return

  const now = processor.audioContext.currentTime
  processor.audioGain?.gain.setTargetAtTime(clamp(controlState.audioGain, 0, 2), now, 0.04)
  processor.audioDelay?.delayTime.setTargetAtTime(clamp(controlState.synchronyDelayMs / 1000, 0, 1.5), now, 0.04)

  const tone = clamp(controlState.audioPitch, 0.6, 1.4)
  const warmerAmount = Math.max(0, 1 - tone)
  const brighterAmount = Math.max(0, tone - 1)
  processor.audioLowShelf?.gain.setTargetAtTime(warmerAmount * 14 - brighterAmount * 4, now, 0.05)
  processor.audioHighShelf?.gain.setTargetAtTime(brighterAmount * 14 - warmerAmount * 5, now, 0.05)
}

const applySmileWarp = (
  processor: LiveMediaProcessor,
  width: number,
  height: number,
  controlState: ManipulationControls
): void => {
  // smileAlpha now follows Mozza's convention directly: 0 = neutral, +smile, -frown.
  const targetAlpha = controlState.smileAlpha
  const smoothing = clamp(0.03 + controlState.landmarkBeta * 0.25 + controlState.smoothingCutoff / 80, 0.03, 0.45)
  processor.currentSmileAlpha += (targetAlpha - processor.currentSmileAlpha) * smoothing

  const strength = clamp(processor.currentSmileAlpha, -2.5, 4) * (1 - controlState.faceThreshold * 0.25)
  if (Math.abs(strength) < 0.02 && !controlState.overlay) return

  const regionWidth = width * 0.5
  const regionHeight = height * 0.2
  const regionX = (width - regionWidth) / 2
  const regionY = height * 0.54
  const step = Math.max(3, Math.round(width / 260))
  const maxOffset = clamp(Math.abs(strength) * height * 0.035, 0, height * 0.1)
  const direction = strength >= 0 ? -1 : 1

  for (let x = 0; x < regionWidth; x += step) {
    const normalizedX = (x / regionWidth - 0.5) * 2
    const edgeWeight = Math.pow(Math.abs(normalizedX), 1.8)
    const centerWeight = 1 - Math.abs(normalizedX)
    const smileCurve = direction * maxOffset * edgeWeight + -direction * maxOffset * 0.18 * centerWeight
    const sx = regionX + x
    const sw = Math.min(step + 1, regionWidth - x)
    processor.ctx.drawImage(
      processor.rawVideo,
      sx,
      regionY,
      sw,
      regionHeight,
      sx,
      regionY + smileCurve,
      sw,
      regionHeight
    )
  }

  if (controlState.overlay) {
    processor.ctx.save()
    processor.ctx.strokeStyle = Math.abs(strength) > 0.02 ? '#60a5fa' : '#fbbf24'
    processor.ctx.lineWidth = Math.max(2, width / 360)
    processor.ctx.setLineDash([8, 6])
    processor.ctx.strokeRect(regionX, regionY, regionWidth, regionHeight)
    processor.ctx.fillStyle = 'rgba(2, 6, 23, 0.72)'
    processor.ctx.fillRect(regionX, regionY - 28, Math.min(360, regionWidth), 24)
    processor.ctx.fillStyle = '#dbeafe'
    processor.ctx.font = `${Math.max(12, Math.round(width / 80))}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    processor.ctx.fillText(`smile alpha ${controlState.smileAlpha.toFixed(2)}`, regionX + 8, regionY - 10)
    processor.ctx.restore()
  }
}

export default function App(): ReactElement {
  const callLocalVideoRef = useRef<HTMLVideoElement>(null)
  const callEventsRef = useRef<EventSource | null>(null)
  const callLocalStreamRef = useRef<MediaStream | null>(null)
  const callUserIdRef = useRef<string>(`station-${makeId()}`)
  const formRef = useRef<SessionForm>(initialForm)
  const controlsRef = useRef<ManipulationControls>(initialControls)
  const liveMediaProcessorRef = useRef<LiveMediaProcessor | null>(null)
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const remoteStreamsRef = useRef<Map<string, RemoteTile>>(new Map())
  const cleanStreamRef = useRef<MediaStream | null>(null)
  const alteredStreamRef = useRef<MediaStream | null>(null)
  const eventSourceErrorAtRef = useRef(0)
  const clickAudioContextRef = useRef<AudioContext | null>(null)
  const sessionLinkSectionRef = useRef<HTMLElement | null>(null)
  const chatPanelRef = useRef<HTMLDivElement | null>(null)
  const chatMessagesRef = useRef<ChatMessage[]>([])
  const logListRef = useRef<HTMLDivElement | null>(null)
  const autoJoinedRef = useRef(false)
  const recordingStartRef = useRef<number | null>(null)
  const recordingReanchoredRef = useRef(false)
  const sessionSavedRef = useRef(false)
  const cleanRecorderRef = useRef<MediaRecorder | null>(null)
  const alteredRecorderRef = useRef<MediaRecorder | null>(null)
  const cleanChunksRef = useRef<Blob[]>([])
  const alteredChunksRef = useRef<Blob[]>([])
  // DuckSoup (SFU + Mozza) media path
  const duckSoupPlayerRef = useRef<DuckSoupPlayer | null>(null)
  const duckSoupActiveRef = useRef(false)
  // Set when the DuckSoup interaction ends normally ('end'/'ending'), so a following 'closed'
  // event isn't misread as an unexpected mid-call media drop. Reset on each (re)join.
  const interactionEndedRef = useRef(false)
  const streamUserMapRef = useRef<Map<string, string>>(new Map())
  const callPeersRef = useRef<CallPeer[]>([])
  const duckSoupFilesRef = useRef<Record<string, string[]>>({})
  const controlEventsRef = useRef<ControlEvent[]>([])
  const mediaQualitySamplesRef = useRef<MediaQualitySample[]>([])
  const pendingMozzaControlsRef = useRef<{ face: LiveMozzaFaceParams; audioPitch: number } | null>(null)
  const appliedMozzaControlsRef = useRef<{ face: LiveMozzaFaceParams; audioPitch: number } | null>(null)
  const mozzaControlTimerRef = useRef<number | null>(null)
  const leaveLiveCallRef = useRef<(() => void) | null>(null)
  // Automatic smile onset/offset runs only on each participant's clean local camera. It uses
  // its own detector/timers so it cannot alter DuckSoup negotiation or the monitor path.
  const smileDetectorRef = useRef<SmileOnsetDetector | null>(null)
  const smileDetectorVideoRef = useRef<HTMLVideoElement | null>(null)
  const smileDetectorTimerRef = useRef<number | null>(null)
  const smileDetectorBusyRef = useRef(false)
  const smileDetectorGenerationRef = useRef(0)
  const smileDetectorStreamRef = useRef<MediaStream | null>(null)
  const activeLocalSmileEventIdRef = useRef<string>('')
  const sentLocalSmileEventIdsRef = useRef<Set<string>>(new Set())
  const pendingLocalSmileOnsetSignalsRef = useRef<Map<string, Promise<void>>>(new Map())
  const processedSmileCueIdsRef = useRef<Set<string>>(new Set())
  const processedSmileOffsetIdsRef = useRef<Set<string>>(new Set())
  const activeSmileEnvelopeRef = useRef<{
    eventId: string
    sourceUserId: string
    appliedAtEpochMs: number
    returnStarted: boolean
    onsetCue: SmileOnsetCue
  } | null>(null)
  const smileEnvelopeReturnTimerRef = useRef<number | null>(null)
  const smileEnvelopeDoneTimerRef = useRef<number | null>(null)
  const smileEnvelopeWatchdogTimerRef = useRef<number | null>(null)
  const automaticSmileReturnLockUntilRef = useRef(0)
  const smileOnsetAuditEventsRef = useRef<SmileOnsetAuditEvent[]>([])
  // Experimenter 4-view monitor: a separate WebRTC channel (runs alongside the DuckSoup SFU)
  // so the controller can see all four feeds. DuckSoup only relays each participant's ALTERED
  // (wet) stream live; the CLEAN (dry) stream never leaves the participant's machine. So each
  // participant forwards its OWN clean camera + the PARTNER's altered stream (which it already
  // receives from the SFU) to the controller. Every forwarded stream is self-labelled with
  // { kind: 'clean'|'altered', userId } so the controller can drop it in the right tile.
  const monitorConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const monitorStreamMetaRef = useRef<Map<string, { kind: 'clean' | 'altered'; userId: string; displayName: string }>>(new Map())
  const monitorPendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const publishedMonitorSigRef = useRef<string>('')
  const monitorReceivedRef = useRef<Map<string, MonitorTile>>(new Map())
  // True from the moment the user initiates a join until they leave. Late async callbacks
  // (DuckSoup teardown events like 'end'/'track', in-flight signaling) check this so pressing
  // "Leave room" can't be undone by a stale event flipping callState back or re-adding tiles.
  const inCallRef = useRef(false)

  const [setupComplete, setSetupComplete] = useState(false)
  const [welcomeComplete, setWelcomeComplete] = useState(false)
  const [callState, setCallState] = useState<CallState>('idle')
  const [callPeers, setCallPeers] = useState<CallPeer[]>([])
  const [remoteTiles, setRemoteTiles] = useState<RemoteTile[]>([])
  const [monitorTiles, setMonitorTiles] = useState<MonitorTile[]>([])
  const [, setRoomPresence] = useState<RoomPresence | null>(null)
  const [storagePaths, setStoragePaths] = useState<{ serverDataDir: string; sessionsDir: string } | null>(null)
  const [experimenterNotes, setExperimenterNotes] = useState('')
  const experimenterNotesRef = useRef('')
  const [form, setForm] = useState<SessionForm>(initialForm)
  const [controls, setControls] = useState<ManipulationControls>(initialControls)
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  // Controller-only: the DuckSoup interaction hit its server-side duration cap, so the recordings
  // stopped even though both people are still in the room. Freezes the call timer + warns.
  const [interactionCapReached, setInteractionCapReached] = useState(false)
  const [sessionDir, setSessionDir] = useState<string>('')
  const [showSelfView, setShowSelfView] = useState(true)
  const [monitorView, setMonitorView] = useState<'all' | 'altered' | 'clean'>('all')
  const [timedSchedule, setTimedSchedule] = useState<TimedPreset[]>([])
  const [timedAtMin, setTimedAtMin] = useState(0)
  const [timedAtSec, setTimedAtSec] = useState(0)
  const [timedAlpha, setTimedAlpha] = useState('0')
  const timedScheduleRef = useRef<TimedPreset[]>([])
  const fireTimedPresetRef = useRef<(preset: TimedPreset) => void>(() => {})
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [controlEvents, setControlEvents] = useState<ControlEvent[]>([])
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [chatTarget, setChatTarget] = useState<ChatTarget>('room')
  const [sessionLinkInput, setSessionLinkInput] = useState('')
  const [appliedSessionLinkInput, setAppliedSessionLinkInput] = useState('')
  const [sessionLinkNotice, setSessionLinkNotice] = useState('')
  const [experimenterLoginOpen, setExperimenterLoginOpen] = useState(false)
  const [experimenterCredentials, setExperimenterCredentials] = useState({ username: '', password: '' })
  const [experimenterLoginError, setExperimenterLoginError] = useState('')
  const [smileDetectorSnapshot, setSmileDetectorSnapshot] = useState<SmileDetectorSnapshot | null>(null)
  const [smileOnsetAuditEvents, setSmileOnsetAuditEvents] = useState<SmileOnsetAuditEvent[]>([])
  const [cleanStreamVersion, setCleanStreamVersion] = useState(0)

  const isController = form.role === 'controller'
  const useDuckSoup = form.mediaTransport === 'ducksoup' && form.duckSoupUrl.trim().length > 0
  const expectedParticipants = sessionCapacity[form.sessionFormat]
  const participantPeers = useMemo(() => callPeers.filter((peer) => peer.role === 'participant'), [callPeers])
  // True only while every expected participant is in the room. Drives the call timer (and mirrors
  // the recording anchor / timed schedule, which both key off both participants being present), so
  // the clock starts when both join and pauses the moment either one leaves.
  const bothParticipantsPresent = expectedParticipants > 0 && participantPeers.length >= expectedParticipants
  const monitorByKey = useMemo(() => new Map(monitorTiles.map((tile) => [tile.key, tile])), [monitorTiles])
  const selectedControlTarget = useMemo(
    () => participantPeers.find((peer) => peer.userId === form.targetUserId),
    [form.targetUserId, participantPeers]
  )
  const controlTargetLabel = selectedControlTarget
    ? selectedControlTarget.displayName
    : form.targetUserId
      ? form.targetUserId
      : 'all participants'
  const sessionLink = useMemo(() => {
    let url: URL
    try {
      url = new URL('/join', form.callSignalUrl || hostedSignalUrl)
    } catch {
      url = new URL('/join', hostedSignalUrl)
    }
    url.searchParams.set('roomId', form.roomId)
    url.searchParams.set('studyId', form.studyId)
    url.searchParams.set('format', form.sessionFormat)
    url.searchParams.set('transport', form.mediaTransport)
    if (form.mediaTransport === 'ducksoup' && form.duckSoupUrl.trim()) {
      url.searchParams.set('ds', form.duckSoupUrl.trim())
    }
    if (form.dyadId.trim()) url.searchParams.set('dyadId', form.dyadId.trim())
    return url.toString()
  }, [
    form.callSignalUrl,
    form.dyadId,
    form.duckSoupUrl,
    form.mediaTransport,
    form.roomId,
    form.sessionFormat,
    form.studyId
  ])

  const addLog = useCallback((message: string, level: LogEvent['level'] = 'info') => {
    setLogs((prev) =>
      [
        ...prev,
        {
          id: makeId(),
          timestamp: new Date().toLocaleTimeString(),
          level,
          message
        }
      ].slice(-100)
    )
  }, [])

  const playButtonClick = useCallback(() => {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextConstructor) return

    const audioContext = clickAudioContextRef.current ?? new AudioContextConstructor()
    clickAudioContextRef.current = audioContext
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => undefined)

    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(520, audioContext.currentTime)
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.035, audioContext.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.07)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    oscillator.stop(audioContext.currentTime + 0.08)
  }, [])

  const playNoticeTone = useCallback(() => {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextConstructor) return

    const audioContext = clickAudioContextRef.current ?? new AudioContextConstructor()
    clickAudioContextRef.current = audioContext
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => undefined)

    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(240, audioContext.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(170, audioContext.currentTime + 0.12)
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.05, audioContext.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    oscillator.stop(audioContext.currentTime + 0.17)
  }, [])

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target.closest('button') : null
      if (!(target instanceof HTMLButtonElement) || target.disabled) return
      playButtonClick()
    }

    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [playButtonClick])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (recordingStartRef.current) {
        setRecordingSeconds(Math.floor((Date.now() - recordingStartRef.current) / 1000))
      }
    }, 500)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    formRef.current = form
  }, [form])

  useEffect(() => {
    controlsRef.current = controls
    for (const video of document.querySelectorAll<HTMLVideoElement>('video[data-remote-call-video="true"]')) {
      applyMediaElementVolume(video, controls.partnerVolume)
    }
    applyAudioControlsToProcessor(liveMediaProcessorRef.current, controls)
    // Coalesce rapid slider events before they reach the GStreamer pipeline. The latest
    // value is still applied live, but redundant beta/fc/threshold/pitch writes are skipped.
    if (duckSoupPlayerRef.current && !isController) {
      pendingMozzaControlsRef.current = {
        face: {
          smileAlpha: controls.smileAlpha,
          faceThreshold: controls.faceThreshold,
          landmarkBeta: controls.landmarkBeta,
          smoothingCutoff: controls.smoothingCutoff
        },
        audioPitch: controls.audioPitch
      }
      if (mozzaControlTimerRef.current === null) {
        mozzaControlTimerRef.current = window.setTimeout(() => {
          mozzaControlTimerRef.current = null
          const player = duckSoupPlayerRef.current
          const pending = pendingMozzaControlsRef.current
          if (!player || !pending) return

          const previous = appliedMozzaControlsRef.current
          applyMozzaControlChanges(player, pending.face, previous?.face ?? null)
          if (!previous || pending.audioPitch !== previous.audioPitch) {
            player.controlFx(MOZZA_AUDIO_FX_NAME, 'pitch', pending.audioPitch)
          }
          appliedMozzaControlsRef.current = pending
        }, MOZZA_CONTROL_INTERVAL_MS)
      }
    }
  }, [controls, isController])

  useEffect(
    () => () => {
      if (mozzaControlTimerRef.current !== null) {
        window.clearTimeout(mozzaControlTimerRef.current)
        mozzaControlTimerRef.current = null
      }
    },
    []
  )

  // Keep a ref of room presence fresh for DuckSoup callbacks, and refresh remote tile
  // labels (DuckSoup gives us userIds; display names come from the Render presence list).
  useEffect(() => {
    controlEventsRef.current = controlEvents
  }, [controlEvents])

  // Experimenter: re-anchor the recording start to when both participants are present (≈ when the
  // DuckSoup interaction begins recording), so manipulation_events.csv lines up with the videos.
  // Anything logged before this (while waiting) keeps its absolute UTC timestamp and recomputes to a
  // negative elapsedMs at save time. One-shot per session (reset on (re)join below).
  useEffect(() => {
    if (!isController || recordingReanchoredRef.current) return
    if (expectedParticipants > 0 && participantPeers.length >= expectedParticipants) {
      recordingStartRef.current = Date.now()
      recordingReanchoredRef.current = true
      setRecordingSeconds(0)
      setInteractionCapReached(false)
      // New recording window: let the timed schedule fire again from this t=0.
      setTimedSchedule((prev) => prev.map((preset) => ({ ...preset, fired: false })))
    }
  }, [isController, participantPeers.length, expectedParticipants])

  // Controller-only: DuckSoup ends the interaction (and its recording) at DUCKSOUP_DURATION_SEC.
  // The experimenter owns no media player, so it never receives the 'end' event — detect the cap
  // from the recording clock, freeze the call timer, and warn once. Without this the timer runs
  // past 20:00 and "Conclude" stays armed as if recording were still live.
  useEffect(() => {
    // Only DuckSoup enforces the server-side duration cap; the legacy mesh path has no such limit.
    if (!isController || !useDuckSoup || interactionCapReached || !recordingReanchoredRef.current) return
    if (recordingSeconds >= DUCKSOUP_DURATION_SEC) {
      setInteractionCapReached(true)
      addLog(
        'Reached the media server duration limit — the recording has stopped. Conclude the study to save, or have both participants rejoin to start a new interaction.',
        'warn'
      )
    }
  }, [isController, useDuckSoup, recordingSeconds, interactionCapReached, addLog])

  // Keep a fresh ref of the timed schedule for the scheduler interval below.
  useEffect(() => {
    timedScheduleRef.current = timedSchedule
  }, [timedSchedule])

  // Timed manipulation schedule (experimenter): once recording is anchored, fire each preset when the
  // conversation reaches its time (e.g. "at 3:00, set smile alpha to 0.8"). One-shot per recording window.
  useEffect(() => {
    const id = window.setInterval(() => {
      const startedAt = recordingStartRef.current
      if (!startedAt || !recordingReanchoredRef.current || formRef.current?.role !== 'controller') return
      const elapsedMs = Date.now() - startedAt
      const due = timedScheduleRef.current.filter(
        (preset) => !preset.fired && elapsedMs >= preset.atSeconds * 1000
      )
      if (due.length === 0) return
      const dueIds = new Set(due.map((preset) => preset.id))
      timedScheduleRef.current = timedScheduleRef.current.map((preset) =>
        dueIds.has(preset.id) ? { ...preset, fired: true } : preset
      )
      setTimedSchedule(timedScheduleRef.current)
      due.forEach((preset) => fireTimedPresetRef.current(preset))
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    smileOnsetAuditEventsRef.current = smileOnsetAuditEvents
  }, [smileOnsetAuditEvents])

  // Keep a fresh ref of chat messages so session finalize (which runs from refs) can
  // write the full chat_log.csv without re-creating the callback on every message.
  useEffect(() => {
    chatMessagesRef.current = chatMessages
  }, [chatMessages])

  // If a direct-message target was selected and that peer leaves, fall back to
  // Everyone so messages don't silently route to a dead userId.
  useEffect(() => {
    if (chatTarget === 'room' || chatTarget === 'controllers' || chatTarget === 'participants') return
    if (!callPeers.some((peer) => peer.userId === chatTarget)) setChatTarget('room')
  }, [callPeers, chatTarget])

  // Same guard for the manipulation Control target: if the selected participant leaves or
  // reconnects with a new station id, fall back to All participants. Otherwise every slider /
  // timed change would broadcast to a dead userId and silently reach nobody, while the log and
  // manipulation_events.csv still claim the manipulation was applied.
  useEffect(() => {
    if (!form.targetUserId) return
    if (!participantPeers.some((peer) => peer.userId === form.targetUserId)) {
      updateForm('targetUserId', '')
      addLog('Control target left or reconnected — reset to All participants.', 'warn')
    }
  }, [participantPeers, form.targetUserId])

  // Keep the newest event in view as the log grows.
  useEffect(() => {
    const el = logListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // Keep the self-view <video> bound to the local camera stream. The stream is attached
  // imperatively when it first arrives, so if the element re-renders detached (e.g. when
  // the self tile swaps between full-size and PiP, or the layout changes) the preview can
  // go black. Re-attach it whenever that happens so the camera doesn't randomly drop out.
  useEffect(() => {
    const video = callLocalVideoRef.current
    const stream = callLocalStreamRef.current
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => undefined)
    }
  })

  // Auto-join the room once, only when the user first reaches it (entering from setup).
  // Deliberately depends on setupComplete ONLY — not callState — so that pressing "Leave
  // room" (which sets callState to 'idle') can never re-trigger an auto-join. Re-arms when
  // you go back to setup; the manual Join/Rejoin button covers re-entry and error recovery.
  useEffect(() => {
    if (!setupComplete) {
      autoJoinedRef.current = false
      return
    }
    if (autoJoinedRef.current) return
    autoJoinedRef.current = true
    void joinLiveCall()
  }, [setupComplete])

  useEffect(() => {
    callPeersRef.current = callPeers
    if (remoteStreamsRef.current.size === 0) return
    let changed = false
    for (const peer of callPeers) {
      const tile = remoteStreamsRef.current.get(peer.userId)
      if (tile && (tile.displayName !== peer.displayName || tile.role !== peer.role)) {
        remoteStreamsRef.current.set(peer.userId, { ...tile, displayName: peer.displayName, role: peer.role })
        changed = true
      }
    }
    if (changed) syncRemoteTiles()
  }, [callPeers])

  // Ask the main process for the exact on-disk save locations (so the Recording panel can show them).
  useEffect(() => {
    window.researchApi
      ?.getStoragePaths?.()
      .then(setStoragePaths)
      .catch(() => undefined)
  }, [])

  // Participant: (re)publish the monitor feeds whenever peers or local/partner streams change
  // (controller joins, partner's altered stream arrives, etc.). publishMonitorStreams is a no-op
  // for the controller and dedupes via a stream-set signature, so extra runs are cheap.
  useEffect(() => {
    if (!useDuckSoup || isController) return
    publishMonitorStreams().catch((error) =>
      addLog(error instanceof Error ? error.message : 'Could not share view with the experimenter.', 'error')
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callPeers, remoteTiles, callState, useDuckSoup, isController])

  const updateForm = <K extends keyof SessionForm>(field: K, value: SessionForm[K]): void => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const signalBaseUrl = (): string => form.callSignalUrl.replace(/\/$/, '')

  const callDisplayName = (): string => {
    const fallback = isController ? 'Experimenter' : 'Participant'
    return form.displayName.trim() || (isController && form.raId ? `Experimenter ${form.raId}` : fallback)
  }

  const submitExperimenterLogin = (): void => {
    const username = experimenterCredentials.username.trim()
    const password = experimenterCredentials.password
    if (username !== 'admin' || password !== 'admin') {
      setExperimenterLoginError('Use the lab experimenter credentials to continue.')
      return
    }

    setForm((prev) => ({
      ...prev,
      role: 'controller',
      displayName: prev.displayName === 'Participant' ? 'Experimenter' : prev.displayName
    }))
    setExperimenterLoginOpen(false)
    setExperimenterCredentials({ username: '', password: '' })
    setExperimenterLoginError('')
    addLog('Experimenter mode unlocked.', 'success')
  }

  const returnToParticipantMode = (): void => {
    setForm((prev) => ({
      ...prev,
      role: 'participant',
      displayName: prev.displayName === 'Experimenter' ? 'Participant' : prev.displayName
    }))
    setExperimenterLoginOpen(false)
    setExperimenterLoginError('')
    addLog('Returned to participant setup.', 'info')
  }

  const applySessionLink = (value: string): boolean => {
    const trimmed = value.trim()
    if (!trimmed) return false

    try {
      const parsed = parseSessionLink(trimmed)
      setForm((prev) => ({ ...prev, ...parsed }))
      setAppliedSessionLinkInput(trimmed)
      setSessionLinkNotice('')
      addLog('Session link loaded. You can continue to the room.', 'success')
      return true
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Could not read that session link.', 'error')
      return false
    }
  }

  const copySessionLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sessionLink)
      addLog('Participant session link copied.', 'success')
    } catch {
      addLog('Could not copy automatically. Select and copy the session link manually.', 'warn')
    }
  }

  const startSignalServer = async (): Promise<{ ok: boolean; localUrl: string; lanUrl: string }> => {
    const result = await window.researchApi.startCallSignalServer(8765)
    updateForm('callSignalUrl', result.localUrl)
    addLog(`Call server running. Participants can use ${result.lanUrl}.`, 'success')
    return result
  }

  const checkRoomStatus = useCallback(
    async (quiet = false, overrides?: { roomId?: string; callSignalUrl?: string }): Promise<boolean> => {
      const roomId = overrides?.roomId ?? form.roomId
      const callSignalUrl = overrides?.callSignalUrl ?? form.callSignalUrl

      if (!callSignalUrl.trim() || !roomId.trim()) {
        if (!quiet) addLog('Enter a call server URL and meeting ID before checking the room.', 'error')
        return false
      }

      try {
        const url = new URL('/room', callSignalUrl.replace(/\/$/, ''))
        url.searchParams.set('roomId', roomId.trim())
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Room check failed with HTTP ${response.status}`)
        const status = (await response.json()) as RoomPresence
        setRoomPresence(status)
        if (!quiet) {
          addLog(
            `${status.peers.length} ${status.peers.length === 1 ? 'person is' : 'people are'} currently in ${status.roomId}.`,
            'success'
          )
        }
        return true
      } catch (error) {
        setRoomPresence(null)
        if (!quiet) {
          addLog(
            error instanceof Error
              ? error.message
              : 'Room server is not reachable. Check the host URL before joining.',
            'error'
          )
        }
        return false
      }
    },
    [addLog, form.callSignalUrl, form.roomId]
  )

  useEffect(() => {
    if (!setupComplete || !form.callSignalUrl.trim() || !form.roomId.trim()) return undefined

    checkRoomStatus(true).catch(() => undefined)
    const interval = window.setInterval(() => {
      checkRoomStatus(true).catch(() => undefined)
    }, 4000)

    return () => window.clearInterval(interval)
  }, [checkRoomStatus, form.callSignalUrl, form.roomId, setupComplete])

  const pickFolder = async (): Promise<void> => {
    const folder = await window.researchApi.selectOutputFolder()
    if (folder) {
      updateForm('outputFolder', folder)
      addLog(`Output folder selected: ${folder}`, 'success')
    }
  }

  const appendControlEvent = useCallback(
    (control: string, value: string | number | boolean, notes = '', targetOverride?: string) => {
      const event: ControlEvent = {
        id: makeId(),
        timestamp: new Date().toISOString(),
        elapsedMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : 0,
        roomId: form.roomId,
        participantId: form.participantId,
        partnerId: form.partnerId,
        targetUserId: (targetOverride !== undefined ? targetOverride : form.targetUserId) || 'all-participants',
        condition: form.condition,
        control,
        value,
        appliedToDuckSoup: duckSoupActiveRef.current,
        notes
      }
      setControlEvents((prev) => [...prev, event])
    },
    [form]
  )

  const sendDirectorPayload = useCallback(
    (payload: DirectorPayload): void => {
      if (!form.roomId.trim() || !form.callSignalUrl.trim() || !callEventsRef.current) return

      fetch(`${signalBaseUrl()}/director-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: form.roomId,
          from: callUserIdRef.current,
          type: 'live-control',
          role: form.role,
          displayName: callDisplayName(),
          payload
        })
      }).catch((error) =>
        addLog(error instanceof Error ? error.message : 'Could not send live control to the room.', 'error')
      )
    },
    [addLog, form.callSignalUrl, form.role, form.roomId]
  )

  const broadcastLiveControl = useCallback(
    (
      key: keyof ManipulationControls,
      value: ManipulationControls[keyof ManipulationControls],
      label?: string,
      // Explicit routing override. Pass a userId to target one participant, '' to target all,
      // or leave undefined to use the current Control-target dropdown (form.targetUserId).
      targetOverride?: string
    ): void => {
      const target = targetOverride !== undefined ? targetOverride : form.targetUserId
      sendDirectorPayload({
        kind: 'live-control',
        key,
        value,
        targetUserId: target || undefined,
        label
      })
    },
    [form.targetUserId, sendDirectorPayload]
  )

  const applyRemoteLiveControl = useCallback(
    (payload: unknown, sender = 'Experimenter'): void => {
      if (!payload || typeof payload !== 'object') return
      const message = payload as Partial<DirectorPayload> & {
        key?: keyof ManipulationControls
        value?: unknown
        targetUserId?: string
      }
      const targetUserId = typeof message.targetUserId === 'string' ? message.targetUserId : ''
      if (targetUserId && targetUserId !== callUserIdRef.current) return

      if (message.kind === 'session-conclude') {
        appendControlEvent('study', 'conclude', `Received study conclusion command from ${sender}.`)
        addLog(`${sender} concluded the study. Saving and leaving the room.`, 'warn')
        window.setTimeout(() => leaveLiveCallRef.current?.(), 0)
        return
      }

      if (message.kind === 'cue-response') {
        const alpha = typeof message.alpha === 'number' ? message.alpha : initialControls.suppressSmileAlpha
        const returnAlpha = typeof message.returnAlpha === 'number' ? message.returnAlpha : initialControls.smileAlpha
        const durationMs = typeof message.durationMs === 'number' ? message.durationMs : initialControls.reactivePulseMs
        setControls((prev) => ({ ...prev, synchronyMode: 'reactive', smileAlpha: alpha }))
        appendControlEvent(
          'cueResponse',
          alpha,
          `${sender}: ${message.label || message.cue || 'behavioral cue'}; returning to ${returnAlpha} after ${durationMs}ms.`
        )
        addLog(`${sender} triggered ${message.label || 'a synchrony cue response'}.`, 'info')
        window.setTimeout(() => {
          setControls((prev) => ({ ...prev, smileAlpha: returnAlpha }))
          appendControlEvent('cueResponseReturn', returnAlpha, 'Reactive cue response returned to baseline.')
        }, durationMs)
        return
      }

      const update = message as { key?: keyof ManipulationControls; value?: unknown }
      if (!update.key || !(update.key in initialControls)) return
      if (update.key === 'partnerVolume') return

      setControls((prev) => {
        const next = { ...prev, [update.key!]: update.value as never }
        controlsRef.current = next
        return next
      })
      const loggedValue =
        typeof update.value === 'string' || typeof update.value === 'number' || typeof update.value === 'boolean'
          ? update.value
          : String(update.value)
      appendControlEvent(String(update.key), loggedValue, `Received from ${sender}.`)
      addLog(`${sender} set ${String(update.key)} = ${String(update.value)}.`, 'info')
    },
    [addLog, appendControlEvent]
  )

  const postSignal = useCallback(async (type: string, payload?: unknown, to?: string): Promise<void> => {
    const response = await fetch(`${signalBaseUrl()}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: form.roomId,
        from: callUserIdRef.current,
        to,
        type,
        payload,
        role: form.role,
        displayName: callDisplayName()
      })
    })
    if (!response.ok) {
      throw new Error(`Room signaling rejected ${type} (${response.status}).`)
    }
  }, [form.callSignalUrl, form.role, form.roomId])

  const appendSmileOnsetAudit = useCallback((event: SmileOnsetAuditEvent): void => {
    setSmileOnsetAuditEvents((previous) => {
      const key = `${event.eventId}:${event.stage}:${event.timestamp}`
      if (previous.some((item) => `${item.eventId}:${item.stage}:${item.timestamp}` === key)) return previous
      const next = [...previous, event].slice(-2_000)
      smileOnsetAuditEventsRef.current = next
      return next
    })
  }, [])

  const currentSmileQuality = (): Pick<
    SmileOnsetAuditEvent,
    'videoRttMs' | 'videoJitterMs' | 'videoPacketsLost' | 'framesDropped'
  > => {
    const quality = mediaQualitySamplesRef.current.at(-1)
    return {
      videoRttMs: quality?.videoRttMs ?? '',
      videoJitterMs: quality?.videoJitterMs ?? '',
      videoPacketsLost: quality?.videoPacketsLost ?? '',
      framesDropped: quality?.framesDropped ?? ''
    }
  }

  const sendSmileAuditToExperimenter = useCallback(
    (event: SmileOnsetAuditEvent): void => {
      if (isController) {
        appendSmileOnsetAudit(event)
        return
      }
      const controllers = callPeersRef.current.filter((peer) => peer.role === 'controller')
      for (const controller of controllers) {
        postSignal('smile-synchrony-audit', event, controller.userId).catch(() => undefined)
      }
    },
    [appendSmileOnsetAudit, isController, postSignal]
  )

  const makeSmileAuditEvent = (
    cue: Partial<SmileSynchronyCue> & { eventId: string },
    stage: SmileOnsetAuditEvent['stage'],
    reason: string
  ): SmileOnsetAuditEvent => {
    const currentForm = formRef.current
    const targetPeer = callPeersRef.current.find((peer) => peer.userId === cue.targetUserId)
    return {
      eventId: cue.eventId,
      timestamp: new Date().toISOString(),
      elapsedMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : 0,
      observedAtIso: cue.observedAtIso ?? '',
      observedAtEpochMs: cue.observedAtEpochMs ?? '',
      observedAtMonotonicMs: cue.observedAtMonotonicMs ?? '',
      roomId: currentForm.roomId,
      sourceUserId: cue.sourceUserId ?? callUserIdRef.current,
      sourceParticipantId: cue.sourceParticipantId ?? currentForm.participantId,
      targetUserId: cue.targetUserId ?? '',
      targetParticipantId: targetPeer?.participantId ?? '',
      cueType: cue.cue ?? 'system',
      stage,
      mode: controlsRef.current.automaticSmileOnsetMode,
      rawSmile: cue.rawSmile ?? '',
      normalizedSmile: cue.normalizedSmile ?? '',
      smoothedNormalizedSmile: 'smoothedNormalizedSmile' in cue ? (cue.smoothedNormalizedSmile ?? '') : '',
      mouthSmileLeft: cue.mouthSmileLeft ?? '',
      mouthSmileRight: cue.mouthSmileRight ?? '',
      jawOpen: cue.jawOpen ?? '',
      reason,
      ...currentSmileQuality()
    }
  }

  const clearSmileEnvelopeTimers = (): void => {
    if (smileEnvelopeReturnTimerRef.current !== null) {
      window.clearTimeout(smileEnvelopeReturnTimerRef.current)
      smileEnvelopeReturnTimerRef.current = null
    }
    if (smileEnvelopeDoneTimerRef.current !== null) {
      window.clearTimeout(smileEnvelopeDoneTimerRef.current)
      smileEnvelopeDoneTimerRef.current = null
    }
    if (smileEnvelopeWatchdogTimerRef.current !== null) {
      window.clearTimeout(smileEnvelopeWatchdogTimerRef.current)
      smileEnvelopeWatchdogTimerRef.current = null
    }
  }

  const applyAutomaticSmileAlpha = (alpha: number, transitionMs: number): boolean => {
    const player = duckSoupPlayerRef.current
    if (!player || !duckSoupActiveRef.current) return false

    player.controlFx(MOZZA_FX_NAME, 'alpha', alpha, transitionMs)
    const previousApplied = appliedMozzaControlsRef.current
    const currentControls = controlsRef.current
    const nextFace: LiveMozzaFaceParams = {
      smileAlpha: alpha,
      faceThreshold: currentControls.faceThreshold,
      landmarkBeta: currentControls.landmarkBeta,
      smoothingCutoff: currentControls.smoothingCutoff
    }
    appliedMozzaControlsRef.current = {
      face: nextFace,
      audioPitch: previousApplied?.audioPitch ?? currentControls.audioPitch
    }
    setControls((previous) => {
      const next = { ...previous, smileAlpha: alpha }
      controlsRef.current = next
      return next
    })
    return true
  }

  const returnAutomaticSmileToNeutral = useCallback(
    (reason: string, audit = true): void => {
      const active = activeSmileEnvelopeRef.current
      clearSmileEnvelopeTimers()
      if (!active) return

      applyAutomaticSmileAlpha(0, SMILE_OFFSET_RETURN_MS)
      automaticSmileReturnLockUntilRef.current = Date.now() + SMILE_OFFSET_RETURN_MS
      if (audit) {
        const event = makeSmileAuditEvent(
          active.onsetCue,
          'cancelled',
          reason
        )
        sendSmileAuditToExperimenter(event)
      }
      activeSmileEnvelopeRef.current = null
    },
    [sendSmileAuditToExperimenter]
  )

  const startAutomaticSmileReturn = useCallback(
    (
      cue: SmileSynchronyCue,
      reason: string,
      stage: 'return-started' | 'watchdog-return' = 'return-started'
    ): void => {
      const active = activeSmileEnvelopeRef.current
      if (!active || active.eventId !== cue.eventId || active.sourceUserId !== cue.sourceUserId) return
      if (active.returnStarted) return

      clearSmileEnvelopeTimers()
      active.returnStarted = true
      if (!applyAutomaticSmileAlpha(0, SMILE_OFFSET_RETURN_MS)) {
        activeSmileEnvelopeRef.current = null
        sendSmileAuditToExperimenter(
          makeSmileAuditEvent(cue, 'rejected', 'Mozza did not accept the return-to-baseline command.')
        )
        return
      }

      sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, stage, reason))
      smileEnvelopeDoneTimerRef.current = window.setTimeout(() => {
        smileEnvelopeDoneTimerRef.current = null
        const current = activeSmileEnvelopeRef.current
        if (!current || current.eventId !== cue.eventId || current.sourceUserId !== cue.sourceUserId) return
        activeSmileEnvelopeRef.current = null
        sendSmileAuditToExperimenter(
          makeSmileAuditEvent(
            cue,
            'returned',
            `Added smile removed; Mozza alpha reached the participant's physical baseline (0.00) over ${SMILE_OFFSET_RETURN_MS} ms.`
          )
        )
      }, SMILE_OFFSET_RETURN_MS)
    },
    [sendSmileAuditToExperimenter]
  )

  const applyAutomaticSmileCue = useCallback(
    (cue: SmileOnsetCue, senderUserId: string): void => {
      const mode = controlsRef.current.automaticSmileOnsetMode
      const sourcePeer = callPeersRef.current.find(
        (peer) => peer.userId === cue.sourceUserId && peer.role === 'participant'
      )
      const ageMs = Date.now() - cue.observedAtEpochMs
      const localDetectorSnapshot = smileDetectorRef.current?.snapshot(performance.now())
      const localFaceReady =
        Boolean(localDetectorSnapshot?.facePresent) &&
        Boolean(
          localDetectorSnapshot &&
            ['ready', 'onset-candidate', 'cue-active', 'cooldown'].includes(localDetectorSnapshot.phase)
        )
      const rejection = smileCueRejectionReason({
        mode,
        cueTargetUserId: cue.targetUserId,
        localUserId: callUserIdRef.current,
        cueSourceUserId: cue.sourceUserId,
        senderUserId,
        sourceIsParticipant: Boolean(sourcePeer),
        ageMs,
        maxAgeMs: SMILE_CUE_MAX_AGE_MS,
        duplicate: processedSmileCueIdsRef.current.has(cue.eventId),
        responseAlreadyActive:
          Boolean(activeSmileEnvelopeRef.current) || Date.now() < automaticSmileReturnLockUntilRef.current,
        duckSoupActive: duckSoupActiveRef.current && Boolean(duckSoupPlayerRef.current),
        localFaceReady
      })

      if (rejection) {
        sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, 'rejected', rejection))
        return
      }

      processedSmileCueIdsRef.current.add(cue.eventId)
      if (processedSmileCueIdsRef.current.size > 500) {
        const oldest = processedSmileCueIdsRef.current.values().next().value
        if (oldest) processedSmileCueIdsRef.current.delete(oldest)
      }

      activeSmileEnvelopeRef.current = {
        eventId: cue.eventId,
        sourceUserId: cue.sourceUserId,
        appliedAtEpochMs: Date.now(),
        returnStarted: false,
        onsetCue: cue
      }
      automaticSmileReturnLockUntilRef.current = 0
      if (!applyAutomaticSmileAlpha(SMILE_RESPONSE_ALPHA, SMILE_RESPONSE_RAMP_MS)) {
        activeSmileEnvelopeRef.current = null
        sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, 'rejected', 'Mozza did not accept the response.'))
        return
      }
      sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, 'applied', 'Aligned smile envelope started.'))

      smileEnvelopeWatchdogTimerRef.current = window.setTimeout(() => {
        smileEnvelopeWatchdogTimerRef.current = null
        startAutomaticSmileReturn(
          cue,
          `Safety watchdog returned the added smile to baseline after ${SMILE_RESPONSE_WATCHDOG_MS} ms without a matched offset.`,
          'watchdog-return'
        )
      }, SMILE_RESPONSE_WATCHDOG_MS)
    },
    [sendSmileAuditToExperimenter, startAutomaticSmileReturn]
  )

  const applyAutomaticSmileOffset = useCallback(
    (cue: SmileOffsetCue, senderUserId: string): void => {
      const active = activeSmileEnvelopeRef.current
      const sourcePeer = callPeersRef.current.find(
        (peer) => peer.userId === cue.sourceUserId && peer.role === 'participant'
      )
      const validationRejection = smileOffsetRejectionReason({
        mode: controlsRef.current.automaticSmileOnsetMode,
        cueTargetUserId: cue.targetUserId,
        localUserId: callUserIdRef.current,
        cueSourceUserId: cue.sourceUserId,
        senderUserId,
        sourceIsParticipant: Boolean(sourcePeer),
        ageMs: Date.now() - cue.observedAtEpochMs,
        maxAgeMs: SMILE_CUE_MAX_AGE_MS,
        duplicate: processedSmileOffsetIdsRef.current.has(cue.eventId),
        activeEventId: active?.eventId ?? '',
        activeSourceUserId: active?.sourceUserId ?? '',
        returnAlreadyStarted: active?.returnStarted ?? false,
        duckSoupActive: duckSoupActiveRef.current && Boolean(duckSoupPlayerRef.current)
      })
      const matchRejection = active
        ? smileOffsetMatchRejectionReason(cue.eventId, cue.sourceUserId, active.eventId, active.sourceUserId)
        : ''
      const rejection = validationRejection || matchRejection
      if (rejection) {
        sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, 'rejected', rejection))
        return
      }

      processedSmileOffsetIdsRef.current.add(cue.eventId)
      if (processedSmileOffsetIdsRef.current.size > 500) {
        const oldest = processedSmileOffsetIdsRef.current.values().next().value
        if (oldest) processedSmileOffsetIdsRef.current.delete(oldest)
      }
      sendSmileAuditToExperimenter(
        makeSmileAuditEvent(cue, 'offset-received', 'Matched participant-driven smile offset received.')
      )

      const returnDelayMs = smileOffsetReturnDelayMs(
        active!.appliedAtEpochMs,
        Date.now(),
        SMILE_RESPONSE_RAMP_MS,
        SMILE_OFFSET_MIN_PEAK_HOLD_MS
      )
      if (returnDelayMs <= 0) {
        startAutomaticSmileReturn(cue, 'Matched smile offset started the return to baseline.')
        return
      }

      sendSmileAuditToExperimenter(
        makeSmileAuditEvent(
          cue,
          'return-queued',
          `Offset arrived early; return queued for ${returnDelayMs} ms to preserve the minimum peak hold.`
        )
      )
      if (smileEnvelopeReturnTimerRef.current !== null) window.clearTimeout(smileEnvelopeReturnTimerRef.current)
      smileEnvelopeReturnTimerRef.current = window.setTimeout(() => {
        smileEnvelopeReturnTimerRef.current = null
        startAutomaticSmileReturn(cue, 'Queued smile offset started the return to baseline.')
      }, returnDelayMs)
    },
    [sendSmileAuditToExperimenter, startAutomaticSmileReturn]
  )

  const handleLocalSmileDetectorEvent = useCallback(
    (event: SmileDetectorEvent): void => {
      const currentForm = formRef.current
      const target = callPeersRef.current.find(
        (peer) => peer.role === 'participant' && peer.userId !== callUserIdRef.current
      )
      const mode = controlsRef.current.automaticSmileOnsetMode

      if (event.kind === 'calibration-ready') {
        addLog('Local smile synchrony calibration is ready.', 'success')
        sendSmileAuditToExperimenter(
          makeSmileAuditEvent(
            {
              eventId: `calibration-${callUserIdRef.current}-${Date.now()}`,
              sourceUserId: callUserIdRef.current,
              sourceParticipantId: currentForm.participantId,
              targetUserId: target?.userId ?? ''
            },
            'calibration-ready',
            `Neutral ${event.calibration.neutralMedian.toFixed(3)}; range ${event.calibration.smileRange.toFixed(3)}.`
          )
        )
        return
      }

      if (event.kind === 'calibration-failed') {
        addLog(`Smile synchrony calibration needs another try: ${event.reason}`, 'warn')
        sendSmileAuditToExperimenter(
          makeSmileAuditEvent(
            {
              eventId: `calibration-${callUserIdRef.current}-${Date.now()}`,
              sourceUserId: callUserIdRef.current,
              sourceParticipantId: currentForm.participantId,
              targetUserId: target?.userId ?? ''
            },
            'calibration-failed',
            event.reason
          )
        )
        return
      }

      if (event.kind === 'face-lost') {
        returnAutomaticSmileToNeutral('Local target face left the valid tracking area.')
        const eventId = activeLocalSmileEventIdRef.current
        if (eventId && target) {
          const cancelAfterOnset = async (): Promise<void> => {
            await pendingLocalSmileOnsetSignalsRef.current.get(eventId)?.catch(() => undefined)
            if (!inCallRef.current || !sentLocalSmileEventIdsRef.current.has(eventId)) return
            await postSignal(
              'smile-onset-cancel',
              { eventId, sourceUserId: callUserIdRef.current, reason: 'Source face left the valid tracking area.' },
              target.userId
            ).catch(() => undefined)
            sentLocalSmileEventIdsRef.current.delete(eventId)
          }
          void cancelAfterOnset()
        }
        activeLocalSmileEventIdRef.current = ''
        return
      }

      if (event.kind === 'smile-offset') {
        const eventId = activeLocalSmileEventIdRef.current
        activeLocalSmileEventIdRef.current = ''
        const offsetCue: SmileOffsetCue = {
          eventId: eventId || `orphan-offset-${callUserIdRef.current}-${Date.now()}`,
          cue: 'smile-offset',
          sourceUserId: callUserIdRef.current,
          sourceParticipantId: currentForm.participantId,
          targetUserId: target?.userId ?? '',
          observedAtIso: new Date().toISOString(),
          observedAtEpochMs: Date.now(),
          observedAtMonotonicMs: event.timestampMs,
          rawSmile: event.rawSmile,
          normalizedSmile: event.normalizedSmile,
          smoothedNormalizedSmile: event.smoothedNormalizedSmile,
          mouthSmileLeft: event.mouthSmileLeft,
          mouthSmileRight: event.mouthSmileRight,
          jawOpen: event.jawOpen
        }
        sendSmileAuditToExperimenter(
          makeSmileAuditEvent(
            offsetCue,
            eventId ? 'detected' : 'rejected',
            eventId
              ? 'Participant clean feed detected a sustained smile offset.'
              : 'Smile offset had no matching local onset event.'
          )
        )

        if (!eventId || mode !== 'live') return
        const sendOffsetAfterOnset = async (): Promise<void> => {
          await pendingLocalSmileOnsetSignalsRef.current.get(eventId)?.catch(() => undefined)
          if (
            !inCallRef.current ||
            controlsRef.current.automaticSmileOnsetMode !== 'live' ||
            !target ||
            currentForm.sessionFormat !== 'dyad' ||
            !sentLocalSmileEventIdsRef.current.has(eventId)
          ) {
            sentLocalSmileEventIdsRef.current.delete(eventId)
            sendSmileAuditToExperimenter(
              makeSmileAuditEvent(offsetCue, 'rejected', 'Live smile offset has no matched onset sent to one dyad partner.')
            )
            return
          }
          sentLocalSmileEventIdsRef.current.delete(eventId)
          try {
            await postSignal('smile-offset-cue', offsetCue, target.userId)
            sendSmileAuditToExperimenter(
              makeSmileAuditEvent(offsetCue, 'sent', 'Matched offset sent directly to the partner station.')
            )
          } catch (error) {
            sendSmileAuditToExperimenter(
              makeSmileAuditEvent(
                offsetCue,
                'rejected',
                error instanceof Error ? error.message : 'Offset could not be sent to the partner.'
              )
            )
          }
        }
        void sendOffsetAfterOnset()
        return
      }

      if (event.kind !== 'smile-onset') return
      const eventId = `smile-${callUserIdRef.current}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const cue: SmileOnsetCue = {
        eventId,
        cue: 'smile-onset',
        sourceUserId: callUserIdRef.current,
        sourceParticipantId: currentForm.participantId,
        targetUserId: target?.userId ?? '',
        observedAtIso: new Date().toISOString(),
        observedAtEpochMs: Date.now(),
        observedAtMonotonicMs: event.timestampMs,
        rawSmile: event.rawSmile,
        normalizedSmile: event.normalizedSmile,
        mouthSmileLeft: event.mouthSmileLeft,
        mouthSmileRight: event.mouthSmileRight,
        jawOpen: event.jawOpen
      }
      activeLocalSmileEventIdRef.current = eventId
      sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, 'detected', 'Participant clean feed detected smile onset.'))

      if (mode !== 'live') return
      if (!target || currentForm.sessionFormat !== 'dyad') {
        sendSmileAuditToExperimenter(
          makeSmileAuditEvent(cue, 'rejected', 'Live smile onset requires exactly one dyad partner.')
        )
        return
      }
      const detectorGeneration = smileDetectorGenerationRef.current
      const onsetSignal = postSignal('smile-onset-cue', cue, target.userId)
        .then(() => {
          if (
            inCallRef.current &&
            controlsRef.current.automaticSmileOnsetMode === 'live' &&
            smileDetectorGenerationRef.current === detectorGeneration
          ) {
            sentLocalSmileEventIdsRef.current.add(eventId)
          }
          sendSmileAuditToExperimenter(makeSmileAuditEvent(cue, 'sent', 'Cue sent directly to the partner station.'))
        })
        .catch((error) => {
          sentLocalSmileEventIdsRef.current.delete(eventId)
          sendSmileAuditToExperimenter(
            makeSmileAuditEvent(
              cue,
              'rejected',
              error instanceof Error ? error.message : 'Cue could not be sent to the partner.'
            )
          )
        })
      pendingLocalSmileOnsetSignalsRef.current.set(eventId, onsetSignal)
      void onsetSignal.finally(() => {
        if (pendingLocalSmileOnsetSignalsRef.current.get(eventId) === onsetSignal) {
          pendingLocalSmileOnsetSignalsRef.current.delete(eventId)
        }
      })
    },
    [addLog, postSignal, returnAutomaticSmileToNeutral, sendSmileAuditToExperimenter]
  )

  const stopSmileDetector = useCallback((): void => {
    smileDetectorGenerationRef.current += 1
    if (smileDetectorTimerRef.current !== null) {
      window.clearInterval(smileDetectorTimerRef.current)
      smileDetectorTimerRef.current = null
    }
    const video = smileDetectorVideoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
    }
    smileDetectorVideoRef.current = null
    smileDetectorStreamRef.current = null
    smileDetectorBusyRef.current = false
    smileDetectorRef.current?.reset()
    smileDetectorRef.current = null
    setSmileDetectorSnapshot(null)
    activeLocalSmileEventIdRef.current = ''
    sentLocalSmileEventIdsRef.current.clear()
    pendingLocalSmileOnsetSignalsRef.current.clear()
    automaticSmileReturnLockUntilRef.current = 0
  }, [])

  const startSmileDetector = useCallback(async (): Promise<void> => {
    const stream = cleanStreamRef.current
    if (
      isController ||
      !inCallRef.current ||
      controlsRef.current.automaticSmileOnsetMode === 'off' ||
      formRef.current.sessionFormat !== 'dyad' ||
      !stream ||
      stream.getVideoTracks().length === 0
    ) {
      return
    }
    if (smileDetectorRef.current && smileDetectorStreamRef.current === stream) return

    stopSmileDetector()
    const generation = smileDetectorGenerationRef.current
    const detector = new SmileOnsetDetector()
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    smileDetectorRef.current = detector
    smileDetectorVideoRef.current = video
    smileDetectorStreamRef.current = stream
    detector.startCalibration(performance.now())
    setSmileDetectorSnapshot(detector.snapshot(performance.now()))

    try {
      await video.play()
      const landmarker = await getSmileFaceLandmarker()
      if (
        generation !== smileDetectorGenerationRef.current ||
        !inCallRef.current ||
        String(controlsRef.current.automaticSmileOnsetMode) === 'off'
      ) {
        return
      }

      let lastSnapshotAt = 0
      smileDetectorTimerRef.current = window.setInterval(() => {
        if (smileDetectorBusyRef.current || !smileDetectorRef.current || !smileDetectorVideoRef.current) return
        smileDetectorBusyRef.current = true
        try {
          const timestampMs = performance.now()
          const sample = sampleSmileFrame(landmarker, smileDetectorVideoRef.current, timestampMs)
          const events = smileDetectorRef.current.ingest(sample)
          for (const event of events) handleLocalSmileDetectorEvent(event)
          if (timestampMs - lastSnapshotAt >= 250) {
            lastSnapshotAt = timestampMs
            setSmileDetectorSnapshot(smileDetectorRef.current.snapshot(timestampMs))
          }
        } catch (error) {
          addLog(error instanceof Error ? `Smile detector error: ${error.message}` : 'Smile detector error.', 'error')
          stopSmileDetector()
        } finally {
          smileDetectorBusyRef.current = false
        }
      }, SMILE_DETECTOR_INTERVAL_MS)
    } catch (error) {
      addLog(
        error instanceof Error ? `Could not start local smile detection: ${error.message}` : 'Could not start local smile detection.',
        'error'
      )
      stopSmileDetector()
    }
  }, [addLog, handleLocalSmileDetectorEvent, isController, stopSmileDetector])

  useEffect(() => {
    const mode = controls.automaticSmileOnsetMode
    // A signaling (SSE) blip flips callState to 'error' even though the DuckSoup media pipeline is
    // separate and still live — don't tear the manipulation down to neutral in that case. Only stop
    // on 'error' when the media path itself is actually down.
    const callDown = callState === 'idle' || (callState === 'error' && !duckSoupActiveRef.current)
    if (isController || mode === 'off' || callDown) {
      stopSmileDetector()
      if (!isController) returnAutomaticSmileToNeutral('Automatic smile synchrony was disabled.', false)
      return
    }
    if (mode !== 'live') {
      returnAutomaticSmileToNeutral('Automatic smile synchrony changed to detection-only mode.', false)
      sentLocalSmileEventIdsRef.current.clear()
      pendingLocalSmileOnsetSignalsRef.current.clear()
    }
    void startSmileDetector()
  }, [
    callState,
    cleanStreamVersion,
    controls.automaticSmileOnsetMode,
    isController,
    returnAutomaticSmileToNeutral,
    startSmileDetector,
    stopSmileDetector
  ])

  const retrySmileCalibration = (): void => {
    const detector = smileDetectorRef.current
    if (!detector) {
      void startSmileDetector()
      return
    }
    const now = performance.now()
    detector.startCalibration(now)
    setSmileDetectorSnapshot(detector.snapshot(now))
  }

  const syncRemoteTiles = (): void => {
    setRemoteTiles([...remoteStreamsRef.current.values()])
  }

  const flushPendingIceCandidates = async (userId: string, peer: RTCPeerConnection): Promise<void> => {
    const pending = pendingIceCandidatesRef.current.get(userId)
    if (!pending || pending.length === 0) return

    pendingIceCandidatesRef.current.delete(userId)
    for (const candidate of pending) {
      await peer.addIceCandidate(candidate)
    }
  }

  const getOrCreateCallPeer = (targetUserId: string, peerMeta?: Partial<CallPeer>): RTCPeerConnection => {
    const existing = peerConnectionsRef.current.get(targetUserId)
    if (existing) return existing

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
    peerConnectionsRef.current.set(targetUserId, peer)

    const remoteStream = new MediaStream()
    const remoteRole = peerMeta?.role || 'participant'
    const shouldShowRemoteTile = remoteRole !== 'controller'
    if (shouldShowRemoteTile) {
      remoteStreamsRef.current.set(targetUserId, {
        userId: targetUserId,
        displayName: peerMeta?.displayName || targetUserId,
        role: remoteRole,
        stream: remoteStream
      })
      syncRemoteTiles()
    }

    const localStream = callLocalStreamRef.current
    if (localStream && localStream.getTracks().length > 0) {
      localStream.getTracks().forEach((track) => {
        peer.addTrack(track, localStream)
      })
    } else {
      peer.addTransceiver('video', { direction: 'recvonly' })
      peer.addTransceiver('audio', { direction: 'recvonly' })
    }

    peer.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        if (!remoteStream.getTrackById(track.id)) remoteStream.addTrack(track)
      })
      const current = remoteStreamsRef.current.get(targetUserId)
      if (current) {
        remoteStreamsRef.current.set(targetUserId, { ...current, stream: remoteStream })
        syncRemoteTiles()
      }
      setCallState('connected')
      addLog(`Receiving live media from ${peerMeta?.displayName || targetUserId}.`, 'success')
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        postSignal('candidate', event.candidate.toJSON(), targetUserId).catch((error) =>
          addLog(error instanceof Error ? error.message : 'Could not send ICE candidate.', 'error')
        )
      }
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') setCallState('connected')
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
        addLog(
          `Connection with ${peerMeta?.displayName || targetUserId} is ${peer.connectionState}.`,
          peer.connectionState === 'failed' ? 'error' : 'warn'
        )
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          remoteStreamsRef.current.delete(targetUserId)
          syncRemoteTiles()
          setCallState('waiting')
        }
      }
    }

    return peer
  }

  const makeCallOffer = async (targetPeer: CallPeer): Promise<void> => {
    if (peerConnectionsRef.current.has(targetPeer.userId)) return
    const peer = getOrCreateCallPeer(targetPeer.userId, targetPeer)
    setCallState('connecting')
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await postSignal('offer', offer, targetPeer.userId)
    addLog(`Sent call offer to ${targetPeer.displayName}.`, 'info')
  }

  const maybeOfferToPeer = (peer: CallPeer): void => {
    if (useDuckSoup) return // media flows through the DuckSoup SFU, not the legacy mesh
    if (peer.userId === callUserIdRef.current) return
    if (isController) {
      if (peer.role !== 'participant') return
      makeCallOffer(peer).catch((error) =>
        addLog(error instanceof Error ? error.message : 'Could not start live call offer.', 'error')
      )
      return
    }
    if (peer.role === 'controller') return
    if (peerConnectionsRef.current.has(peer.userId)) return
    if (callUserIdRef.current.localeCompare(peer.userId) < 0) {
      makeCallOffer(peer).catch((error) =>
        addLog(error instanceof Error ? error.message : 'Could not start live call offer.', 'error')
      )
    }
  }

  const addChatMessage = (message: ChatMessage): void => {
    setChatMessages((prev) => {
      if (prev.some((item) => item.id === message.id)) return prev
      return [...prev, message].slice(-200)
    })
  }

  // --- Experimenter 4-view monitor (separate WebRTC channel, DuckSoup mode) ----------------
  const monitorIceServers = [{ urls: 'stun:stun.l.google.com:19302' }]

  const syncMonitorTiles = (): void => setMonitorTiles([...monitorReceivedRef.current.values()])

  const closeMonitorConnection = (userId: string): void => {
    const pc = monitorConnectionsRef.current.get(userId)
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      try {
        pc.close()
      } catch {
        // already closed
      }
      monitorConnectionsRef.current.delete(userId)
    }
    monitorPendingIceRef.current.delete(userId)
  }

  const teardownMonitor = (): void => {
    for (const userId of [...monitorConnectionsRef.current.keys()]) closeMonitorConnection(userId)
    monitorStreamMetaRef.current.clear()
    monitorPendingIceRef.current.clear()
    publishedMonitorSigRef.current = ''
    if (monitorReceivedRef.current.size > 0) {
      monitorReceivedRef.current.clear()
      syncMonitorTiles()
    }
  }

  // Participant side: forward own clean camera + the partner's altered stream to the controller.
  const publishMonitorStreams = async (): Promise<void> => {
    if (!useDuckSoup || isController || !inCallRef.current) return
    const controller = callPeersRef.current.find((peer) => peer.role === 'controller')
    if (!controller) {
      teardownMonitor()
      return
    }

    const publish: Array<{ stream: MediaStream } & MonitorStreamDescriptor> = []
    const clean = cleanStreamRef.current
    if (clean && clean.getTracks().length > 0) {
      publish.push({ stream: clean, streamId: clean.id, kind: 'clean', userId: callUserIdRef.current, displayName: callDisplayName() })
    }
    for (const tile of remoteStreamsRef.current.values()) {
      if (tile.role !== 'participant' || tile.userId === callUserIdRef.current) continue
      if (tile.stream.getTracks().length === 0) continue
      publish.push({ stream: tile.stream, streamId: tile.stream.id, kind: 'altered', userId: tile.userId, displayName: tile.displayName })
    }
    if (publish.length === 0) return

    const signature =
      controller.userId +
      '|' +
      publish.map((item) => `${item.kind}:${item.userId}:${item.stream.id}:${item.stream.getTracks().map((track) => track.id).join(',')}`).join('|')
    if (signature === publishedMonitorSigRef.current && monitorConnectionsRef.current.has(controller.userId)) return
    publishedMonitorSigRef.current = signature

    closeMonitorConnection(controller.userId)
    const pc = new RTCPeerConnection({ iceServers: monitorIceServers })
    monitorConnectionsRef.current.set(controller.userId, pc)
    pc.onicecandidate = (event) => {
      if (event.candidate) postSignal('monitor-candidate', event.candidate.toJSON(), controller.userId).catch(() => undefined)
    }
    for (const item of publish) {
      for (const track of item.stream.getTracks()) pc.addTrack(track, item.stream)
    }
    const streamMap: MonitorStreamDescriptor[] = publish.map(({ streamId, kind, userId, displayName }) => ({ streamId, kind, userId, displayName }))
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await postSignal('monitor-offer', { sdp: offer, streamMap }, controller.userId)
    addLog('Sharing this station view with the experimenter monitor.', 'info')
  }

  const handleMonitorSignal = async (payload: NonNullable<SignalEnvelope['payload']>): Promise<void> => {
    const from = payload.from
    const kind = payload.type
    if (!from || !kind) return
    if (payload.to && payload.to !== callUserIdRef.current) return

    if (kind === 'monitor-offer') {
      // Controller side: receive a participant's clean + partner-altered streams.
      const body = payload.payload as { sdp: RTCSessionDescriptionInit; streamMap: MonitorStreamDescriptor[] }
      for (const descriptor of body.streamMap ?? []) {
        monitorStreamMetaRef.current.set(descriptor.streamId, {
          kind: descriptor.kind,
          userId: descriptor.userId,
          displayName: descriptor.displayName
        })
      }
      closeMonitorConnection(from)
      const pc = new RTCPeerConnection({ iceServers: monitorIceServers })
      monitorConnectionsRef.current.set(from, pc)
      pc.ontrack = (event) => {
        const stream = event.streams[0]
        if (!stream) return
        const meta = monitorStreamMetaRef.current.get(stream.id)
        if (!meta) return
        const key = `${meta.userId}:${meta.kind}`
        monitorReceivedRef.current.set(key, { key, kind: meta.kind, userId: meta.userId, displayName: meta.displayName, stream })
        syncMonitorTiles()
      }
      pc.onicecandidate = (event) => {
        if (event.candidate) postSignal('monitor-candidate', event.candidate.toJSON(), from).catch(() => undefined)
      }
      await pc.setRemoteDescription(body.sdp)
      const pending = monitorPendingIceRef.current.get(from)
      if (pending) {
        for (const candidate of pending) await pc.addIceCandidate(candidate).catch(() => undefined)
        monitorPendingIceRef.current.delete(from)
      }
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await postSignal('monitor-answer', answer, from)
      return
    }

    if (kind === 'monitor-answer') {
      const pc = monitorConnectionsRef.current.get(from)
      if (!pc) return
      await pc.setRemoteDescription(payload.payload as RTCSessionDescriptionInit)
      const pending = monitorPendingIceRef.current.get(from)
      if (pending) {
        for (const candidate of pending) await pc.addIceCandidate(candidate).catch(() => undefined)
        monitorPendingIceRef.current.delete(from)
      }
      return
    }

    if (kind === 'monitor-candidate') {
      const candidate = payload.payload as RTCIceCandidateInit
      const pc = monitorConnectionsRef.current.get(from)
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(candidate).catch(() => undefined)
      } else {
        const pending = monitorPendingIceRef.current.get(from) ?? []
        pending.push(candidate)
        monitorPendingIceRef.current.set(from, pending)
      }
    }
  }

  const handleSignalEvent = async (event: MessageEvent<string>): Promise<void> => {
    if (!inCallRef.current) return
    const envelope = JSON.parse(event.data) as SignalEnvelope

    if (envelope.type === 'hello' || envelope.type === 'peer-list') {
      const peers = envelope.payload?.peers ?? []
      const mediaPeers = peers.filter((peer) => peer.userId !== callUserIdRef.current && peer.role === 'participant')
      setCallPeers(peers)
      if (mediaPeers.length > 0) setCallState('connecting')
      mediaPeers.forEach(maybeOfferToPeer)
      return
    }

    if (envelope.type === 'peer-joined' && envelope.payload?.peer) {
      const joinedPeer = envelope.payload.peer
      setCallPeers((prev) => {
        const next = prev.filter((peer) => peer.userId !== joinedPeer.userId)
        return [...next, joinedPeer]
      })
      addLog(`${joinedPeer.displayName} joined the room.`, 'success')
      maybeOfferToPeer(joinedPeer)
      // A participant may join after the experimenter selected Detect or Live. Send the
      // current automatic-session state directly so late joiners never silently stay Off.
      if (isController && joinedPeer.role === 'participant') {
        window.setTimeout(() => {
          sendDirectorPayload({
            kind: 'live-control',
            key: 'automaticSmileOnsetMode',
            value: controlsRef.current.automaticSmileOnsetMode,
            targetUserId: joinedPeer.userId,
            label: 'Current automatic smile synchrony mode'
          })
          sendDirectorPayload({
            kind: 'live-control',
            key: 'smileAlpha',
            value: 0,
            targetUserId: joinedPeer.userId,
            label: 'Automatic smile synchrony neutral baseline'
          })
        }, 250)
      }
      return
    }

    if (envelope.type === 'peer-left') {
      const userId = envelope.payload?.userId || envelope.payload?.from || envelope.payload?.peer?.userId
      if (userId) {
        if (activeSmileEnvelopeRef.current?.sourceUserId === userId) {
          returnAutomaticSmileToNeutral('Source participant left the room.')
        }
        peerConnectionsRef.current.get(userId)?.close()
        peerConnectionsRef.current.delete(userId)
        remoteStreamsRef.current.get(userId)?.stream.getTracks().forEach((track) => track.stop())
        remoteStreamsRef.current.delete(userId)
        syncRemoteTiles()
        // A leaver can feed tiles for more than one userId (its own clean + its partner's
        // altered), so clear the monitor and let the remaining participants re-publish.
        closeMonitorConnection(userId)
        teardownMonitor()
        setCallPeers((prev) => prev.filter((peer) => peer.userId !== userId))
      }
      addLog('Someone left the room.', 'warn')
      return
    }

    if (envelope.type === 'director-control') {
      if (envelope.payload?.from !== callUserIdRef.current) {
        applyRemoteLiveControl(envelope.payload?.payload, envelope.payload?.displayName || 'Experimenter')
      }
      return
    }

    if (envelope.type === 'chat-message') {
      if (envelope.payload?.id && envelope.payload.text && envelope.payload.from) {
        addChatMessage(envelope.payload as ChatMessage)
      }
      return
    }

    // Experimenter-monitor WebRTC runs on its own signal types, alongside the SFU.
    if (envelope.type === 'signal' && typeof envelope.payload?.type === 'string' && envelope.payload.type.startsWith('monitor-')) {
      await handleMonitorSignal(envelope.payload).catch((error) =>
        addLog(error instanceof Error ? error.message : 'Monitor connection error.', 'error')
      )
      return
    }

    if (
      envelope.type === 'signal' &&
      ['smile-onset-audit', 'smile-synchrony-audit'].includes(envelope.payload?.type ?? '')
    ) {
      if (isController && envelope.payload?.payload) {
        appendSmileOnsetAudit(envelope.payload.payload as SmileOnsetAuditEvent)
      }
      return
    }

    if (envelope.type === 'signal' && envelope.payload?.type === 'smile-onset-cue') {
      if (!isController && envelope.payload.payload && envelope.payload.from) {
        applyAutomaticSmileCue(envelope.payload.payload as SmileOnsetCue, envelope.payload.from)
      }
      return
    }

    if (envelope.type === 'signal' && envelope.payload?.type === 'smile-offset-cue') {
      if (!isController && envelope.payload.payload && envelope.payload.from) {
        applyAutomaticSmileOffset(envelope.payload.payload as SmileOffsetCue, envelope.payload.from)
      }
      return
    }

    if (envelope.type === 'signal' && envelope.payload?.type === 'smile-onset-cancel') {
      if (!isController && envelope.payload.payload && typeof envelope.payload.payload === 'object') {
        const cancellation = envelope.payload.payload as {
          eventId?: string
          sourceUserId?: string
          reason?: string
        }
        const active = activeSmileEnvelopeRef.current
        if (
          active &&
          cancellation.eventId === active.eventId &&
          cancellation.sourceUserId === active.sourceUserId &&
          envelope.payload.from === active.sourceUserId
        ) {
          returnAutomaticSmileToNeutral(cancellation.reason || 'Source tracking was lost.')
        }
      }
      return
    }

    if (useDuckSoup && envelope.type === 'signal') return // SFU handles WebRTC negotiation
    if (envelope.type !== 'signal' || !envelope.payload?.type || !envelope.payload.from) return
    if (envelope.payload.to && envelope.payload.to !== callUserIdRef.current) return

    const from = envelope.payload.from
    const peerMeta =
      callPeers.find((item) => item.userId === from) ??
      ({
        userId: from,
        displayName: envelope.payload.displayName || from,
        role: envelope.payload.role ?? 'participant',
        joinedAt: Date.now()
      } as CallPeer)
    const peer = getOrCreateCallPeer(from, peerMeta)

    if (envelope.payload.type === 'offer') {
      setCallState('connecting')
      await peer.setRemoteDescription(envelope.payload.payload as RTCSessionDescriptionInit)
      await flushPendingIceCandidates(from, peer)
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      await postSignal('answer', answer, from)
      addLog(`Answered call offer from ${peerMeta?.displayName || from}.`, 'success')
    } else if (envelope.payload.type === 'answer') {
      await peer.setRemoteDescription(envelope.payload.payload as RTCSessionDescriptionInit)
      await flushPendingIceCandidates(from, peer)
      addLog(`Call answer received from ${peerMeta?.displayName || from}.`, 'success')
    } else if (envelope.payload.type === 'candidate') {
      const candidate = envelope.payload.payload as RTCIceCandidateInit
      if (peer.remoteDescription) {
        await peer.addIceCandidate(candidate)
      } else {
        const pending = pendingIceCandidatesRef.current.get(from) ?? []
        pending.push(candidate)
        pendingIceCandidatesRef.current.set(from, pending)
      }
    }
  }

  const cleanupLiveMediaProcessor = (): void => {
    const processor = liveMediaProcessorRef.current
    if (!processor) return

    window.cancelAnimationFrame(processor.animationId)
    processor.processedStream.getTracks().forEach((track) => track.stop())
    processor.rawStream.getTracks().forEach((track) => track.stop())
    processor.rawVideo.pause()
    processor.rawVideo.srcObject = null
    processor.audioContext?.close().catch(() => undefined)
    liveMediaProcessorRef.current = null
  }

  const createLiveMediaProcessor = async (rawStream: MediaStream): Promise<LiveMediaProcessor> => {
    const rawVideo = document.createElement('video')
    rawVideo.muted = true
    rawVideo.playsInline = true
    rawVideo.srcObject = rawStream
    await rawVideo.play().catch(() => undefined)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create live video processor.')

    const processedStream = new MediaStream()
    const canvasStream = canvas.captureStream(30)
    canvasStream.getVideoTracks().forEach((track) => processedStream.addTrack(track))

    const processor: LiveMediaProcessor = {
      rawStream,
      processedStream,
      rawVideo,
      canvas,
      ctx,
      animationId: 0,
      currentSmileAlpha: 0
    }

    const audioTracks = rawStream.getAudioTracks()
    if (audioTracks.length > 0) {
      const AudioContextConstructor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextConstructor) throw new Error('This browser cannot create a live audio processor.')
      const audioContext = new AudioContextConstructor()
      const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks))
      const delay = audioContext.createDelay(1.5)
      const lowShelf = audioContext.createBiquadFilter()
      const highShelf = audioContext.createBiquadFilter()
      const gain = audioContext.createGain()
      const destination = audioContext.createMediaStreamDestination()

      lowShelf.type = 'lowshelf'
      lowShelf.frequency.value = 320
      highShelf.type = 'highshelf'
      highShelf.frequency.value = 2600

      source.connect(delay)
      delay.connect(lowShelf)
      lowShelf.connect(highShelf)
      highShelf.connect(gain)
      gain.connect(destination)
      destination.stream.getAudioTracks().forEach((track) => processedStream.addTrack(track))

      processor.audioContext = audioContext
      processor.audioDelay = delay
      processor.audioGain = gain
      processor.audioLowShelf = lowShelf
      processor.audioHighShelf = highShelf
      applyAudioControlsToProcessor(processor, controlsRef.current)
    }

    const draw = (): void => {
      const width = rawVideo.videoWidth || 1280
      const height = rawVideo.videoHeight || 720
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      if (rawVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.drawImage(rawVideo, 0, 0, width, height)
        applySmileWarp(processor, width, height, controlsRef.current)
      }
      processor.animationId = window.requestAnimationFrame(draw)
    }

    draw()
    liveMediaProcessorRef.current = processor
    return processor
  }

  const duckSoupNamespace = (): string => slugify(form.studyId, 'default')

  // Write the session audit trail (manifest + ms-stamped control CSV) and best-effort copy
  // the server-recorded clean (-dry) + altered (-wet) webm/mp4 files into the output folder.
  const finalizeDuckSoupSession = useCallback(async (): Promise<void> => {
    // The experimenter is the authoritative saver: it holds the full event log + all chat and runs
    // on the media-server machine, so it can also collect both participants' videos. Runs once.
    if (!isController || sessionSavedRef.current) return
    sessionSavedRef.current = true
    setRecordingState('saving')
    try {
      const { sessionDir: createdDir } = await window.researchApi.createSessionDirectory(form)
      setSessionDir(createdDir)
      const namespace = duckSoupNamespace()
      const interaction = form.roomId
      let copied: string[] = []
      let copiedPaths: string[] = []
      let serverDataDir: string | null = null
      try {
        // DuckSoup finishes muxing each .mp4 a moment after the interaction ends, so retry a few times.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const result = await window.researchApi.collectDuckSoupRecordings({ destDir: createdDir, namespace, interaction })
          copied = result.copied
          copiedPaths = result.copiedPaths
          serverDataDir = result.dataDir
          if (copied.length > 0 || attempt === 3) break
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        if (copied.length > 0) addLog(`Copied ${copied.length} recording file(s) into the session folder.`, 'success')
        else addLog(`No recordings found yet under data/${namespace}/${interaction}/recordings (still writing, or the media server is on another computer).`, 'info')
      } catch {
        addLog('Could not auto-copy server recordings. They remain in the media server data folder.', 'warn')
      }

      const serverFiles = Object.values(duckSoupFilesRef.current).flat()
      const availableVideoFiles = [...copiedPaths, ...serverFiles]
      const ppsPlaybackPlan = buildPpsPlaybackPlan(
        availableVideoFiles,
        participantPeers,
        form.participantId,
        form.partnerId
      )

      const manifest = {
        savedAt: new Date().toISOString(),
        transport: 'ducksoup',
        session: form,
        controlsAtEnd: controlsRef.current,
        mediaServer: form.duckSoupUrl,
        recording: {
          startedAt: recordingStartRef.current ? new Date(recordingStartRef.current).toISOString() : null,
          endedAt: new Date().toISOString(),
          durationMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : null,
          note:
            'startedAt is video t=0 for the -dry/-wet recordings (the experimenter re-anchors it to when both participants are present). In manipulation_events.csv, elapsedMs is milliseconds from startedAt (negative = logged before recording began), so it lines up with the videos. For cross-machine alignment use the UTC timestamp column and keep the lab clocks NTP-synced.'
        },
        duckSoup: {
          namespace,
          interaction,
          recordingMode: 'reenc',
          serverFiles: duckSoupFilesRef.current,
          serverDataDir,
          copiedFiles: copied,
          copiedPaths
        },
        ppsPlaybackPlan,
        experimenterNotes: experimenterNotesRef.current,
        chatLog: { file: 'chat_log.csv', messageCount: chatMessagesRef.current.length },
        mediaQuality: {
          file: 'media_quality.csv',
          sampleCount: mediaQualitySamplesRef.current.length,
          sampleInterval: 'approximately 1 second'
        },
        smileSynchrony: {
          file: 'smile_synchrony_events.csv',
          legacyOnsetFile: 'smile_onset_events.csv',
          eventCount: smileOnsetAuditEventsRef.current.length,
          detectionSource: 'participant clean local camera',
          experimenterEvaluatesCues: false,
          alignedResponse: {
            alpha: SMILE_RESPONSE_ALPHA,
            rampMs: SMILE_RESPONSE_RAMP_MS,
            minimumPeakHoldMs: SMILE_OFFSET_MIN_PEAK_HOLD_MS,
            participantDrivenOffset: true,
            offsetReleaseThreshold: 0.2,
            offsetDwellMs: 300,
            returnMs: SMILE_OFFSET_RETURN_MS,
            watchdogMs: SMILE_RESPONSE_WATCHDOG_MS
          }
        },
        notes: [
          'Media + face/voice manipulation routed through DuckSoup (SFU) + Mozza (face-only smile warp).',
          'Server records clean (-dry) and altered (-wet) streams per participant under data/<namespace>/<interaction>/recordings/.',
          'For empathic accuracy ratings, use the participant-specific ppsPlaybackPlan: selfVideo is clean/dry; partnerVideo is altered/wet.',
          'manipulation_events.csv lists experimenter control changes, cue responses, and synchrony mode changes; its elapsedMs column is milliseconds from recording.startedAt (video t=0), so it aligns directly with the -dry/-wet videos.',
          'chat_log.csv lists every chat message with its audience (everyone / role / direct), including private experimenter messages.',
          'media_quality.csv separates transport jitter, packet loss, frame drops, and jitter-buffer delay from visible Mozza landmark jitter.',
          'smile_synchrony_events.csv records participant-driven clean-feed onset/offset detections and matched partner-response timing. The experimenter does not evaluate individual cues.',
          'smile_onset_events.csv is retained as a compatibility copy for earlier analysis scripts.'
        ]
      }
      await Promise.all([
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'session_manifest.json',
          contents: JSON.stringify(manifest, null, 2)
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'pps_playback_manifest.json',
          contents: JSON.stringify(
            {
              savedAt: manifest.savedAt,
              studyId: form.studyId,
              roomId: form.roomId,
              dyadId: form.dyadId,
              instructions:
                'For empathic accuracy ratings, show each participant their unmanipulated self video alongside the manipulated partner video they saw during the conversation.',
              playbackPlan: ppsPlaybackPlan
            },
            null,
            2
          )
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'manipulation_events.csv',
          contents: controlEventsToCsv(controlEventsRef.current, recordingStartRef.current)
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'chat_log.csv',
          contents: chatMessagesToCsv(chatMessagesRef.current, callPeersRef.current)
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'media_quality.csv',
          contents: mediaQualitySamplesToCsv(mediaQualitySamplesRef.current)
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'smile_synchrony_events.csv',
          contents: smileSynchronyEventsToCsv(smileOnsetAuditEventsRef.current)
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'smile_onset_events.csv',
          contents: smileSynchronyEventsToCsv(smileOnsetAuditEventsRef.current)
        }),
        window.researchApi.writeTextFile({
          sessionDir: createdDir,
          filename: 'experimenter_notes.txt',
          contents: experimenterNotesRef.current
        })
      ])
      addLog(`Saved session files (manifests, logs, chat, notes) to ${createdDir}`, 'success')
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Could not finalize the session files.', 'error')
    } finally {
      setRecordingState('idle')
    }
  }, [addLog, form, participantPeers, isController])

  const handleDuckSoupEvent = useCallback(
    (message: DuckSoupCallbackMessage): void => {
      // Drop any DuckSoup callbacks that land after the user left — otherwise teardown events
      // ('end' -> 'waiting', a trailing 'track') would re-enter the call UI and look like a rejoin.
      if (!inCallRef.current) return
      const { kind, payload } = message
      switch (kind) {
        case 'joined':
          setCallState('connecting')
          addLog('Connected to the media server. Waiting for the interaction to start.', 'info')
          break
        case 'local-stream': {
          const stream = payload as MediaStream
          cleanStreamRef.current = stream
          setCleanStreamVersion((version) => version + 1)
          callLocalStreamRef.current = stream
          if (callLocalVideoRef.current) {
            callLocalVideoRef.current.srcObject = stream
            void callLocalVideoRef.current.play().catch(() => undefined)
          }
          addLog('Camera and mic started. Your self-view is unedited; partners see the manipulated stream.', 'success')
          break
        }
        case 'other_joined': {
          const info = (payload ?? {}) as { userId?: string; streamId?: string }
          if (info.userId && info.streamId) streamUserMapRef.current.set(info.streamId, info.userId)
          if (info.userId && !remoteStreamsRef.current.has(info.userId)) {
            const meta = callPeersRef.current.find((peer) => peer.userId === info.userId)
            remoteStreamsRef.current.set(info.userId, {
              userId: info.userId,
              displayName: meta?.displayName || info.userId,
              role: meta?.role || 'participant',
              stream: new MediaStream()
            })
            syncRemoteTiles()
          }
          addLog('Another participant connected to the media server.', 'success')
          break
        }
        case 'track': {
          const event = payload as RTCTrackEvent
          const stream = event.streams[0]
          const mappedUserId = stream ? streamUserMapRef.current.get(stream.id) : undefined
          const userId = mappedUserId || `peer-${stream?.id ?? makeId()}`
          let tile = remoteStreamsRef.current.get(userId)
          if (!tile) {
            const meta = callPeersRef.current.find((peer) => peer.userId === userId)
            tile = {
              userId,
              displayName: meta?.displayName || userId,
              role: meta?.role || 'participant',
              stream: new MediaStream()
            }
            remoteStreamsRef.current.set(userId, tile)
          }
          if (!tile.stream.getTrackById(event.track.id)) tile.stream.addTrack(event.track)
          syncRemoteTiles()
          setCallState('connected')
          break
        }
        case 'stats': {
          const stats = (payload ?? {}) as DuckSoupStatsPayload
          const inboundVideo = stats.inboundRTPVideo
          const inboundAudio = stats.inboundRTPAudio
          mediaQualitySamplesRef.current.push({
            timestamp: new Date().toISOString(),
            elapsedMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : 0,
            videoUpKbps: stats.videoUp ?? '',
            videoDownKbps: stats.videoDown ?? '',
            audioUpKbps: stats.audioUp ?? '',
            audioDownKbps: stats.audioDown ?? '',
            videoJitterMs: secondsToMs(inboundVideo?.jitter),
            audioJitterMs: secondsToMs(inboundAudio?.jitter),
            videoRttMs: secondsToMs(stats.remoteInboundRTPVideo?.roundTripTime),
            audioRttMs: secondsToMs(stats.remoteInboundRTPAudio?.roundTripTime),
            videoPacketsLost: inboundVideo?.packetsLost ?? 0,
            audioPacketsLost: inboundAudio?.packetsLost ?? 0,
            framesDropped: inboundVideo?.framesDropped ?? 0,
            videoJitterBufferMs: meanJitterBufferMs(inboundVideo)
          })
          break
        }
        case 'start':
          setCallState('connected')
          recordingStartRef.current = Date.now()
          setRecordingSeconds(0)
          setRecordingState('recording')
          appendControlEvent('recording', 'start', 'DuckSoup server-side recording (clean -dry + altered -wet).')
          addLog('Live interaction started. Server-side recording is running.', 'success')
          if (duckSoupPlayerRef.current && !isController) {
            const face = {
              smileAlpha: controlsRef.current.smileAlpha,
              faceThreshold: controlsRef.current.faceThreshold,
              landmarkBeta: controlsRef.current.landmarkBeta,
              smoothingCutoff: controlsRef.current.smoothingCutoff
            }
            applyMozzaControls(duckSoupPlayerRef.current, face)
            appliedMozzaControlsRef.current = { face, audioPitch: controlsRef.current.audioPitch }
          }
          break
        case 'ending':
          interactionEndedRef.current = true
          addLog('The session will end soon (media server duration limit).', 'warn')
          break
        case 'files':
          duckSoupFilesRef.current = (payload ?? {}) as Record<string, string[]>
          addLog('Server finished writing recordings.', 'success')
          break
        case 'end':
          // Participant side only (the experimenter has no media player). Saving is done by the
          // experimenter on Conclude/Leave, so participants no longer write session files here.
          interactionEndedRef.current = true
          addLog('The media interaction ended.', 'info')
          setCallState('waiting')
          break
        case 'closed':
          if (interactionEndedRef.current) {
            // Expected: the socket closes after a normal 'end'/'ending'. Nothing to recover.
            addLog('Media server connection closed.', 'info')
          } else {
            // Unexpected mid-call drop (SFU restart, Wi-Fi flap): the video freezes but nothing
            // else signalled it. Surface a recoverable error and release the dead player so a
            // Rejoin starts a clean interaction instead of leaving the UI stuck on "connected".
            addLog('Media server connection lost. Rejoin to reconnect the video.', 'error')
            if (duckSoupPlayerRef.current) {
              try {
                duckSoupPlayerRef.current.stop()
              } catch {
                // already closed
              }
              duckSoupPlayerRef.current = null
            }
            duckSoupActiveRef.current = false
            setCallState('error')
          }
          break
        default:
          if (typeof kind === 'string' && kind.startsWith('error')) {
            const detail =
              kind === 'error-aborted'
                ? 'Media interaction aborted: all participants must press Join within ~15 seconds of each other. Coordinate the join, then try again.'
                : kind === 'error-full'
                  ? 'The media interaction is already full for this session size.'
                  : kind === 'error-duplicate'
                    ? 'This station ID is already connected to the media server.'
                    : `Media server error (${kind}).`
            addLog(detail, 'error')
            // Release the aborted/failed player so the next attempt starts clean instead of
            // colliding (a lingering player triggers error-duplicate on the same station id).
            if (duckSoupPlayerRef.current) {
              try {
                duckSoupPlayerRef.current.stop()
              } catch {
                // already stopped
              }
              duckSoupPlayerRef.current = null
            }
            duckSoupActiveRef.current = false
            setCallState('error')
          }
      }
    },
    [addLog, appendControlEvent, isController]
  )

  const startDuckSoupMedia = useCallback(async (): Promise<void> => {
    const baseUrl = form.duckSoupUrl.trim()
    streamUserMapRef.current.clear()
    duckSoupFilesRef.current = {}
    mediaQualitySamplesRef.current = []
    pendingMozzaControlsRef.current = null
    appliedMozzaControlsRef.current = null
    interactionEndedRef.current = false
    const controls = controlsRef.current
    const player = await renderDuckSoup(
      baseUrl,
      { stats: true, callback: handleDuckSoupEvent },
      {
        interactionName: form.roomId,
        userId: callUserIdRef.current,
        duration: DUCKSOUP_DURATION_SEC,
        size: expectedParticipants,
        namespace: duckSoupNamespace(),
        videoFormat: 'H264',
        gpu: false, // CPU x264. NVENC needs the server's nvcodec GStreamer elements present (NVIDIA
        // Container Toolkit in WSL2 + a GPU reservation in docker-compose.yml); without them gpu:true
        // builds a broken nvh264dec/nvh264enc pipeline -> white video. CPU is fast enough for dyads.
        recordingMode: 'reenc',
        width: DUCKSOUP_VIDEO_WIDTH,
        height: DUCKSOUP_VIDEO_HEIGHT,
        framerate: DUCKSOUP_VIDEO_FPS,
        video: {
          width: { ideal: DUCKSOUP_VIDEO_WIDTH },
          height: { ideal: DUCKSOUP_VIDEO_HEIGHT },
          frameRate: { ideal: DUCKSOUP_VIDEO_FPS, max: DUCKSOUP_VIDEO_FPS }
        },
        logLevel: 2,
        videoFx: buildMozzaVideoFx({
          smileAlpha: controls.smileAlpha,
          faceThreshold: controls.faceThreshold,
          landmarkBeta: controls.landmarkBeta,
          smoothingCutoff: controls.smoothingCutoff,
          overlay: controls.overlay
        }),
        audioFx: buildAudioFx(controls.audioPitch)
      }
    )
    duckSoupPlayerRef.current = player
    duckSoupActiveRef.current = true
    addLog('Media routed through DuckSoup/Mozza (face-only smile warp).', 'success')
  }, [addLog, expectedParticipants, form.duckSoupUrl, form.roomId, handleDuckSoupEvent])

  const joinLiveCall = async (): Promise<void> => {
    if (!form.callSignalUrl.trim() || !form.roomId.trim() || !callDisplayName().trim()) {
      addLog('Server URL, meeting ID, and display name are required before joining.', 'error')
      return
    }

    // The header Join/Rejoin button reaches here from the 'error' state without going through
    // Leave, and a prior attempt (aborted join, dropped media, signaling error) can leave a live
    // player / EventSource attached. Tear that down first so we don't leak a second camera capture
    // and a duplicate SSE channel (which the server rejects as error-duplicate).
    if (callEventsRef.current || duckSoupActiveRef.current || duckSoupPlayerRef.current) {
      leaveLiveCall()
    }

    inCallRef.current = true
    setCallState('starting')
    setInteractionCapReached(false)
    smileOnsetAuditEventsRef.current = []
    setSmileOnsetAuditEvents([])
    processedSmileCueIdsRef.current.clear()
    processedSmileOffsetIdsRef.current.clear()
    sentLocalSmileEventIdsRef.current.clear()
    pendingLocalSmileOnsetSignalsRef.current.clear()
    automaticSmileReturnLockUntilRef.current = 0
    try {
      const roomReachable = await checkRoomStatus(true)
      if (!roomReachable) {
        throw new Error('Room server is not reachable. Check the server URL before joining.')
      }

      if (!isController) {
        if (useDuckSoup) {
          // DuckSoup grabs the camera/mic itself and routes media through the SFU + Mozza.
          await startDuckSoupMedia()
        } else {
          const rawStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
            audio: true
          })
          const processor = await createLiveMediaProcessor(rawStream)
          cleanStreamRef.current = rawStream
          setCleanStreamVersion((version) => version + 1)
          alteredStreamRef.current = processor.processedStream
          callLocalStreamRef.current = processor.processedStream
          if (callLocalVideoRef.current) {
            callLocalVideoRef.current.srcObject = processor.processedStream
            await callLocalVideoRef.current.play().catch(() => undefined)
          }
          addLog('Camera and mic started. Experimenter settings now affect your outgoing stream.', 'success')
        }
      }

      if (!inCallRef.current) {
        // The user pressed Leave during the async join window — undo and stay out.
        if (duckSoupPlayerRef.current) {
          try {
            duckSoupPlayerRef.current.stop()
          } catch {
            // already stopped
          }
          duckSoupPlayerRef.current = null
        }
        duckSoupActiveRef.current = false
        cleanupLiveMediaProcessor()
        setCallState('idle')
        return
      }

      const params = new URLSearchParams({
        roomId: form.roomId,
        userId: callUserIdRef.current,
        role: form.role,
        displayName: callDisplayName(),
        participantId: form.participantId
      })
      const events = new EventSource(`${signalBaseUrl()}/events?${params.toString()}`)
      callEventsRef.current = events
      events.onopen = () => {
        if (eventSourceErrorAtRef.current > 0) addLog('Room connection restored.', 'success')
        eventSourceErrorAtRef.current = 0
        setCallState((prev) => (prev === 'starting' || prev === 'error' ? 'waiting' : prev))
      }
      events.onmessage = (message) => {
        handleSignalEvent(message).catch((error) =>
          addLog(error instanceof Error ? error.message : 'Could not handle room signal.', 'error')
        )
      }
      events.onerror = () => {
        const now = Date.now()
        if (events.readyState === EventSource.CLOSED) {
          setCallState('error')
          addLog('Room connection closed. Check the server URL and make sure the host app is still open.', 'error')
          return
        }

        setCallState('connecting')
        if (now - eventSourceErrorAtRef.current > 6000) {
          addLog('Room connection is retrying. Keep the host app open and stay on the same meeting ID.', 'warn')
          eventSourceErrorAtRef.current = now
        }
      }
      setCallState('waiting')
      // Experimenter is the saver: stamp a session start (so event-log timings are relative to it)
      // and re-arm the one-shot save guard for this session.
      if (isController) {
        recordingStartRef.current = Date.now()
        recordingReanchoredRef.current = false
        sessionSavedRef.current = false
        setRecordingState('recording')
      }
      addLog(`${callDisplayName()} joined ${form.roomId}.`, 'success')
    } catch (error) {
      setCallState('error')
      addLog(error instanceof Error ? error.message : 'Could not join the room.', 'error')
    }
  }

  const leaveLiveCall = (): void => {
    inCallRef.current = false
    stopSmileDetector()
    returnAutomaticSmileToNeutral('Station left the room.', false)
    clearSmileEnvelopeTimers()
    processedSmileCueIdsRef.current.clear()
    processedSmileOffsetIdsRef.current.clear()
    sentLocalSmileEventIdsRef.current.clear()
    pendingLocalSmileOnsetSignalsRef.current.clear()
    automaticSmileReturnLockUntilRef.current = 0
    activeLocalSmileEventIdRef.current = ''
    if (mozzaControlTimerRef.current !== null) {
      window.clearTimeout(mozzaControlTimerRef.current)
      mozzaControlTimerRef.current = null
    }
    pendingMozzaControlsRef.current = null
    appliedMozzaControlsRef.current = null
    if (duckSoupActiveRef.current) {
      if (duckSoupPlayerRef.current) {
        try {
          duckSoupPlayerRef.current.stop()
        } catch {
          // already stopped
        }
        duckSoupPlayerRef.current = null
      }
      duckSoupActiveRef.current = false
      streamUserMapRef.current.clear()
      window.setTimeout(() => {
        void finalizeDuckSoupSession()
      }, 1500)
    }

    if (form.callSignalUrl.trim() && form.roomId.trim()) {
      fetch(`${signalBaseUrl()}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          roomId: form.roomId,
          from: callUserIdRef.current,
          role: form.role,
          displayName: callDisplayName()
        })
      }).catch(() => undefined)
    }

    if (callEventsRef.current) {
      callEventsRef.current.onopen = null
      callEventsRef.current.onmessage = null
      callEventsRef.current.onerror = null
      callEventsRef.current.close()
    }
    for (const peer of peerConnectionsRef.current.values()) peer.close()
    for (const tile of remoteStreamsRef.current.values()) tile.stream.getTracks().forEach((track) => track.stop())
    teardownMonitor()
    cleanupLiveMediaProcessor()
    callEventsRef.current = null
    callLocalStreamRef.current = null
    cleanStreamRef.current = null
    alteredStreamRef.current = null
    peerConnectionsRef.current.clear()
    pendingIceCandidatesRef.current.clear()
    remoteStreamsRef.current.clear()
    if (callLocalVideoRef.current) callLocalVideoRef.current.srcObject = null
    setRemoteTiles([])
    setCallPeers([])
    setChatMessages([])
    setChatText('')
    setChatTarget('room')
    // Reset the recording flags. These were previously left stuck: a participant's recordingState
    // stayed 'recording' forever (its only reset paths are controller-only) which permanently
    // blocked "Back to setup"; and recordingStartRef kept the recording clock ticking after leave.
    setRecordingState('idle')
    setInteractionCapReached(false)
    recordingStartRef.current = null
    setCallState('idle')
    addLog('Left the room.', 'info')
  }
  leaveLiveCallRef.current = leaveLiveCall

  const returnToSetup = (): void => {
    // Only the experimenter has anything to lose by leaving mid-recording (it's the authoritative
    // saver). A participant can't stop/save the server-side recording anyway, so it must not be
    // blocked here — otherwise it can never get back to setup once the interaction has started.
    if (isController && recordingState === 'recording') {
      addLog('Conclude the study (or stop the recording) before returning to setup, so the session is saved.', 'error')
      return
    }
    if (callState !== 'idle') leaveLiveCall()
    // Returning to setup starts a fresh session. Clear the accumulators that otherwise bleed into
    // the next session's outputs: manipulation events (would corrupt manipulation_events.csv),
    // the timed schedule (would silently re-fire against a different dyad), and the control target.
    setControlEvents([])
    controlEventsRef.current = []
    setTimedSchedule([])
    updateForm('targetUserId', '')
    setSetupComplete(false)
    addLog('Returned to setup.', 'info')
  }

  const setControl = <K extends keyof ManipulationControls>(
    key: K,
    value: ManipulationControls[K],
    notes?: string
  ): void => {
    if (key === 'partnerVolume') {
      setControls((prev) => ({ ...prev, partnerVolume: browserVolume(Number(value)) }))
      appendControlEvent('partnerVolume', browserVolume(Number(value)), notes || 'Changed playback volume on this computer only.')
      addLog(`partnerVolume = ${browserVolume(Number(value)).toFixed(2)} applied on this computer only.`, 'info')
      return
    }

    if (controlsRef.current.automaticSmileOnsetMode === 'live' && key === 'smileAlpha') {
      addLog('Turn automatic smile synchrony off before changing Smile Alpha manually.', 'warn')
      return
    }

    setControls((prev) => ({ ...prev, [key]: value }))
    appendControlEvent(String(key), value, notes || `Applied to ${controlTargetLabel}.`)
    broadcastLiveControl(key, value)
    addLog(`${String(key)} = ${value} sent to ${controlTargetLabel}.`, 'info')
  }

  // Keep the timed-preset firing function pointed at the latest control closures.
  useEffect(() => {
    fireTimedPresetRef.current = (preset: TimedPreset): void => {
      // Automatic smile synchrony owns the smile alpha in Live mode; a scheduled change would fight
      // it. Skip and warn — the preset is still consumed by the scheduler, so it won't retry every
      // tick and spam the log.
      if (controlsRef.current.automaticSmileOnsetMode === 'live') {
        addLog(
          `Timed preset at ${secondsToMmSs(preset.atSeconds)} skipped — turn off automatic smile synchrony to run scheduled smile-alpha changes.`,
          'warn'
        )
        return
      }
      // Reflect it on the experimenter's own slider + event log, and broadcast to the target that
      // was snapshotted when the preset was scheduled (dyad-wide if none was selected) — not
      // whatever the Control-target dropdown happens to be at fire time.
      setControls((prev) => ({ ...prev, smileAlpha: preset.smileAlpha }))
      appendControlEvent(
        'smileAlpha',
        preset.smileAlpha,
        `Timed preset at ${secondsToMmSs(preset.atSeconds)} → ${preset.targetLabel}.`,
        preset.targetUserId
      )
      broadcastLiveControl(
        'smileAlpha',
        preset.smileAlpha,
        `Timed preset ${secondsToMmSs(preset.atSeconds)}`,
        preset.targetUserId
      )
      addLog(
        `Timed preset: smile alpha ${preset.smileAlpha} → ${preset.targetLabel} at ${secondsToMmSs(preset.atSeconds)}.`,
        'info'
      )
    }
  })

  const addTimedPreset = (): void => {
    const atSeconds = Math.max(0, Math.round(timedAtMin) * 60 + Math.round(timedAtSec))
    const smileAlpha = Math.max(-1, Math.min(1, Number(timedAlpha) || 0))
    // Snapshot the current control target so the preset fires against the participant the
    // experimenter has selected now, regardless of what's selected later.
    const targetUserId = form.targetUserId
    const targetLabel = controlTargetLabel
    setTimedSchedule((prev) =>
      [...prev, { id: makeId(), atSeconds, smileAlpha, targetUserId, targetLabel, fired: false }].sort(
        (a, b) => a.atSeconds - b.atSeconds
      )
    )
  }
  const removeTimedPreset = (id: string): void => {
    setTimedSchedule((prev) => prev.filter((preset) => preset.id !== id))
  }

  const setSynchronyMode = (mode: ManipulationControls['synchronyMode']): void => {
    if (controlsRef.current.automaticSmileOnsetMode === 'live') {
      addLog('Turn automatic smile synchrony off before changing manual synchrony mode.', 'warn')
      return
    }
    const nextAlpha =
      mode === 'aligned' ? 0 : mode === 'suppressed' ? controls.suppressSmileAlpha : controls.smileAlpha
    setControls((prev) => ({ ...prev, synchronyMode: mode, smileAlpha: nextAlpha }))
    appendControlEvent('synchronyMode', mode, `Mode changed for ${controlTargetLabel}.`)
    broadcastLiveControl('synchronyMode', mode, `Synchrony mode: ${mode}`)
    broadcastLiveControl('smileAlpha', nextAlpha, `Synchrony mode alpha: ${mode}`)
    addLog(`Synchrony mode ${mode} sent to ${controlTargetLabel}.`, 'info')
  }

  const triggerCueResponse = (cue: string, alpha: number, label: string): void => {
    if (controlsRef.current.automaticSmileOnsetMode === 'live') {
      addLog('Manual cue buttons are disabled while automatic smile synchrony is live.', 'warn')
      return
    }
    const returnAlpha = controls.synchronyMode === 'suppressed' ? controls.suppressSmileAlpha : 0
    const durationMs = controls.reactivePulseMs
    setControls((prev) => ({ ...prev, synchronyMode: 'reactive' }))
    appendControlEvent('cueResponse', alpha, `${label}; target ${controlTargetLabel}; return ${returnAlpha} after ${durationMs}ms.`)
    sendDirectorPayload({
      kind: 'cue-response',
      cue,
      targetUserId: form.targetUserId || undefined,
      alpha,
      returnAlpha,
      durationMs,
      label
    })
    addLog(`${label} sent to ${controlTargetLabel}.`, 'info')
  }

  const setAutomaticSmileOnsetMode = (
    mode: ManipulationControls['automaticSmileOnsetMode']
  ): void => {
    setControls((previous) => ({
      ...previous,
      automaticSmileOnsetMode: mode,
      synchronyMode: 'aligned',
      smileAlpha: 0
    }))
    controlsRef.current = {
      ...controlsRef.current,
      automaticSmileOnsetMode: mode,
      synchronyMode: 'aligned',
      smileAlpha: 0
    }
    appendControlEvent(
      'automaticSmileOnsetMode',
      mode,
      mode === 'off'
        ? 'Automatic participant-driven smile synchrony disabled.'
        : mode === 'detect'
          ? 'Participants detect and log clean-feed smile onsets and offsets without manipulation.'
          : 'Participants automatically align partner smile onset and return on matched smile offset.'
    )
    // Automatic onset is a dyad-level condition and intentionally ignores the manual
    // Control target dropdown. Both participant detectors must receive the same mode.
    sendDirectorPayload({
      kind: 'live-control',
      key: 'automaticSmileOnsetMode',
      value: mode,
      label: `Automatic smile synchrony: ${mode}`
    })
    sendDirectorPayload({
      kind: 'live-control',
      key: 'synchronyMode',
      value: 'aligned',
      label: 'Automatic smile synchrony requires a neutral aligned baseline.'
    })
    sendDirectorPayload({
      kind: 'live-control',
      key: 'smileAlpha',
      value: 0,
      label: 'Automatic smile synchrony reset baseline to neutral.'
    })
    addLog(`Automatic smile synchrony mode set to ${mode}.`, mode === 'live' ? 'warn' : 'info')
  }

  const concludeStudy = (): void => {
    appendControlEvent('study', 'conclude', 'Experimenter concluded the study for all participant stations.')
    sendDirectorPayload({ kind: 'session-conclude' })
    addLog('Study concluded. Participants will leave; saving session files + recordings here.', 'warn')
    // The experimenter saves the authoritative session folder (logs, chat, manifests) and collects
    // the videos. finalize retries the video copy so the participants' .mp4s have time to finish.
    void finalizeDuckSoupSession()
  }

  const applyAudioPreset = (preset: (typeof audioPresets)[number]): void => {
    const nextPitch = preset.effectName === 'pitch' ? preset.value : preset.preset === 'none' ? 1 : controls.audioPitch
    const nextGain = preset.effectName === 'volume' ? preset.value : preset.preset === 'none' ? 1 : controls.audioGain
    setControls((prev) => ({
      ...prev,
      audioPreset: preset.preset,
      audioPitch: nextPitch,
      audioGain: nextGain
    }))
    appendControlEvent('audioPreset', preset.label, preset.note)
    broadcastLiveControl('audioPreset', preset.preset)
    broadcastLiveControl('audioPitch', nextPitch)
    broadcastLiveControl('audioGain', nextGain)
    addLog(`${preset.label} sent to participant streams.`, 'info')
  }

  const sendChat = async (): Promise<void> => {
    const text = chatText.trim()
    if (!text || !form.roomId || !form.callSignalUrl) return

    const message: ChatMessage = {
      id: makeId(),
      roomId: form.roomId,
      from: callUserIdRef.current,
      fromName: callDisplayName(),
      fromRole: form.role,
      text,
      sentAt: new Date().toISOString()
    }

    if (chatTarget === 'controllers') message.targetRole = 'controller'
    else if (chatTarget === 'participants') message.targetRole = 'participant'
    else if (chatTarget !== 'room') message.to = chatTarget

    setChatText('')

    try {
      const response = await fetch(`${signalBaseUrl()}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      })
      if (!response.ok) throw new Error(`Chat failed with HTTP ${response.status}`)
    } catch (error) {
      addLog(error instanceof Error ? error.message : 'Could not send chat message.', 'error')
      addChatMessage({ ...message, text: `[not sent] ${message.text}` })
    }
  }

  const startRecording = async (): Promise<void> => {
    const cleanStream = cleanStreamRef.current
    const alteredStream = alteredStreamRef.current
    if (!cleanStream || !alteredStream || alteredStream.getTracks().length === 0) {
      addLog('Join as a participant before recording. The app records that station clean and altered streams.', 'error')
      return
    }
    if (!form.outputFolder) {
      addLog('No output folder selected. Saving to the default Emotions Lab sessions folder.', 'info')
    }

    const { sessionDir: createdDir } = await window.researchApi.createSessionDirectory(form)
    setSessionDir(createdDir)
    cleanChunksRef.current = []
    alteredChunksRef.current = []
    const mimeType = supportedRecorderType()
    const recorderOptions = mimeType ? { mimeType } : undefined

    cleanRecorderRef.current = new MediaRecorder(cleanStream, recorderOptions)
    alteredRecorderRef.current = new MediaRecorder(alteredStream, recorderOptions)
    cleanRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) cleanChunksRef.current.push(event.data)
    }
    alteredRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) alteredChunksRef.current.push(event.data)
    }

    recordingStartRef.current = Date.now()
    setRecordingSeconds(0)
    setRecordingState('recording')
    appendControlEvent('recording', 'start', `Session directory: ${createdDir}`)
    cleanRecorderRef.current.start(1000)
    alteredRecorderRef.current.start(1000)
    addLog('Recording clean and altered local streams.', 'success')
  }

  const saveRecordings = async (): Promise<void> => {
    if (!sessionDir) return
    setRecordingState('saving')

    const cleanBlob = new Blob(cleanChunksRef.current, { type: 'video/webm' })
    const alteredBlob = new Blob(alteredChunksRef.current, { type: 'video/webm' })
    const [cleanPath, alteredPath] = await Promise.all([
      window.researchApi.saveBlob({
        sessionDir,
        filename: `${form.roomId}-${form.participantId}-clean.webm`,
        buffer: await cleanBlob.arrayBuffer()
      }),
      window.researchApi.saveBlob({
        sessionDir,
        filename: `${form.roomId}-${form.participantId}-altered.webm`,
        buffer: await alteredBlob.arrayBuffer()
      })
    ])

    const manifest = {
      savedAt: new Date().toISOString(),
      transport: 'mesh',
      session: form,
      controlsAtEnd: controls,
      files: { cleanVideo: cleanPath, alteredVideo: alteredPath },
      recording: {
        startedAt: recordingStartRef.current ? new Date(recordingStartRef.current).toISOString() : null,
        endedAt: new Date().toISOString(),
        durationMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : null,
        note:
          'startedAt is video t=0. manipulation_events.csv elapsedMs is milliseconds from startedAt (negative = logged before recording began), aligning it with cleanVideo/alteredVideo.'
      },
      ppsPlaybackPlan: [
        {
          participantUserId: form.participantId,
          participantDisplayName: form.displayName,
          ratingView: {
            selfVideo: cleanPath,
            partnerVideo: null,
            selfVideoMeaning: 'Unmanipulated self recording from this station.',
            partnerVideoMeaning:
              'Use the partner station altered/manipulated video here after both participant stations are exported.'
          },
          partnerCandidates: [{ userId: form.partnerId, displayName: form.partnerId }]
        }
      ],
      notes: [
        'cleanVideo is the local unaltered webcam/microphone stream.',
        'alteredVideo is the outgoing participant stream after live experimenter settings.',
        'For empathic accuracy ratings, pair this clean self video with the partner station altered/manipulated video.',
        'manipulation_events.csv elapsedMs is milliseconds from recording.startedAt (video t=0), aligning it with cleanVideo/alteredVideo.'
      ]
    }

    await Promise.all([
        window.researchApi.writeTextFile({
          sessionDir,
          filename: 'session_manifest.json',
          contents: JSON.stringify(manifest, null, 2)
        }),
        window.researchApi.writeTextFile({
          sessionDir,
          filename: 'pps_playback_manifest.json',
          contents: JSON.stringify(
            {
              savedAt: manifest.savedAt,
              studyId: form.studyId,
              roomId: form.roomId,
              dyadId: form.dyadId,
              instructions:
                'For empathic accuracy ratings, show the participant their clean self video and the partner station altered/manipulated video.',
              playbackPlan: manifest.ppsPlaybackPlan
            },
            null,
            2
          )
        }),
        window.researchApi.writeTextFile({
          sessionDir,
        filename: 'manipulation_events.csv',
        contents: controlEventsToCsv([
          ...controlEvents,
          {
            id: makeId(),
            timestamp: new Date().toISOString(),
            elapsedMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : 0,
            roomId: form.roomId,
            participantId: form.participantId,
            partnerId: form.partnerId,
            targetUserId: form.targetUserId || 'all-participants',
            condition: form.condition,
            control: 'recording',
            value: 'stop',
            appliedToDuckSoup: false,
            notes: 'Recording stopped and files saved.'
          }
        ], recordingStartRef.current)
      }),
      window.researchApi.writeTextFile({
        sessionDir,
        filename: 'chat_log.csv',
        contents: chatMessagesToCsv(chatMessagesRef.current, callPeersRef.current)
      })
    ])

    recordingStartRef.current = null
    setRecordingState('idle')
    addLog(`Saved clean and altered videos to ${sessionDir}`, 'success')
  }

  const stopRecording = (): void => {
    if (cleanRecorderRef.current?.state === 'recording') cleanRecorderRef.current.stop()
    if (alteredRecorderRef.current?.state === 'recording') alteredRecorderRef.current.stop()
    window.setTimeout(() => {
      saveRecordings().catch((error) => {
        setRecordingState('idle')
        addLog(error instanceof Error ? error.message : 'Could not save recordings.', 'error')
      })
    }, 250)
  }

  const continueFromSetup = async (): Promise<void> => {
    let nextRoomId = form.roomId
    let nextSignalUrl = form.callSignalUrl

    if (!isController && sessionLinkInput.trim()) {
      if (sessionLinkInput.trim() !== appliedSessionLinkInput) {
        setSessionLinkNotice('Click Use to load this session link before continuing.')
        playNoticeTone()
        sessionLinkSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        addLog('Click Use to load the pasted session link before continuing.', 'error')
        return
      }

      try {
        const parsed = parseSessionLink(sessionLinkInput)
        nextRoomId = parsed.roomId
        nextSignalUrl = parsed.callSignalUrl
        setForm((prev) => ({ ...prev, ...parsed }))
      } catch (error) {
        addLog(error instanceof Error ? error.message : 'Could not read that session link.', 'error')
        return
      }
    }

    if (!nextRoomId.trim()) {
      addLog('Create or enter a meeting ID before continuing.', 'error')
      return
    }
    if (!nextSignalUrl.trim()) {
      addLog('Enter a session link before continuing.', 'error')
      return
    }

    if (isController && isLocalSignalUrl(nextSignalUrl)) {
      const result = await startSignalServer()
      if (!result.ok) return
    } else {
      const reachable = await checkRoomStatus(false, { roomId: nextRoomId, callSignalUrl: nextSignalUrl })
      if (!reachable) return
    }

    setSetupComplete(true)
  }

  if (!welcomeComplete) {
    return <WelcomeScreen onStart={() => setWelcomeComplete(true)} />
  }

  if (!setupComplete) {
    if (experimenterLoginOpen && !isController) {
      return (
        <div className="portal-login-shell">
          <header className="portal-login-header">
            <div>
              <h1>{appTitle}</h1>
              <p>{appSubtitle}</p>
            </div>
            <button
              onClick={() => {
                setExperimenterLoginOpen(false)
                setExperimenterLoginError('')
              }}
            >
              Switch to participant view
            </button>
          </header>

          <main className="portal-login-main">
            <section className="portal-login-card" role="dialog" aria-label="Experimenter login">
              <div className="portal-login-card-header">
                <div className="portal-icon">NEL</div>
                <h2>Experimenter Portal</h2>
              </div>

              <div className="portal-login-form">
                <label>
                  Username / Researcher ID
                  <input
                    value={experimenterCredentials.username}
                    onChange={(event) =>
                      setExperimenterCredentials((prev) => ({ ...prev, username: event.target.value }))
                    }
                    placeholder="Enter your ID"
                    autoFocus
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={experimenterCredentials.password}
                    onChange={(event) =>
                      setExperimenterCredentials((prev) => ({ ...prev, password: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitExperimenterLogin()
                    }}
                    placeholder="Enter your password"
                  />
                </label>

                {experimenterLoginError && <p className="login-error">{experimenterLoginError}</p>}

                <button className="primary wide-button" onClick={submitExperimenterLogin}>
                  Login
                </button>
              </div>
            </section>
          </main>
        </div>
      )
    }

    return (
      <div className="setup-shell">
        <section className="setup-card">
          <div className="setup-header">
            <div>
              <h1>{appTitle}</h1>
              <p>{appSubtitle}</p>
            </div>
            <div className="setup-header-actions">
              {isController && (
                <InfoDot description="Reminder: bring the Advanced button back before the lab setup. We hid it for a cleaner screen, but the lab needs it — that's where you point the participants' computers at the right server address so they can connect." />
              )}
              {isController ? (
                <button onClick={returnToParticipantMode}>Exit experimenter mode</button>
              ) : (
                <button onClick={() => setExperimenterLoginOpen(true)}>Experimenter login</button>
              )}
            </div>
          </div>

          {experimenterLoginOpen && (
            <div className="login-panel" role="dialog" aria-label="Experimenter login">
              <div>
                <div className="section-title accent">Experimenter Login</div>
                <p className="plain-text compact-copy">Use the experimenter account to set the study format and room controls.</p>
              </div>
              <div className="field-grid two">
                <label>
                  Username
                  <input
                    value={experimenterCredentials.username}
                    onChange={(event) =>
                      setExperimenterCredentials((prev) => ({ ...prev, username: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={experimenterCredentials.password}
                    onChange={(event) =>
                      setExperimenterCredentials((prev) => ({ ...prev, password: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitExperimenterLogin()
                    }}
                  />
                </label>
              </div>
              {experimenterLoginError && <p className="login-error">{experimenterLoginError}</p>}
              <div className="button-row no-margin">
                <button className="primary" onClick={submitExperimenterLogin}>
                  Login
                </button>
                <button
                  onClick={() => {
                    setExperimenterLoginOpen(false)
                    setExperimenterLoginError('')
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className={isController ? 'setup-grid' : 'setup-grid setup-grid--even'}>
            <section className="panel" ref={sessionLinkSectionRef}>
              <div className="section-title accent">Meeting</div>
              {isController ? (
                <div className="share-card">
                  <span>Participant session link</span>
                  <input value={sessionLink} readOnly />
                  <div className="button-row no-margin">
                    <button className="primary" onClick={() => copySessionLink()}>
                      Copy link
                    </button>
                  </div>
                </div>
              ) : (
                <label>
                  Session link
                  <div className="input-action-row">
                    <input
                      value={sessionLinkInput}
                      onChange={(event) => {
                        setSessionLinkInput(event.target.value)
                        setSessionLinkNotice('')
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') applySessionLink(sessionLinkInput)
                      }}
                      placeholder="Paste the link from the experimenter"
                    />
                    <button onClick={() => applySessionLink(sessionLinkInput)}>Use</button>
                  </div>
                  {sessionLinkNotice && <p className="setup-notice">{sessionLinkNotice}</p>}
                </label>
              )}
            </section>

            <section className={isController ? 'panel setup-wide' : 'panel'}>
              <div className="section-title accent">Session Details</div>
              <div className={isController ? 'field-grid two' : 'field-grid'}>
                {!isController && (
                  <label>
                    Display name
                    <input value={form.displayName} onChange={(event) => updateForm('displayName', event.target.value)} />
                  </label>
                )}
                {isController && (
                  <label>
                    Study
                    <input value={form.studyId} onChange={(event) => updateForm('studyId', event.target.value)} />
                  </label>
                )}
                {isController && (
                  <label>
                    RA
                    <input value={form.raId} onChange={(event) => updateForm('raId', event.target.value)} />
                  </label>
                )}
                {isController && (
                  <label>
                    Left machine
                    <input
                      value={form.participantId}
                      onChange={(event) => updateForm('participantId', event.target.value)}
                      placeholder="e.g. P001"
                    />
                  </label>
                )}
                {isController && (
                  <label>
                    Right machine
                    <input
                      value={form.partnerId}
                      onChange={(event) => updateForm('partnerId', event.target.value)}
                      placeholder="e.g. P002"
                    />
                  </label>
                )}
                {isController && (
                  <label>
                    Dyad/session ID
                    <input value={form.dyadId} onChange={(event) => updateForm('dyadId', event.target.value)} />
                  </label>
                )}
                {isController && (
                  <label>
                    Output folder
                    <div className="input-action-row">
                      <input value={form.outputFolder} readOnly placeholder="Choose output folder for recordings" />
                      <button className="browse-button" onClick={pickFolder}>
                        Browse
                      </button>
                    </div>
                  </label>
                )}
              </div>
            </section>
          </div>

          <div className="setup-actions">
            <button className="primary setup-continue" onClick={() => continueFromSetup()}>
              Continue to room
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>{appTitle}</h1>
        </div>
        <div className="topbar-actions">
          <button onClick={returnToSetup}>Back to setup</button>
          {callState === 'idle' || callState === 'error' ? (
            <button className="primary" onClick={joinLiveCall}>
              {callState === 'error' ? 'Rejoin' : 'Join room'}
            </button>
          ) : (
            <button className="danger leave-button" onClick={leaveLiveCall}>
              Leave room
            </button>
          )}
        </div>
      </header>

      <main className={isController ? 'workspace controller-workspace' : 'workspace participant-workspace'}>
        {isController && (
          <aside className="sidebar">
          <section className="panel">
            <div className="section-title accent">Room</div>
            <div className="metric-list">
              <div className="metric">
                <span>Participants joined</span>
                <strong>{participantPeers.length}/{expectedParticipants}</strong>
              </div>
            </div>
            <div className="button-row">
              <button onClick={() => copySessionLink()}>Copy link</button>
            </div>
          </section>

          <section className="panel">
            <div className="section-title">Experimenter Notes</div>
            <textarea
              className="notes-area"
              value={experimenterNotes}
              onChange={(event) => {
                setExperimenterNotes(event.target.value)
                experimenterNotesRef.current = event.target.value
              }}
              placeholder="Optional notes about this session (saved with the session files on Conclude)."
              rows={5}
            />
          </section>

          {isController && (
            <section className="panel">
              <div className="section-title">Recording</div>
              {useDuckSoup ? (
                <>
                  <div className="metric-list">
                    <div className="metric">
                      <span>Events logged</span>
                      <strong>{controlEvents.length}</strong>
                    </div>
                  </div>
                  <p className="plain-text compact-copy">
                    The videos (clean + altered) go to:
                    <br />
                    <code className="path-text">
                      {storagePaths
                        ? `${storagePaths.serverDataDir}\\${duckSoupNamespace()}\\${form.roomId}\\recordings`
                        : `docker\\ducksoup\\data\\${duckSoupNamespace()}\\${form.roomId}\\recordings`}
                    </code>
                    <br />
                    Manifests, Logs, Chat, Notes go to:{' '}
                    <code className="path-text">
                      {form.outputFolder || storagePaths?.sessionsDir || 'Documents\\Niedenthal Emotions Lab Sessions'}
                    </code>
                  </p>
                  <button
                    className="danger wide-button"
                    onClick={concludeStudy}
                    disabled={callState === 'idle' || callState === 'error'}
                  >
                    Conclude study
                  </button>
                </>
              ) : (
                <>
                  <div className="button-row no-margin">
                    <button onClick={startRecording} disabled={recordingState !== 'idle'} className="record">
                      Start recording
                    </button>
                    <button onClick={stopRecording} disabled={recordingState !== 'recording'} className="stop">
                      Stop
                    </button>
                  </div>
                  <div className="metric-list">
                    <div className="metric">
                      <span>Recording</span>
                      <strong>{recordingState === 'recording' ? `${recordingSeconds}s` : recordingState}</strong>
                    </div>
                    <div className="metric">
                      <span>Events logged</span>
                      <strong>{controlEvents.length}</strong>
                    </div>
                    <div className="metric">
                      <span>Folder</span>
                      <strong>{sessionDir || 'created when recording starts'}</strong>
                    </div>
                  </div>
                  <p className="plain-text compact-copy">
                    Legacy local recording (canvas path). Each participant station saves its own clean and
                    altered video, session file, and control timing CSV.
                  </p>
                  <button
                    className="danger wide-button"
                    onClick={concludeStudy}
                    disabled={callState === 'idle' || callState === 'error'}
                  >
                    Conclude study
                  </button>
                </>
              )}
            </section>
          )}

          <section className="panel">
            <div className="section-title">Session Details</div>
            <div className="metric-list">
              <div className="metric">
                <span>Study</span>
                <strong>{form.studyId || 'not set'}</strong>
              </div>
              <div className="metric">
                <span>RA</span>
                <strong>{form.raId || 'not set'}</strong>
              </div>
              <div className="metric">
                <span>Session ID</span>
                <strong>{form.dyadId || 'not set'}</strong>
              </div>
              <div className="metric">
                <span>Left machine</span>
                <strong>{form.participantId || 'not set'}</strong>
              </div>
              <div className="metric">
                <span>Right machine</span>
                <strong>{form.partnerId || 'not set'}</strong>
              </div>
              <div className="metric">
                <span>Format</span>
                <strong>{sessionLabels[form.sessionFormat]}</strong>
              </div>
            </div>
          </section>
          </aside>
        )}

        <section className="center-stage">
          <section className="panel call-panel">
            {isController && (
              <div className="section-title accent conference-title">
                <span>Live Video Conference</span>
                <LiveClock running={bothParticipantsPresent && !interactionCapReached} />
              </div>
            )}
            {isController ? (
              useDuckSoup ? (
                // Experimenter monitor: each participant's unaltered (clean) + altered feed,
                // forwarded from the participants over the monitor WebRTC channel. The view
                // toggle drops to a 2-tile view (only mounting those videos) to cut GPU/RAM load.
                <>
                  <div className="monitor-view-toggle">
                    <button
                      className={monitorView === 'all' ? 'active' : ''}
                      onClick={() => setMonitorView('all')}
                    >
                      All 4
                    </button>
                    <button
                      className={monitorView === 'clean' ? 'active' : ''}
                      onClick={() => setMonitorView('clean')}
                    >
                      Unaltered
                    </button>
                    <button
                      className={monitorView === 'altered' ? 'active' : ''}
                      onClick={() => setMonitorView('altered')}
                    >
                      Altered
                    </button>
                  </div>
                  <div className={`conference-grid tiles-${monitorView === 'all' ? 4 : 2}`}>
                    {Array.from({ length: expectedParticipants }).map((_, index) => {
                      const peer = participantPeers[index]
                      const who = peer ? peer.displayName : `Participant ${index + 1}`
                      const labels: ('Unaltered' | 'Altered')[] =
                        monitorView === 'all'
                          ? ['Unaltered', 'Altered']
                          : monitorView === 'altered'
                            ? ['Altered']
                            : ['Unaltered']
                      return labels.map((label) => {
                        const monKind = label === 'Unaltered' ? 'clean' : 'altered'
                        const tile = peer ? monitorByKey.get(`${peer.userId}:${monKind}`) : undefined
                        return (
                          <MonitorVideoCard
                            key={`${index}-${label}`}
                            label={`${who} · ${label}`}
                            stream={tile?.stream ?? null}
                          />
                        )
                      })
                    })}
                  </div>
                </>
              ) : remoteTiles.length > 0 ? (
                <div className={`conference-grid tiles-${Math.min(remoteTiles.length, 4)}`}>
                  {remoteTiles.map((tile) => (
                    <RemoteVideoCard key={tile.userId} tile={tile} volume={controls.partnerVolume} />
                  ))}
                </div>
              ) : (
                <div className="conference-grid tiles-4">
                  {Array.from({ length: expectedParticipants }).map((_, index) => {
                    const peer = participantPeers[index]
                    const who = peer ? peerStripLabel(peer) : `Participant ${index + 1}`
                    return (['Unaltered', 'Altered'] as const).map((kind) => (
                      <div className="video-panel" key={`${index}-${kind}`}>
                        <div className="video-label">{`${who} · ${kind}`}</div>
                        <div className="video-empty">(waiting)</div>
                      </div>
                    ))
                  })}
                </div>
              )
            ) : (
              <>
                {controls.automaticSmileOnsetMode !== 'off' &&
                  smileDetectorSnapshot &&
                  !['ready', 'onset-candidate', 'cue-active', 'cooldown'].includes(smileDetectorSnapshot.phase) && (
                    <div className={`smile-calibration-notice ${smileDetectorSnapshot.phase === 'failed' ? 'failed' : ''}`}>
                      {smileDetectorSnapshot.phase === 'calibrating-neutral' && (
                        <span>
                          Camera calibration: look naturally toward the camera and relax your face for{' '}
                          {Math.max(1, Math.ceil(smileDetectorSnapshot.neutralRemainingMs / 1000))} seconds.
                        </span>
                      )}
                      {smileDetectorSnapshot.phase === 'calibrating-smiles' && (
                        <span>
                          Camera calibration: smile naturally, relax, and repeat.{' '}
                          {smileDetectorSnapshot.promptedSmiles}/3 complete.
                        </span>
                      )}
                      {smileDetectorSnapshot.phase === 'face-missing' && (
                        <span>Camera calibration paused. Center your full face in the camera.</span>
                      )}
                      {smileDetectorSnapshot.phase === 'failed' && (
                        <>
                          <span>{smileDetectorSnapshot.calibrationFailure}</span>
                          <button className="secondary" onClick={retrySmileCalibration}>
                            Retry calibration
                          </button>
                        </>
                      )}
                    </div>
                  )}
                <div className="participant-stage">
                  {remoteTiles.length > 0 ? (
                    <RemoteVideoCard
                      key={remoteTiles[0].userId}
                      tile={remoteTiles[0]}
                      volume={controls.partnerVolume}
                    />
                  ) : (
                    <div className="video-panel">
                      <div className="video-label">Waiting room</div>
                      <div className="video-empty">Waiting for another participant to join this meeting ID…</div>
                    </div>
                  )}
                  <div className="self-pip">
                    <video
                      ref={callLocalVideoRef}
                      autoPlay
                      muted
                      playsInline
                      className={showSelfView ? 'video-surface' : 'video-surface hidden-preview'}
                    />
                    {showSelfView && <div className="self-pip-label">You</div>}
                    {!showSelfView && <div className="video-empty">Self view hidden.</div>}
                    {callState === 'idle' && <div className="video-empty">Join to start your camera.</div>}
                    <button className="overlay-button" onClick={() => setShowSelfView((prev) => !prev)}>
                      {showSelfView ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>

          {isController && (
            <section className="panel log-panel">
              <div className="section-title">Event Log</div>
              <div className="log-list" ref={logListRef}>
                {logs.length === 0 ? (
                  <p className="muted">No events yet. Join the room or check the server to start.</p>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className={`log-line ${log.level}`}>
                      <span className="log-time">{log.timestamp}</span>
                      <span className="log-message">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
        </section>

        <aside className="controls">
          {isController ? (
            <>
              <section className="panel">
                <div className="section-title accent">Face Modulation</div>
                <label className="control-target">
                  Control target
                  <select value={form.targetUserId} onChange={(event) => updateForm('targetUserId', event.target.value)}>
                    <option value="">All participants</option>
                    {participantPeers.map((peer) => (
                      <option key={peer.userId} value={peer.userId}>
                        {peer.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mode-card automatic-smile-card">
                  <div>
                    <span>Automatic smile synchrony</span>
                    <InfoDot description="Auto-detects each participant's smile and briefly mirrors it onto their partner. Detect = log only; Live = apply." />
                  </div>
                  <div className="segmented-row automatic-smile-modes">
                    <InfoButton
                      className={controls.automaticSmileOnsetMode === 'off' ? 'active' : ''}
                      description="Turn automatic detection off and return all faces to neutral."
                      onClick={() => setAutomaticSmileOnsetMode('off')}
                    >
                      Off
                    </InfoButton>
                    <InfoButton
                      className={controls.automaticSmileOnsetMode === 'detect' ? 'active' : ''}
                      description="Detect and timestamp participant smile onsets and offsets without altering the partner."
                      onClick={() => setAutomaticSmileOnsetMode('detect')}
                    >
                      Detect
                    </InfoButton>
                    <InfoButton
                      className={controls.automaticSmileOnsetMode === 'live' ? 'active' : ''}
                      description="A participant smile onset adds a subtle partner smile; the matched offset smoothly returns Mozza to the partner's physical baseline."
                      onClick={() => setAutomaticSmileOnsetMode('live')}
                    >
                      Live
                    </InfoButton>
                  </div>
                </div>
                <RangeControl
                  label="Smile alpha"
                  description="0 = neutral, positive = smile, negative = frown. Keep within about -0.8 to 0.8 for best results."
                  value={controls.smileAlpha}
                  min={-1}
                  max={1}
                  step={0.05}
                  markers={['Frown', 'Neutral', 'Smile']}
                  neutral={0}
                  onChange={(value) => setControl('smileAlpha', value)}
                />
                <details className="advanced-controls">
                  <summary>Advanced</summary>
                  <div className="advanced-group-title">Manual override</div>
                <div className="mode-card">
                  <div>
                    <span>Synchrony mode</span>
                  </div>
                  <div className="segmented-row">
                    <InfoButton
                      className={controls.synchronyMode === 'aligned' ? 'active' : ''}
                      description="Return the target to a neutral baseline expression."
                      onClick={() => setSynchronyMode('aligned')}
                    >
                      Aligned
                    </InfoButton>
                    <InfoButton
                      className={controls.synchronyMode === 'suppressed' ? 'active' : ''}
                      description="Dampen or pull down the target's smile, live."
                      onClick={() => setSynchronyMode('suppressed')}
                    >
                      Suppressed
                    </InfoButton>
                    <InfoButton
                      className={controls.synchronyMode === 'reactive' ? 'active' : ''}
                      description="Arm the cue buttons: brief expression changes that snap back to baseline."
                      onClick={() => setSynchronyMode('reactive')}
                    >
                      Reactive
                    </InfoButton>
                  </div>
                </div>
                <RangeControl
                  label="Suppressed smile alpha"
                  description="Smile level used in Suppressed mode. 0 = neutral; negative dampens or frowns."
                  value={controls.suppressSmileAlpha}
                  min={-1}
                  max={0}
                  step={0.05}
                  markers={['Frown pull', 'Dampened', 'Neutral']}
                  neutral={-0.45}
                  onChange={(value) => setControl('suppressSmileAlpha', value, 'Updated the suppression alpha preset.')}
                />
                <RangeControl
                  label="Reactive pulse (ms)"
                  description="How long a cue response lasts before returning to baseline."
                  value={controls.reactivePulseMs}
                  min={300}
                  max={5000}
                  step={100}
                  markers={['Quick', 'Default', 'Long']}
                  neutral={1800}
                  onChange={(value) => setControl('reactivePulseMs', value, 'Updated cue-response duration.')}
                />
                <div className="cue-grid">
                  <InfoButton
                    description="Partner smiled: briefly dampen the target's smile, then return."
                    onClick={() => triggerCueResponse('partner-smile', controls.suppressSmileAlpha, 'Partner smile cue -> dampen/frown response')}
                  >
                    Partner smile cue
                  </InfoButton>
                  <InfoButton
                    description="Partner laughed: stronger brief suppression."
                    onClick={() => triggerCueResponse('partner-laugh', Math.min(-0.75, controls.suppressSmileAlpha), 'Partner laugh cue -> stronger suppression')}
                  >
                    Partner laugh cue
                  </InfoButton>
                  <InfoButton
                    description="Briefly raise the target's smile (affiliative / repair cue)."
                    onClick={() => triggerCueResponse('repair-smile', 0.4, 'Repair cue -> brief affiliative smile')}
                  >
                    Repair smile cue
                  </InfoButton>
                  <InfoButton
                    description="Clear any cue: return the target to neutral."
                    onClick={() => triggerCueResponse('neutral-reset', 0, 'Neutral reset cue')}
                  >
                    Neutral reset
                  </InfoButton>
                </div>
                  <div className="advanced-group-title">Face tracking</div>
                <RangeControl
                  label="Detection threshold"
                  description="Face-detect strictness. Lower = better in dim light; higher = less stray warping."
                  value={controls.faceThreshold}
                  min={0}
                  max={1}
                  step={0.05}
                  markers={['Sensitive', 'Default', 'Strict']}
                  neutral={0.1}
                  onChange={(value) => setControl('faceThreshold', value)}
                />
                <RangeControl
                  label="Landmark beta"
                  description="Tracking speed. Lower = steadier; higher = snappier but jumpier. ~0.02 is smooth."
                  value={controls.landmarkBeta}
                  min={0}
                  max={0.5}
                  step={0.01}
                  markers={['Stable', 'Default', 'Fast']}
                  neutral={0.02}
                  onChange={(value) => setControl('landmarkBeta', value)}
                />
                <RangeControl
                  label="Smoothing cutoff"
                  description="Warp smoothing. Lower = smoother (slight lag); higher = more immediate. ~0.3 is smooth."
                  value={controls.smoothingCutoff}
                  min={0.1}
                  max={3}
                  step={0.05}
                  markers={['Smooth', 'Default', 'Responsive']}
                  neutral={0.3}
                  onChange={(value) => setControl('smoothingCutoff', value)}
                />
                </details>
              </section>

              <section className="panel">
                <div className="section-title accent">
                  Timed schedule
                  <InfoDot description="Sets smile alpha at a set time into the call, timed from when both participants join. Each entry remembers the Control target selected when you added it, and fires automatically at its time." />
                </div>
                <div className="timed-add">
                  <label>
                    Min
                    <input
                      type="number"
                      min={0}
                      value={timedAtMin}
                      onChange={(event) => setTimedAtMin(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Sec
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={timedAtSec}
                      onChange={(event) => setTimedAtSec(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Smile alpha
                    <input
                      type="text"
                      inputMode="decimal"
                      value={timedAlpha}
                      onChange={(event) => setTimedAlpha(event.target.value)}
                      onBlur={() => setTimedAlpha(String(Math.max(-1, Math.min(1, Number(timedAlpha) || 0))))}
                    />
                  </label>
                  <button className="secondary" onClick={addTimedPreset}>
                    Add
                  </button>
                </div>
                <div className="timed-list">
                  {timedSchedule.length === 0 ? (
                    <span className="muted">No timed changes scheduled.</span>
                  ) : (
                    timedSchedule.map((preset) => (
                      <div className="timed-row" key={preset.id}>
                        <span className="timed-when">{secondsToMmSs(preset.atSeconds)}</span>
                        <span className="timed-what">
                          smile alpha {preset.smileAlpha} → {preset.targetLabel}
                        </span>
                        <span className={preset.fired ? 'timed-status done' : 'timed-status pending'}>
                          {preset.fired ? 'done' : 'pending'}
                        </span>
                        <button className="timed-remove" onClick={() => removeTimedPreset(preset.id)}>
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="section-title">Voice / Synchrony</div>
                <div className="preset-list compact">
                  {audioPresets
                    .filter((preset) => preset.effectName !== 'volume')
                    .map((preset) => (
                      <button
                        key={preset.preset}
                        className={controls.audioPreset === preset.preset ? 'preset active' : 'preset'}
                        onClick={() => applyAudioPreset(preset)}
                      >
                        {preset.label}
                      </button>
                    ))}
                </div>
                <RangeControl
                  label="Outgoing voice tone"
                  description="Participant mic tone. Lower = warmer/deeper; higher = brighter."
                  value={controls.audioPitch}
                  min={0.6}
                  max={1.4}
                  step={0.02}
                  markers={['Deeper', 'Neutral', 'Brighter']}
                  neutral={1}
                  onChange={(value) => {
                    setControls((prev) => ({ ...prev, audioPreset: 'custom-pitch', audioPitch: value }))
                    appendControlEvent('audioTone', value, 'Applied to outgoing participant microphone audio.')
                    broadcastLiveControl('audioPreset', 'custom-pitch')
                    broadcastLiveControl('audioPitch', value)
                    addLog(`Outgoing voice tone = ${value.toFixed(2)} sent to participants.`, 'info')
                  }}
                />
                <details className="advanced-controls">
                  <summary>Advanced</summary>
                  <div className="preset-list compact">
                    {audioPresets
                      .filter((preset) => preset.effectName === 'volume')
                      .map((preset) => (
                        <button
                          key={preset.preset}
                          className={controls.audioPreset === preset.preset ? 'preset active' : 'preset'}
                          onClick={() => applyAudioPreset(preset)}
                        >
                          {preset.label}
                        </button>
                      ))}
                  </div>
                  <RangeControl
                    label="Voice delay (not wired)"
                    description="Adds delay to participant outgoing microphone audio before others hear it."
                    value={controls.synchronyDelayMs}
                    min={0}
                    max={1200}
                    step={50}
                    markers={['Live', 'Lagged', 'Delayed']}
                    neutral={0}
                    onChange={(value) => setControl('synchronyDelayMs', value, 'Applied as a live outgoing microphone delay.')}
                  />
                </details>
              </section>
            </>
          ) : null}

          <div ref={chatPanelRef}>
            <ChatPanel
              messages={chatMessages}
              text={chatText}
              target={chatTarget}
              peers={callPeers}
              isController={isController}
              selfId={callUserIdRef.current}
              onTextChange={setChatText}
              onTargetChange={setChatTarget}
              onSend={() => {
                sendChat().catch((error) =>
                  addLog(error instanceof Error ? error.message : 'Could not send chat message.', 'error')
                )
              }}
            />
          </div>
        </aside>
      </main>
    </div>
  )
}

// Elapsed-time clock shown top-right of the Live Video Conference. Runs while `running` — i.e.
// while both participants are in the room — pauses the moment either one leaves, and resumes from
// where it stopped when both are back (it banks elapsed ms across segments rather than restarting).
// It survives those gaps because the panel stays mounted for the whole experimenter session.
function LiveClock({ running }: { running: boolean }): ReactElement {
  const [seconds, setSeconds] = useState(0)
  const bankedMsRef = useRef(0)
  const segmentStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (!running) return undefined
    segmentStartRef.current = Date.now()
    const tick = (): void => {
      const segMs = segmentStartRef.current ? Date.now() - segmentStartRef.current : 0
      setSeconds(Math.floor((bankedMsRef.current + segMs) / 1000))
    }
    tick()
    const id = window.setInterval(tick, 250)
    return () => {
      window.clearInterval(id)
      if (segmentStartRef.current) {
        bankedMsRef.current += Date.now() - segmentStartRef.current
        segmentStartRef.current = null
      }
      setSeconds(Math.floor(bankedMsRef.current / 1000))
    }
  }, [running])

  const pad = (n: number): string => String(n).padStart(2, '0')
  const hh = Math.floor(seconds / 3600)
  const mm = Math.floor((seconds % 3600) / 60)
  const ss = seconds % 60
  return <span className="live-clock">{hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`}</span>
}

// One tile of the experimenter monitor. Video only (muted) — the experimenter watches all four
// feeds, so playing four audio tracks would be chaos. Shows a placeholder until the feed arrives.
function MonitorVideoCard({ label, stream }: { label: string; stream: MediaStream | null }): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    if (stream) video.play().catch(() => undefined)
  }, [stream])

  return (
    <div className="video-panel">
      <div className="video-label">{label}</div>
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted className="video-surface" />
      ) : (
        <div className="video-empty">(waiting)</div>
      )}
    </div>
  )
}

function RemoteVideoCard({ tile, volume }: { tile: RemoteTile; volume: number }): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.srcObject = tile.stream
    applyMediaElementVolume(videoRef.current, volume)
    videoRef.current.play().catch(() => undefined)
  }, [tile.stream, volume])

  return (
    <div className="video-panel">
      <div className="video-label">{tile.displayName}</div>
      <video ref={videoRef} data-remote-call-video="true" autoPlay playsInline className="video-surface" />
      {tile.stream.getTracks().length === 0 && <div className="video-empty">Connected, waiting for video/audio.</div>}
    </div>
  )
}

function WelcomeScreen({ onStart }: { onStart: () => void }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointerRef = useRef({ x: -9999, y: -9999, targetX: -9999, targetY: -9999 })

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return undefined

    let animationId = 0
    let width = 0
    let height = 0
    let pixelRatio = 1

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.floor(width * pixelRatio))
      canvas.height = Math.max(1, Math.floor(height * pixelRatio))
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    }

    const draw = (time: number): void => {
      const pointer = pointerRef.current
      pointer.x += (pointer.targetX - pointer.x) * 0.34
      pointer.y += (pointer.targetY - pointer.y) * 0.34

      ctx.clearRect(0, 0, width, height)
      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, width * 0.72)
      gradient.addColorStop(0, 'rgba(96, 165, 250, 0.12)')
      gradient.addColorStop(0.45, 'rgba(17, 24, 39, 0.24)')
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)

      const spacing = 18
      const pulse = Math.sin(time / 900) * 0.18 + 0.82
      for (let y = 16; y < height; y += spacing) {
        for (let x = 16; x < width; x += spacing) {
          const dx = x - pointer.x
          const dy = y - pointer.y
          const distance = Math.sqrt(dx * dx + dy * dy)
          const influence = Math.max(0, 1 - distance / 230)
          const wave = Math.sin((x + y + time * 0.035) * 0.045) * 0.12
          const alpha = 0.12 + influence * 0.72 + wave * 0.05
          const radius = 0.9 + influence * 2.65
          ctx.beginPath()
          ctx.fillStyle = `rgba(96, 165, 250, ${Math.min(0.78, alpha * pulse)})`
          ctx.shadowBlur = influence * 18
          ctx.shadowColor = 'rgba(96, 165, 250, 0.58)'
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      ctx.shadowBlur = 0
      animationId = window.requestAnimationFrame(draw)
    }

    const updatePointer = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      pointerRef.current.targetX = event.clientX - rect.left
      pointerRef.current.targetY = event.clientY - rect.top
    }

    const clearPointer = (): void => {
      pointerRef.current.targetX = -9999
      pointerRef.current.targetY = -9999
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', updatePointer)
    window.addEventListener('pointerleave', clearPointer)
    animationId = window.requestAnimationFrame(draw)

    return () => {
      window.cancelAnimationFrame(animationId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', updatePointer)
      window.removeEventListener('pointerleave', clearPointer)
    }
  }, [])

  return (
    <main className="welcome-shell">
      <canvas ref={canvasRef} className="welcome-dots" aria-hidden="true" />
      <section className="welcome-frame">
        <div className="welcome-content">
          <h1>
            <span>Niedenthal</span>
            <em>Emotions Lab</em>
          </h1>
          <p>Live emotion study sessions for research observation, recording, and participant connection.</p>
          <button className="welcome-start" onClick={onStart}>
            Initialize Session
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </section>
    </main>
  )
}

function ChatPanel({
  messages,
  text,
  target,
  peers,
  isController,
  selfId,
  onTextChange,
  onTargetChange,
  onSend
}: {
  messages: ChatMessage[]
  text: string
  target: ChatTarget
  peers: CallPeer[]
  isController: boolean
  selfId: string
  onTextChange: (value: string) => void
  onTargetChange: (value: ChatTarget) => void
  onSend: () => void
}): ReactElement {
  const visiblePeers = peers.filter((peer) => peer.userId !== selfId)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const targetHint =
    target === 'room'
      ? ''
      : target === 'participants'
        ? 'Sending to all participants.'
        : target === 'controllers'
          ? 'Private message to the experimenter.'
          : `Private message to ${visiblePeers.find((peer) => peer.userId === target)?.displayName ?? 'this participant'}.`

  return (
    <section className="panel chat-panel">
      <div className="section-title">Room Chat</div>
      <label>
        Send to
        <select value={target} onChange={(event) => onTargetChange(event.target.value)}>
          <option value="room">Everyone</option>
          {!isController && <option value="controllers">Experimenter</option>}
          {visiblePeers.map((peer) => (
            <option key={peer.userId} value={peer.userId}>
              {peer.displayName}
            </option>
          ))}
        </select>
      </label>
      {targetHint && <p className="chat-target-hint">{targetHint}</p>}
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="muted">No chat messages yet. Use “Send to” above to message everyone or privately.</p>
        ) : (
          messages.map((message) => {
            const audience = chatAudienceFor(message, selfId, peers)
            const mine = message.from === selfId
            return (
              <div
                key={message.id}
                className={`chat-message${mine ? ' self' : ''}${audience.tone === 'private' ? ' private' : ''}`}
              >
                <div className="chat-message-head">
                  <strong>{message.fromName}</strong>
                  <span className={`chat-audience chat-audience-${audience.tone}`}>{audience.label}</span>
                  <span className="chat-time">{new Date(message.sentAt).toLocaleTimeString()}</span>
                </div>
                <p>{message.text}</p>
              </div>
            )
          })
        )}
      </div>
      <div className="chat-compose">
        <input
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSend()
          }}
          placeholder="Type a message"
        />
        <button className="primary" onClick={onSend}>
          Send
        </button>
      </div>
    </section>
  )
}

function InfoButton({
  children,
  className = '',
  description,
  onClick
}: {
  children: ReactNode
  className?: string
  description: string
  onClick: () => void
}): ReactElement {
  return (
    <button className={`info-button ${className}`.trim()} onClick={onClick} title={description}>
      <span className="button-label">{children}</span>
    </button>
  )
}

// A small "i" affordance that shows a styled tooltip on hover/focus. The tooltip is
// position: fixed and positioned from the dot's screen rect, so it can't be clipped by
// the control panel's overflow (the bug with the old absolutely-positioned tooltip).
function InfoDot({ description }: { description: string }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null)
  const [coords, setCoords] = useState<{ left: number; top: number; below: boolean } | null>(null)

  const show = (): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    // Open upward by default, but flip below when the dot is near the top of the screen
    // (e.g. the header heads-up) so the tooltip doesn't get clipped off the top edge.
    const below = rect.top < 170
    // Clamp the (centered) tooltip so it can't spill past the right/left viewport edge when
    // the dot sits near the panel edge. halfMax mirrors .info-tooltip-fixed's max-width.
    const margin = 8
    const halfMax = Math.min(300, window.innerWidth * 0.6) / 2
    const center = rect.left + rect.width / 2
    const left = Math.max(margin + halfMax, Math.min(window.innerWidth - margin - halfMax, center))
    setCoords({ left, top: below ? rect.bottom : rect.top, below })
  }
  const hide = (): void => setCoords(null)

  return (
    <span
      ref={ref}
      className="info-dot"
      tabIndex={0}
      aria-label={description}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      i
      {coords && (
        <span
          className="info-tooltip-fixed"
          role="tooltip"
          style={{
            left: coords.left,
            top: coords.top,
            transform: coords.below ? 'translate(-50%, 10px)' : 'translate(-50%, calc(-100% - 10px))'
          }}
        >
          {description}
        </span>
      )}
    </span>
  )
}

function RangeControl({
  label,
  description,
  value,
  min,
  max,
  step,
  markers,
  neutral,
  onChange
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  markers: string[]
  neutral?: number
  onChange: (value: number) => void
}): ReactElement {
  const neutralPct =
    typeof neutral === 'number' ? Math.max(0, Math.min(100, ((neutral - min) / (max - min)) * 100)) : null
  return (
    <div className="range-control">
      <div className="range-header">
        <span className="label-with-info">
          {label}
          {description && <InfoDot description={description} />}
        </span>
        <strong>{Number.isInteger(value) ? value : value.toFixed(2)}</strong>
      </div>
      <div className="range-track">
        {neutralPct !== null && (
          <span
            className="range-default-tick"
            style={{ left: `${neutralPct}%` }}
            title="Default (no alteration)"
            aria-hidden="true"
          />
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      <div className="range-markers">
        {markers.map((marker) => (
          <span key={marker}>{marker}</span>
        ))}
      </div>
    </div>
  )
}
