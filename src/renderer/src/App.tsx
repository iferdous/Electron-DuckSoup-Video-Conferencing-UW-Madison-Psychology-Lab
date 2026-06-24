import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  CallPeer,
  CallRole,
  CallState,
  ChatMessage,
  ChatTarget,
  ControlEvent,
  LatencyStats,
  LogEvent,
  ManipulationControls,
  RecordingState,
  SessionForm,
  SessionFormat
} from './types'

const hostedSignalUrl = 'https://nelf-call-signaling.onrender.com'

const initialForm: SessionForm = {
  role: 'participant',
  sessionFormat: 'dyad',
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
  smileAlpha: 1,
  faceThreshold: 0.15,
  landmarkBeta: 0.1,
  smoothingCutoff: 5,
  overlay: false,
  audioPreset: 'none',
  audioPitch: 1,
  audioGain: 1,
  partnerVolume: 1,
  synchronyDelayMs: 0
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

type FaceBox = {
  x: number
  y: number
  width: number
  height: number
  score: number
  source: 'native' | 'fallback'
}

type BrowserFaceDetector = {
  detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>
}

type BrowserFaceDetectorConstructor = new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => BrowserFaceDetector

type LiveMediaProcessor = {
  rawStream: MediaStream
  processedStream: MediaStream
  rawVideo: HTMLVideoElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  warpCanvas: HTMLCanvasElement
  warpCtx: CanvasRenderingContext2D
  detectorCanvas: HTMLCanvasElement
  detectorCtx: CanvasRenderingContext2D
  animationId: number
  currentSmileAlpha: number
  faceDetector?: BrowserFaceDetector
  detectedFaceBox?: FaceBox
  smoothedFaceBox?: FaceBox
  facePresence: number
  detectingFace: boolean
  lastFaceDetectionAt: number
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

const appTitle = 'Niedenthal Emotions Lab'
const appSubtitle = 'Live emotion study session'

const roleLabel = (role: CallRole): string => (role === 'controller' ? 'Experimenter' : 'Participant')

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
    label: 'Quieter voice',
    preset: 'quieter',
    effectName: 'volume',
    property: 'volume',
    value: 0.75,
    note: 'Lower outgoing microphone gain.'
  },
  {
    label: 'Louder voice',
    preset: 'louder',
    effectName: 'volume',
    property: 'volume',
    value: 1.25,
    note: 'Higher outgoing microphone gain.'
  }
]

const emptyLatency: LatencyStats = {
  rttMs: null,
  jitterMs: null,
  audioRttMs: null,
  videoRttMs: null,
  packetsLost: 0,
  updatedAt: ''
}

const makeId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

const makeRoomId = (dyadId: string): string => `nelf-${slugify(dyadId, 'room')}-${Date.now().toString(36)}`

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

const controlEventsToCsv = (events: ControlEvent[]): string => {
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
  const rows = events.map((event) =>
    [
      event.timestamp,
      event.elapsedMs,
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
  )
  return [header.join(','), ...rows].join('\n') + '\n'
}

const toMs = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null
}

const latencyFromPeerConnection = async (peer: RTCPeerConnection): Promise<LatencyStats | null> => {
  const report = await peer.getStats()
  let rttMs: number | null = null
  let videoRttMs: number | null = null
  let audioRttMs: number | null = null
  let jitterMs: number | null = null
  let packetsLost = 0

  report.forEach((stat) => {
    const item = stat as RTCStats & {
      state?: string
      nominated?: boolean
      currentRoundTripTime?: number
      roundTripTime?: number
      kind?: string
      mediaType?: string
      jitter?: number
      packetsLost?: number
    }

    if (
      item.type === 'candidate-pair' &&
      item.state === 'succeeded' &&
      item.nominated &&
      typeof item.currentRoundTripTime === 'number'
    ) {
      rttMs = toMs(item.currentRoundTripTime)
    }

    if (item.type === 'remote-inbound-rtp' && typeof item.roundTripTime === 'number') {
      const kind = item.kind ?? item.mediaType
      if (kind === 'video') videoRttMs = toMs(item.roundTripTime)
      if (kind === 'audio') audioRttMs = toMs(item.roundTripTime)
    }

    if (item.type === 'inbound-rtp') {
      if (typeof item.jitter === 'number') jitterMs = toMs(item.jitter)
      if (typeof item.packetsLost === 'number') packetsLost += item.packetsLost
    }
  })

  const rttValues = ([rttMs, videoRttMs, audioRttMs] as Array<number | null>).filter(
    (value): value is number => value !== null
  )
  const averageRtt =
    rttValues.length > 0
      ? Math.round(rttValues.reduce((total, value) => total + value, 0) / rttValues.length)
      : null

  if (averageRtt === null && jitterMs === null && packetsLost === 0) return null

  return {
    rttMs: averageRtt,
    jitterMs,
    audioRttMs,
    videoRttMs,
    packetsLost,
    updatedAt: new Date().toLocaleTimeString()
  }
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

const makeFaceDetector = (): BrowserFaceDetector | undefined => {
  const Detector = (window as typeof window & { FaceDetector?: BrowserFaceDetectorConstructor }).FaceDetector
  if (!Detector) return undefined

  try {
    return new Detector({ fastMode: true, maxDetectedFaces: 1 })
  } catch {
    return undefined
  }
}

const normalizeFaceBox = (
  box: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  score: number,
  source: FaceBox['source']
): FaceBox | null => {
  const x = clamp(box.x, 0, width)
  const y = clamp(box.y, 0, height)
  const boxWidth = clamp(box.width, 0, width - x)
  const boxHeight = clamp(box.height, 0, height - y)

  if (boxWidth < width * 0.1 || boxHeight < height * 0.12) return null
  if (boxWidth > width * 0.92 || boxHeight > height * 0.92) return null
  if (y > height * 0.72) return null

  return { x, y, width: boxWidth, height: boxHeight, score, source }
}

const isLikelySkinPixel = (r: number, g: number, b: number): boolean => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const chromaSkin = cb >= 74 && cb <= 142 && cr >= 132 && cr <= 190
  const rgbSkin =
    r > 35 &&
    g > 25 &&
    b > 18 &&
    max - min > 8 &&
    r >= g * 0.78 &&
    r >= b * 0.72 &&
    g >= b * 0.55
  return chromaSkin && rgbSkin
}

const detectFaceFallback = (processor: LiveMediaProcessor, width: number, height: number): FaceBox | null => {
  const sampleWidth = 160
  const sampleHeight = Math.max(90, Math.round(sampleWidth * (height / width)))
  if (processor.detectorCanvas.width !== sampleWidth || processor.detectorCanvas.height !== sampleHeight) {
    processor.detectorCanvas.width = sampleWidth
    processor.detectorCanvas.height = sampleHeight
  }

  processor.detectorCtx.drawImage(processor.rawVideo, 0, 0, sampleWidth, sampleHeight)
  const data = processor.detectorCtx.getImageData(0, 0, sampleWidth, sampleHeight).data
  const cropTop = Math.round(sampleHeight * 0.04)
  const cropBottom = Math.round(sampleHeight * 0.84)
  let minX = sampleWidth
  let minY = sampleHeight
  let maxX = 0
  let maxY = 0
  let skinCount = 0

  for (let y = cropTop; y < cropBottom; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const index = (y * sampleWidth + x) * 4
      if (!isLikelySkinPixel(data[index], data[index + 1], data[index + 2])) continue

      const centerWeight = 1 - Math.min(1, Math.abs(x / sampleWidth - 0.5) * 1.25)
      if (centerWeight < 0.2) continue

      skinCount += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  const skinArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1))
  const density = skinCount / skinArea
  if (skinCount < sampleWidth * sampleHeight * 0.012 || density < 0.12) return null

  const scaleX = width / sampleWidth
  const scaleY = height / sampleHeight
  const rawX = minX * scaleX
  const rawY = minY * scaleY
  const rawWidth = (maxX - minX + 1) * scaleX
  const rawHeight = (maxY - minY + 1) * scaleY
  const expandedWidth = rawWidth * 1.34
  const expandedHeight = Math.max(rawHeight * 1.55, expandedWidth * 1.08)
  const expandedX = rawX + rawWidth / 2 - expandedWidth / 2
  const expandedY = rawY + rawHeight / 2 - expandedHeight * 0.46

  return normalizeFaceBox(
    {
      x: expandedX,
      y: expandedY,
      width: expandedWidth,
      height: expandedHeight
    },
    width,
    height,
    clamp(density, 0, 1),
    'fallback'
  )
}

const smoothFaceBox = (current: FaceBox | undefined, next: FaceBox, beta: number): FaceBox => {
  if (!current) return next
  const amount = clamp(0.12 + beta * 0.5, 0.12, 0.55)
  return {
    ...next,
    x: current.x + (next.x - current.x) * amount,
    y: current.y + (next.y - current.y) * amount,
    width: current.width + (next.width - current.width) * amount,
    height: current.height + (next.height - current.height) * amount,
    score: current.score + (next.score - current.score) * amount
  }
}

const updateFaceTracking = (processor: LiveMediaProcessor, width: number, height: number, controlState: ManipulationControls): void => {
  const now = performance.now()
  const interval = Math.round(90 + controlState.faceThreshold * 130)

  if (!processor.detectingFace && now - processor.lastFaceDetectionAt > interval) {
    processor.detectingFace = true
    processor.lastFaceDetectionAt = now

    const finish = (face: FaceBox | null): void => {
      if (face && face.score >= 0.08 + controlState.faceThreshold * 0.12) {
        processor.detectedFaceBox = face
        processor.smoothedFaceBox = smoothFaceBox(processor.smoothedFaceBox, face, controlState.landmarkBeta)
        processor.facePresence += (1 - processor.facePresence) * 0.32
      } else {
        processor.detectedFaceBox = undefined
      }
      processor.detectingFace = false
    }

    if (processor.faceDetector) {
      processor.faceDetector
        .detect(processor.rawVideo)
        .then((faces) => {
          const face = faces
            .map((item) => item.boundingBox)
            .map((box) => normalizeFaceBox(box, width, height, 1, 'native'))
            .filter((item): item is FaceBox => item !== null)
            .sort((a, b) => b.width * b.height - a.width * a.height)[0]
          finish(face ?? detectFaceFallback(processor, width, height))
        })
        .catch(() => finish(detectFaceFallback(processor, width, height)))
    } else {
      finish(detectFaceFallback(processor, width, height))
    }
  }

  if (!processor.detectedFaceBox) {
    processor.facePresence += (0 - processor.facePresence) * 0.22
    if (processor.facePresence < 0.04) {
      processor.smoothedFaceBox = undefined
      processor.currentSmileAlpha += (0 - processor.currentSmileAlpha) * 0.24
    }
  }
}

const applySmileWarp = (
  processor: LiveMediaProcessor,
  width: number,
  height: number,
  controlState: ManipulationControls
): void => {
  updateFaceTracking(processor, width, height, controlState)

  const targetAlpha = controlState.smileAlpha - 1
  const smoothing = clamp(0.03 + controlState.landmarkBeta * 0.25 + controlState.smoothingCutoff / 80, 0.03, 0.45)
  processor.currentSmileAlpha += (targetAlpha - processor.currentSmileAlpha) * smoothing

  const face = processor.smoothedFaceBox
  const presence = clamp(processor.facePresence, 0, 1)
  const strength = clamp(processor.currentSmileAlpha, -2.5, 3.2) * presence
  if ((!face || presence < 0.2 || Math.abs(strength) < 0.018) && !controlState.overlay) return

  if (!face) return

  const regionWidth = clamp(face.width * 0.62, width * 0.08, width * 0.44)
  const regionHeight = clamp(face.height * 0.24, height * 0.045, height * 0.18)
  const regionX = clamp(face.x + face.width * 0.5 - regionWidth / 2, 0, width - regionWidth)
  const regionY = clamp(face.y + face.height * 0.56, 0, height - regionHeight)
  const step = Math.max(2, Math.round(regionWidth / 80))
  const maxOffset = clamp(Math.abs(strength) * face.height * 0.024, 0, face.height * 0.065)
  const direction = strength >= 0 ? -1 : 1

  const patchWidth = Math.max(1, Math.round(regionWidth))
  const patchHeight = Math.max(1, Math.round(regionHeight))
  if (processor.warpCanvas.width !== patchWidth || processor.warpCanvas.height !== patchHeight) {
    processor.warpCanvas.width = patchWidth
    processor.warpCanvas.height = patchHeight
  }

  processor.warpCtx.clearRect(0, 0, patchWidth, patchHeight)
  for (let x = 0; x < regionWidth; x += step) {
    const normalizedX = (x / regionWidth - 0.5) * 2
    const cornerWeight = Math.pow(Math.abs(normalizedX), 1.9)
    const centerWeight = Math.max(0, 1 - Math.abs(normalizedX))
    const cheekBlend = Math.pow(Math.max(0, 1 - Math.abs(normalizedX) * 0.55), 2)
    const smileCurve = direction * maxOffset * cornerWeight + -direction * maxOffset * 0.12 * centerWeight
    const verticalFeather = 1 - Math.abs((x / regionWidth - 0.5) * 0.35)
    const dy = smileCurve * verticalFeather
    const sx = Math.round(regionX + x)
    const sw = Math.max(1, Math.min(step + 1, patchWidth - Math.round(x)))
    processor.warpCtx.globalAlpha = 0.68 + cheekBlend * 0.22
    processor.warpCtx.drawImage(
      processor.rawVideo,
      sx,
      regionY,
      sw,
      regionHeight,
      Math.round(x),
      dy,
      sw,
      regionHeight
    )
  }
  processor.warpCtx.globalAlpha = 1
  processor.warpCtx.save()
  processor.warpCtx.globalCompositeOperation = 'destination-in'
  processor.warpCtx.translate(patchWidth / 2, patchHeight / 2)
  processor.warpCtx.scale(patchWidth / 2, patchHeight / 2)
  const mask = processor.warpCtx.createRadialGradient(0, 0, 0.42, 0, 0, 1)
  mask.addColorStop(0, 'rgba(255,255,255,1)')
  mask.addColorStop(0.72, 'rgba(255,255,255,0.88)')
  mask.addColorStop(1, 'rgba(255,255,255,0)')
  processor.warpCtx.fillStyle = mask
  processor.warpCtx.beginPath()
  processor.warpCtx.arc(0, 0, 1, 0, Math.PI * 2)
  processor.warpCtx.fill()
  processor.warpCtx.restore()
  processor.ctx.drawImage(processor.warpCanvas, regionX, regionY)

  if (controlState.overlay) {
    processor.ctx.save()
    processor.ctx.strokeStyle = presence > 0.2 ? '#2aff80' : '#ffb4ab'
    processor.ctx.lineWidth = Math.max(2, width / 360)
    processor.ctx.setLineDash([8, 6])
    processor.ctx.strokeRect(face.x, face.y, face.width, face.height)
    processor.ctx.beginPath()
    processor.ctx.ellipse(regionX + regionWidth / 2, regionY + regionHeight / 2, regionWidth / 2, regionHeight / 2, 0, 0, Math.PI * 2)
    processor.ctx.stroke()
    processor.ctx.fillStyle = 'rgba(5, 8, 7, 0.78)'
    processor.ctx.fillRect(face.x, Math.max(0, face.y - 30), Math.min(420, face.width + 56), 24)
    processor.ctx.fillStyle = presence > 0.2 ? '#b8ffd0' : '#ffdad6'
    processor.ctx.font = `${Math.max(12, Math.round(width / 80))}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    processor.ctx.fillText(
      `face ${face.source} ${(presence * 100).toFixed(0)}% · smile alpha ${controlState.smileAlpha.toFixed(2)}`,
      face.x + 8,
      Math.max(16, face.y - 12)
    )
    processor.ctx.restore()
  }
}

export default function App(): ReactElement {
  const callLocalVideoRef = useRef<HTMLVideoElement>(null)
  const callEventsRef = useRef<EventSource | null>(null)
  const callLocalStreamRef = useRef<MediaStream | null>(null)
  const callUserIdRef = useRef<string>(`station-${makeId()}`)
  const controlsRef = useRef<ManipulationControls>(initialControls)
  const liveMediaProcessorRef = useRef<LiveMediaProcessor | null>(null)
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const remoteStreamsRef = useRef<Map<string, RemoteTile>>(new Map())
  const cleanStreamRef = useRef<MediaStream | null>(null)
  const alteredStreamRef = useRef<MediaStream | null>(null)
  const eventSourceErrorAtRef = useRef(0)
  const clickAudioContextRef = useRef<AudioContext | null>(null)
  const recordingStartRef = useRef<number | null>(null)
  const cleanRecorderRef = useRef<MediaRecorder | null>(null)
  const alteredRecorderRef = useRef<MediaRecorder | null>(null)
  const cleanChunksRef = useRef<Blob[]>([])
  const alteredChunksRef = useRef<Blob[]>([])

  const [setupComplete, setSetupComplete] = useState(false)
  const [welcomeComplete, setWelcomeComplete] = useState(false)
  const [callState, setCallState] = useState<CallState>('idle')
  const [callPeers, setCallPeers] = useState<CallPeer[]>([])
  const [remoteTiles, setRemoteTiles] = useState<RemoteTile[]>([])
  const [signalServer, setSignalServer] = useState<{ active: boolean; localUrl: string; lanUrl: string }>({
    active: false,
    localUrl: '',
    lanUrl: ''
  })
  const [roomPresence, setRoomPresence] = useState<RoomPresence | null>(null)
  const [form, setForm] = useState<SessionForm>(initialForm)
  const [controls, setControls] = useState<ManipulationControls>(initialControls)
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [sessionDir, setSessionDir] = useState<string>('')
  const [showSelfView, setShowSelfView] = useState(true)
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [controlEvents, setControlEvents] = useState<ControlEvent[]>([])
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [latency, setLatency] = useState<LatencyStats>(emptyLatency)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatText, setChatText] = useState('')
  const [chatTarget, setChatTarget] = useState<ChatTarget>('room')
  const [sessionLinkInput, setSessionLinkInput] = useState('')
  const [showAdvancedConnection, setShowAdvancedConnection] = useState(false)
  const [experimenterLoginOpen, setExperimenterLoginOpen] = useState(false)
  const [experimenterCredentials, setExperimenterCredentials] = useState({ username: '', password: '' })
  const [experimenterLoginError, setExperimenterLoginError] = useState('')

  const isController = form.role === 'controller'
  const expectedParticipants = sessionCapacity[form.sessionFormat]
  const participantPeers = useMemo(() => callPeers.filter((peer) => peer.role === 'participant'), [callPeers])
  const activeRoomPeers = callState === 'idle' || callState === 'error' ? roomPresence?.peers ?? [] : callPeers
  const visibleRoomPeers = useMemo(
    () => (isController ? activeRoomPeers : activeRoomPeers.filter((peer) => peer.role !== 'controller')),
    [activeRoomPeers, isController]
  )
  const simpleLatencyMs = latency.rttMs ?? latency.videoRttMs ?? latency.audioRttMs
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
    if (form.dyadId.trim()) url.searchParams.set('dyadId', form.dyadId.trim())
    return url.toString()
  }, [form.callSignalUrl, form.dyadId, form.roomId, form.sessionFormat, form.studyId])

  const addLog = useCallback((message: string, level: LogEvent['level'] = 'info') => {
    setLogs((prev) =>
      [
        {
          id: makeId(),
          timestamp: new Date().toLocaleTimeString(),
          level,
          message
        },
        ...prev
      ].slice(0, 100)
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
    controlsRef.current = controls
    for (const video of document.querySelectorAll<HTMLVideoElement>('video[data-remote-call-video="true"]')) {
      applyMediaElementVolume(video, controls.partnerVolume)
    }
    applyAudioControlsToProcessor(liveMediaProcessorRef.current, controls)
  }, [controls])

  useEffect(() => {
    if (!['waiting', 'connecting', 'connected'].includes(callState)) return undefined

    const interval = window.setInterval(() => {
      const peer = peerConnectionsRef.current.values().next().value as RTCPeerConnection | undefined
      if (!peer) return
      latencyFromPeerConnection(peer)
        .then((nextLatency) => {
          if (nextLatency) setLatency(nextLatency)
        })
        .catch(() => undefined)
    }, 1000)

    return () => window.clearInterval(interval)
  }, [callState])

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

  const generateNewRoom = (): void => {
    const roomId = makeRoomId(form.dyadId)
    updateForm('roomId', roomId)
    addLog(`New meeting ID created: ${roomId}`, 'success')
  }

  const applySessionLink = (value: string): boolean => {
    const trimmed = value.trim()
    if (!trimmed) return false

    try {
      const parsed = parseSessionLink(trimmed)
      setForm((prev) => ({ ...prev, ...parsed }))
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
    setSignalServer({ active: result.ok, localUrl: result.localUrl, lanUrl: result.lanUrl })
    updateForm('callSignalUrl', result.localUrl)
    addLog(`Call server running. Participants can use ${result.lanUrl}.`, 'success')
    return result
  }

  const checkSignalServer = async (): Promise<void> => {
    const result = await window.researchApi.checkCallSignalServer(form.callSignalUrl)
    addLog(result.detail, result.ok ? 'success' : 'error')
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
    (control: string, value: string | number | boolean, notes = '') => {
      const event: ControlEvent = {
        id: makeId(),
        timestamp: new Date().toISOString(),
        elapsedMs: recordingStartRef.current ? Date.now() - recordingStartRef.current : 0,
        roomId: form.roomId,
        participantId: form.participantId,
        partnerId: form.partnerId,
        targetUserId: form.targetUserId || form.participantId,
        condition: form.condition,
        control,
        value,
        appliedToDuckSoup: false,
        notes
      }
      setControlEvents((prev) => [...prev, event])
    },
    [form]
  )

  const broadcastLiveControl = useCallback(
    (key: keyof ManipulationControls, value: ManipulationControls[keyof ManipulationControls]): void => {
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
          payload: { key, value }
        })
      }).catch((error) =>
        addLog(error instanceof Error ? error.message : 'Could not send live control to the room.', 'error')
      )
    },
    [addLog, form.callSignalUrl, form.role, form.roomId]
  )

  const applyRemoteLiveControl = useCallback(
    (payload: unknown, sender = 'Experimenter'): void => {
      if (!payload || typeof payload !== 'object') return
      const update = payload as { key?: keyof ManipulationControls; value?: unknown }
      if (!update.key || !(update.key in initialControls)) return
      if (update.key === 'partnerVolume') return

      setControls((prev) => ({ ...prev, [update.key!]: update.value as never }))
      const loggedValue =
        typeof update.value === 'string' || typeof update.value === 'number' || typeof update.value === 'boolean'
          ? update.value
          : String(update.value)
      appendControlEvent(String(update.key), loggedValue, `Received from ${sender}.`)
      addLog(`${sender} set ${String(update.key)} = ${String(update.value)}.`, 'info')
    },
    [addLog, appendControlEvent]
  )

  const postSignal = async (type: string, payload?: unknown, to?: string): Promise<void> => {
    await fetch(`${signalBaseUrl()}/signal`, {
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

  const handleSignalEvent = async (event: MessageEvent<string>): Promise<void> => {
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
      setCallPeers((prev) => {
        const next = prev.filter((peer) => peer.userId !== envelope.payload!.peer!.userId)
        return [...next, envelope.payload!.peer!]
      })
      addLog(`${envelope.payload.peer.displayName} joined the room.`, 'success')
      maybeOfferToPeer(envelope.payload.peer)
      return
    }

    if (envelope.type === 'peer-left') {
      const userId = envelope.payload?.userId || envelope.payload?.from || envelope.payload?.peer?.userId
      if (userId) {
        peerConnectionsRef.current.get(userId)?.close()
        peerConnectionsRef.current.delete(userId)
        remoteStreamsRef.current.get(userId)?.stream.getTracks().forEach((track) => track.stop())
        remoteStreamsRef.current.delete(userId)
        syncRemoteTiles()
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
    const warpCanvas = document.createElement('canvas')
    const warpCtx = warpCanvas.getContext('2d')
    const detectorCanvas = document.createElement('canvas')
    const detectorCtx = detectorCanvas.getContext('2d', { willReadFrequently: true })
    if (!warpCtx || !detectorCtx) throw new Error('Could not create face tracking processor.')

    const processedStream = new MediaStream()
    const canvasStream = canvas.captureStream(30)
    canvasStream.getVideoTracks().forEach((track) => processedStream.addTrack(track))

    const processor: LiveMediaProcessor = {
      rawStream,
      processedStream,
      rawVideo,
      canvas,
      ctx,
      warpCanvas,
      warpCtx,
      detectorCanvas,
      detectorCtx,
      animationId: 0,
      currentSmileAlpha: 0,
      faceDetector: makeFaceDetector(),
      facePresence: 0,
      detectingFace: false,
      lastFaceDetectionAt: 0
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

  const joinLiveCall = async (): Promise<void> => {
    if (!form.callSignalUrl.trim() || !form.roomId.trim() || !callDisplayName().trim()) {
      addLog('Server URL, meeting ID, and display name are required before joining.', 'error')
      return
    }

    setCallState('starting')
    try {
      const roomReachable = await checkRoomStatus(true)
      if (!roomReachable) {
        throw new Error('Room server is not reachable. Check the server URL before joining.')
      }

      if (!isController) {
        const rawStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: true
        })
        const processor = await createLiveMediaProcessor(rawStream)
        cleanStreamRef.current = rawStream
        alteredStreamRef.current = processor.processedStream
        callLocalStreamRef.current = processor.processedStream
        if (callLocalVideoRef.current) {
          callLocalVideoRef.current.srcObject = processor.processedStream
          await callLocalVideoRef.current.play().catch(() => undefined)
        }
        addLog('Camera and mic started. Experimenter settings now affect your outgoing stream.', 'success')
      }

      const params = new URLSearchParams({
        roomId: form.roomId,
        userId: callUserIdRef.current,
        role: form.role,
        displayName: callDisplayName()
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
      addLog(`${callDisplayName()} joined ${form.roomId}.`, 'success')
    } catch (error) {
      setCallState('error')
      addLog(error instanceof Error ? error.message : 'Could not join the room.', 'error')
    }
  }

  const leaveLiveCall = (): void => {
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
    setLatency(emptyLatency)
    setCallState('idle')
    addLog('Left the room.', 'info')
  }

  const returnToSetup = (): void => {
    if (recordingState === 'recording') {
      addLog('Stop the recording before returning to setup.', 'error')
      return
    }
    if (callState !== 'idle') leaveLiveCall()
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

    setControls((prev) => ({ ...prev, [key]: value }))
    appendControlEvent(String(key), value, notes || 'Applied to participant live stream.')
    broadcastLiveControl(key, value)
    addLog(`${String(key)} = ${value} sent to the room.`, 'info')
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
      session: form,
      controlsAtEnd: controls,
      files: { cleanVideo: cleanPath, alteredVideo: alteredPath },
      notes: [
        'cleanVideo is the local unaltered webcam/microphone stream.',
        'alteredVideo is the outgoing participant stream after live experimenter settings.',
        'manipulation_events.csv contains live setting changes with timestamps relative to recording start.'
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
            targetUserId: form.targetUserId || form.participantId,
            condition: form.condition,
            control: 'recording',
            value: 'stop',
            appliedToDuckSoup: false,
            notes: 'Recording stopped and files saved.'
          }
        ])
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

                <div className="button-row no-margin">
                  <button
                    onClick={() => {
                      setExperimenterLoginOpen(false)
                      setExperimenterLoginError('')
                    }}
                  >
                    Cancel
                  </button>
                  <button className="primary" onClick={submitExperimenterLogin}>
                    Login
                  </button>
                </div>
              </div>
            </section>
          </main>
        </div>
      )
    }

    return (
      <div className="setup-shell">
        <button
          className="welcome-back-button"
          onClick={() => {
            setExperimenterLoginOpen(false)
            setExperimenterLoginError('')
            setWelcomeComplete(false)
          }}
        >
          ‹ Back
        </button>
        <section className="setup-card">
          <div className="setup-header">
            <div>
              <h1>{appTitle}</h1>
              <p>{appSubtitle}</p>
            </div>
            <div className="setup-header-actions">
              <div className="setup-pill">
                {isController ? `Experimenter · ${sessionLabels[form.sessionFormat]}` : 'Participant'}
              </div>
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

          <div className="setup-grid">
            {isController ? (
              <section className="panel">
                <div className="section-title accent">Study Setup</div>
                <div className="format-switch">
                  {(['dyad', 'triad', 'quad'] as SessionFormat[]).map((format) => (
                    <button
                      key={format}
                      className={form.sessionFormat === format ? 'role-button active' : 'role-button'}
                      onClick={() => updateForm('sessionFormat', format)}
                    >
                      {sessionLabels[format]}
                    </button>
                  ))}
                </div>
                <p className="plain-text">
                  Choose the group size here. Participants will only enter the session details and meeting information you give them.
                </p>
              </section>
            ) : (
              <section className="panel">
                <div className="section-title accent">Participant Session</div>
                <p className="plain-text">
                  Enter the details from the experimenter. You do not need to choose a role or study format.
                </p>
                <div className="metric-list no-bottom">
                  <div className="metric">
                    <span>Role</span>
                    <strong>Participant</strong>
                  </div>
                  <div className="metric">
                    <span>Study</span>
                    <strong>{form.studyId}</strong>
                  </div>
                </div>
              </section>
            )}

            <section className="panel">
              <div className="section-title accent">Meeting</div>
              {isController ? (
                <div className="share-card">
                  <span>Participant session link</span>
                  <input value={sessionLink} readOnly />
                  <div className="button-row no-margin">
                    <button className="primary" onClick={() => copySessionLink()}>
                      Copy link
                    </button>
                    <button onClick={() => checkSignalServer()}>Check hosted server</button>
                  </div>
                </div>
              ) : (
                <label>
                  Session link
                  <div className="input-action-row">
                    <input
                      value={sessionLinkInput}
                      onChange={(event) => setSessionLinkInput(event.target.value)}
                      onBlur={() => {
                        if (sessionLinkInput.trim()) applySessionLink(sessionLinkInput)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') applySessionLink(sessionLinkInput)
                      }}
                      placeholder="Paste the link from the experimenter"
                    />
                    <button onClick={() => applySessionLink(sessionLinkInput)}>Use</button>
                  </div>
                </label>
              )}
              <label>
                Meeting ID
                {isController ? (
                  <div className="input-action-row">
                    <input value={form.roomId} onChange={(event) => updateForm('roomId', event.target.value)} />
                    <button onClick={generateNewRoom}>New</button>
                  </div>
                ) : (
                  <input value={form.roomId} onChange={(event) => updateForm('roomId', event.target.value)} />
                )}
              </label>
              <div className="host-summary">
                <span>Hosted call server</span>
                <strong>{form.callSignalUrl}</strong>
              </div>
              <div className="button-row">
                <button onClick={() => checkRoomStatus(false)}>Check room</button>
                <button onClick={() => setShowAdvancedConnection((prev) => !prev)}>
                  {showAdvancedConnection ? 'Hide advanced' : 'Advanced'}
                </button>
              </div>
              {showAdvancedConnection && (
                <div className="advanced-connection">
                  <label>
                    Signal server URL
                    <input
                      value={form.callSignalUrl}
                      onChange={(event) => updateForm('callSignalUrl', event.target.value)}
                      placeholder={hostedSignalUrl}
                    />
                  </label>
                  {isController && isLocalSignalUrl(form.callSignalUrl) && (
                    <div className="button-row no-margin">
                      <button onClick={startSignalServer}>Start local server</button>
                    </div>
                  )}
                  {signalServer.active && (
                    <div className="host-summary">
                      <span>This computer is hosting the room</span>
                      <strong>{signalServer.lanUrl}</strong>
                    </div>
                  )}
                </div>
              )}
              {roomPresence && (
                <div className="room-status-card">
                  <div>
                    <span>Room status</span>
                    <strong>{roomPresence.peers.length} in room</strong>
                  </div>
                  <p>
                    {roomPresence.peers.length === 0
                      ? 'The server is reachable. No one has joined this meeting ID yet.'
                      : roomPresence.peers.map((peer) => `${peer.displayName} (${roleLabel(peer.role)})`).join(', ')}
                  </p>
                </div>
              )}
            </section>

            <section className="panel setup-wide">
              <div className="section-title accent">Session Details</div>
              <div className="field-grid two">
                <label>
                  Display name
                  <input value={form.displayName} onChange={(event) => updateForm('displayName', event.target.value)} />
                </label>
                <label>
                  Study
                  <input value={form.studyId} onChange={(event) => updateForm('studyId', event.target.value)} />
                </label>
                {isController && (
                  <label>
                    RA
                    <input value={form.raId} onChange={(event) => updateForm('raId', event.target.value)} />
                  </label>
                )}
                <label>
                  Dyad/session ID
                  <input value={form.dyadId} onChange={(event) => updateForm('dyadId', event.target.value)} />
                </label>
                <label>
                  This station ID
                  <input value={form.participantId} onChange={(event) => updateForm('participantId', event.target.value)} />
                </label>
                <label>
                  Partner/group ID
                  <input value={form.partnerId} onChange={(event) => updateForm('partnerId', event.target.value)} />
                </label>
              </div>
              {isController && (
                <div className="folder-row">
                  <input value={form.outputFolder} readOnly placeholder="Choose output folder for recordings" />
                  <button className="browse-button" onClick={pickFolder}>
                    Browse
                  </button>
                </div>
              )}
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
          <div className="inline-status">
            <span className={`status-dot status-${callState === 'connected' ? 'connected' : callState === 'error' ? 'error' : callState === 'idle' ? 'idle' : 'connecting'}`} />
            {sessionLabels[form.sessionFormat]} room · {roleLabel(form.role)} · {callState}
          </div>
        </div>
        <div className="topbar-actions">
          {!isController && (
            <div className={`latency-pill ${simpleLatencyMs === null ? 'waiting' : ''}`}>
              <span>Latency</span>
              <strong>{simpleLatencyMs === null ? 'waiting' : `${simpleLatencyMs} ms`}</strong>
            </div>
          )}
          <button onClick={returnToSetup}>Back to setup</button>
          {callState === 'idle' || callState === 'error' ? (
            <button className="primary" onClick={joinLiveCall}>
              Join room
            </button>
          ) : (
            <button className="danger leave-button" onClick={leaveLiveCall}>
              Leave room
            </button>
          )}
        </div>
      </header>

      <main className={isController ? 'workspace controller-workspace' : 'workspace participant-workspace'}>
        <aside className="sidebar">
          <section className="panel">
            <div className="section-title accent">Room</div>
            <div className="metric-list">
              <div className="metric">
                <span>Meeting ID</span>
                <strong>{form.roomId}</strong>
              </div>
              <div className="metric">
                <span>Connection</span>
                <strong>{isLocalSignalUrl(form.callSignalUrl) ? form.callSignalUrl : 'Hosted room link'}</strong>
              </div>
              <div className="metric">
                <span>Expected participants</span>
                <strong>{participantPeers.length}/{expectedParticipants}</strong>
              </div>
            </div>
            <div className="button-row">
              <button onClick={checkSignalServer}>Check server</button>
              <button onClick={() => checkRoomStatus(false)}>Check room</button>
              {isController && <button onClick={() => copySessionLink()}>Copy link</button>}
              {isController && isLocalSignalUrl(form.callSignalUrl) && <button onClick={startSignalServer}>Start server</button>}
            </div>
            <div className="room-action-stack">
              {callState === 'idle' || callState === 'error' ? (
                <button className="primary wide-button" onClick={joinLiveCall}>
                  Join this room
                </button>
              ) : (
                <button className="danger wide-button" onClick={leaveLiveCall}>
                  Leave this room
                </button>
              )}
              <button className="wide-button" onClick={returnToSetup}>
                Back to setup
              </button>
            </div>
            <div className="participant-strip">
              {visibleRoomPeers.length === 0 ? (
                <span>No one else is in this room yet.</span>
              ) : (
                visibleRoomPeers.map((peer) => (
                  <span key={`${peer.userId}-${peer.role}`}>
                    {peer.displayName} · {roleLabel(peer.role)}
                  </span>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="section-title">Recording</div>
            <div className="button-row no-margin">
              <button onClick={startRecording} disabled={recordingState !== 'idle' || isController} className="record">
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
              Recordings stay as .webm. Each participant station saves its own clean video, altered video, session file, and control timing CSV.
            </p>
          </section>

          <section className="panel">
            <div className="section-title">Session Details</div>
            <div className="metric-list">
              <div className="metric">
                <span>Study</span>
                <strong>{form.studyId}</strong>
              </div>
              <div className="metric">
                <span>RA</span>
                <strong>{form.raId || 'not set'}</strong>
              </div>
              <div className="metric">
                <span>Station</span>
                <strong>{form.participantId}</strong>
              </div>
            </div>
          </section>
        </aside>

        <section className="center-stage">
          <section className="panel call-panel">
            <div className="section-title accent">Live Video Conference</div>
            <div className={`conference-grid tiles-${Math.min(remoteTiles.length + (isController ? 0 : 1), 4)}`}>
              {!isController && (
                <div className="video-panel">
                  <div className="video-label">Self view · {callDisplayName()}</div>
                  <video
                    ref={callLocalVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className={showSelfView ? 'video-surface' : 'video-surface hidden-preview'}
                  />
                  {!showSelfView && <div className="video-empty">Self view is hidden. Camera and mic are still on.</div>}
                  {callState === 'idle' && <div className="video-empty">Join the room to start your camera.</div>}
                  <button className="overlay-button" onClick={() => setShowSelfView((prev) => !prev)}>
                    {showSelfView ? 'Hide self view' : 'Show self view'}
                  </button>
                </div>
              )}

              {remoteTiles.map((tile) => (
                <RemoteVideoCard key={tile.userId} tile={tile} volume={controls.partnerVolume} />
              ))}

              {remoteTiles.length === 0 && (
                <div className="video-panel">
                  <div className="video-label">Waiting room</div>
                  <div className="video-empty">
                    {isController
                      ? 'Join as experimenter to keep chat and controls available while participants enter the same meeting ID.'
                      : 'Waiting for another participant in this meeting ID.'}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="panel log-panel">
            <div className="section-title">Event Log</div>
            <div className="log-list">
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
        </section>

        <aside className="controls">
          {isController ? (
            <>
              <section className="panel">
                <div className="section-title accent">Face Modulation</div>
                <RangeControl
                  label="Smile alpha"
                  description="Controls the live smile/frown deformation sent to participant machines. 1.00 is neutral, higher moves toward a smile, lower moves toward a frown."
                  value={controls.smileAlpha}
                  min={-2}
                  max={5}
                  step={0.1}
                  markers={['Frown', 'Neutral', 'Smile']}
                  onChange={(value) => setControl('smileAlpha', value)}
                />
                <RangeControl
                  label="Detection threshold"
                  description="How strict the face effect should be before applying. Lower is more forgiving in poor lighting; higher can reduce accidental background warping."
                  value={controls.faceThreshold}
                  min={0}
                  max={1}
                  step={0.05}
                  markers={['Sensitive', 'Default', 'Strict']}
                  onChange={(value) => setControl('faceThreshold', value)}
                />
                <RangeControl
                  label="Landmark beta"
                  description="How quickly the face warp follows movement. Lower is steadier; higher reacts faster but can look jumpier."
                  value={controls.landmarkBeta}
                  min={0}
                  max={1}
                  step={0.05}
                  markers={['Stable', 'Default', 'Fast']}
                  onChange={(value) => setControl('landmarkBeta', value)}
                />
                <RangeControl
                  label="Smoothing cutoff"
                  description="How much smoothing is applied over time. Lower is smoother/slower; higher is more immediate."
                  value={controls.smoothingCutoff}
                  min={0}
                  max={20}
                  step={0.5}
                  markers={['Smooth', 'Default', 'Responsive']}
                  onChange={(value) => setControl('smoothingCutoff', value)}
                />
                <label className="toggle-row">
                  <span>Debug overlay</span>
                  <input
                    type="checkbox"
                    checked={controls.overlay}
                    onChange={(event) => setControl('overlay', event.target.checked)}
                  />
                </label>
              </section>

              <section className="panel">
                <div className="section-title">Voice / Synchrony</div>
                <div className="preset-list compact">
                  {audioPresets.map((preset) => (
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
                  label="Partner playback volume"
                  description="Changes how loud the other people sound on this computer only. It does not change what they hear and is not sent across the room."
                  value={controls.partnerVolume}
                  min={0}
                  max={1}
                  step={0.05}
                  markers={['Muted', 'Half', 'Full']}
                  onChange={(value) => setControl('partnerVolume', value, 'Local playback volume only.')}
                />
                <RangeControl
                  label="Outgoing voice tone"
                  description="Changes participant outgoing microphone tone. Lower sounds warmer/deeper, higher sounds brighter."
                  value={controls.audioPitch}
                  min={0.6}
                  max={1.4}
                  step={0.02}
                  markers={['Deeper', 'Neutral', 'Brighter']}
                  onChange={(value) => {
                    setControls((prev) => ({ ...prev, audioPreset: 'custom-pitch', audioPitch: value }))
                    appendControlEvent('audioTone', value, 'Applied to outgoing participant microphone audio.')
                    broadcastLiveControl('audioPreset', 'custom-pitch')
                    broadcastLiveControl('audioPitch', value)
                    addLog(`Outgoing voice tone = ${value.toFixed(2)} sent to participants.`, 'info')
                  }}
                />
                <RangeControl
                  label="Outgoing voice gain"
                  description="Changes how loud participant microphones are for others. This is the louder/quieter voice control."
                  value={controls.audioGain}
                  min={0}
                  max={2}
                  step={0.05}
                  markers={['Muted', 'Neutral', 'Boosted']}
                  onChange={(value) => {
                    setControls((prev) => ({ ...prev, audioPreset: 'custom-volume', audioGain: value }))
                    appendControlEvent('audioGain', value, 'Applied to outgoing participant microphone audio.')
                    broadcastLiveControl('audioPreset', 'custom-volume')
                    broadcastLiveControl('audioGain', value)
                    addLog(`Outgoing voice gain = ${value.toFixed(2)} sent to participants.`, 'info')
                  }}
                />
                <RangeControl
                  label="Voice delay (ms)"
                  description="Adds delay to participant outgoing microphone audio before others hear it."
                  value={controls.synchronyDelayMs}
                  min={0}
                  max={1200}
                  step={50}
                  markers={['Live', 'Lagged', 'Delayed']}
                  onChange={(value) => setControl('synchronyDelayMs', value, 'Applied as a live outgoing microphone delay.')}
                />
              </section>
            </>
          ) : (
            <section className="panel">
              <div className="section-title accent">Participant View</div>
              <p className="plain-text">
                The experimenter manages the study settings. Keep this window open and use chat if anything is not working.
              </p>
              <button className="wide-button" onClick={() => setShowSelfView((prev) => !prev)}>
                {showSelfView ? 'Hide self view' : 'Show self view'}
              </button>
            </section>
          )}

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

          {isController && (
            <section className="panel">
              <div className="section-title">Latency Viewer</div>
              <div className="analysis-list">
                <div>
                  <strong>Round trip</strong>
                  <span>{latency.rttMs === null ? 'waiting' : `${latency.rttMs} ms`}</span>
                </div>
                <div>
                  <strong>Video RTT</strong>
                  <span>{latency.videoRttMs === null ? 'waiting' : `${latency.videoRttMs} ms`}</span>
                </div>
                <div>
                  <strong>Audio RTT</strong>
                  <span>{latency.audioRttMs === null ? 'waiting' : `${latency.audioRttMs} ms`}</span>
                </div>
                <div>
                  <strong>Jitter</strong>
                  <span>{latency.jitterMs === null ? 'waiting' : `${latency.jitterMs} ms`}</span>
                </div>
                <div>
                  <strong>Packets lost</strong>
                  <span>{latency.packetsLost}</span>
                </div>
                <div>
                  <strong>Updated</strong>
                  <span>{latency.updatedAt || 'waiting'}</span>
                </div>
              </div>
            </section>
          )}
        </aside>
      </main>
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
      <div className="video-label">
        {tile.displayName} · {roleLabel(tile.role)}
      </div>
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
      gradient.addColorStop(0, 'rgba(31, 190, 126, 0.16)')
      gradient.addColorStop(0.45, 'rgba(6, 28, 24, 0.22)')
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
          ctx.fillStyle = `rgba(79, 219, 200, ${Math.min(0.88, alpha * pulse)})`
          ctx.shadowBlur = influence * 18
          ctx.shadowColor = 'rgba(42, 255, 128, 0.8)'
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

  return (
    <section className="panel chat-panel">
      <div className="section-title">Room Chat</div>
      <label>
        Send to
        <select value={target} onChange={(event) => onTargetChange(event.target.value)}>
          <option value="room">Everyone</option>
          {isController ? <option value="participants">All participants</option> : <option value="controllers">Experimenter</option>}
          {visiblePeers.map((peer) => (
            <option key={peer.userId} value={peer.userId}>
              {peer.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="chat-list">
        {messages.length === 0 ? (
          <p className="muted">No chat messages yet.</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.from === selfId ? 'chat-message self' : 'chat-message'}>
              <div>
                <strong>{message.fromName}</strong>
                <span>{new Date(message.sentAt).toLocaleTimeString()}</span>
              </div>
              <p>{message.text}</p>
            </div>
          ))
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

function RangeControl({
  label,
  description,
  value,
  min,
  max,
  step,
  markers,
  onChange
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  markers: string[]
  onChange: (value: number) => void
}): ReactElement {
  return (
    <div className="range-control">
      <div className="range-header">
        <span className="label-with-info">
          {label}
          {description && (
            <span className="info-dot" title={description} aria-label={description} tabIndex={0}>
              i
              <span className="info-tooltip" role="tooltip">
                {description}
              </span>
            </span>
          )}
        </span>
        <strong>{Number.isInteger(value) ? value : value.toFixed(2)}</strong>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="range-markers">
        {markers.map((marker) => (
          <span key={marker}>{marker}</span>
        ))}
      </div>
    </div>
  )
}
