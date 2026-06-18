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

const initialForm: SessionForm = {
  role: 'participant',
  sessionFormat: 'dyad',
  serverName: 'Mac DuckSoup Host',
  studyId: 'PPS2026',
  raId: '',
  dyadId: '',
  displayName: 'Participant',
  participantId: 'P001',
  partnerId: 'P002',
  roomId: `pps-room-${Date.now()}`,
  targetUserId: '',
  duckSoupUrl: 'http://localhost:8100',
  callSignalUrl: 'http://localhost:8765',
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

const makeRoomId = (dyadId: string): string => `pps-${slugify(dyadId, 'room')}-${Date.now().toString(36)}`

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const browserVolume = (value: number): number => clamp(Number.isFinite(value) ? value : 1, 0, 1)

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

  const rttValues = [rttMs, videoRttMs, audioRttMs].filter((value): value is number => value !== null)
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

const applySmileWarp = (
  processor: LiveMediaProcessor,
  width: number,
  height: number,
  controlState: ManipulationControls
): void => {
  const targetAlpha = controlState.smileAlpha - 1
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
    processor.ctx.strokeStyle = Math.abs(strength) > 0.02 ? '#22d3ee' : '#f59e0b'
    processor.ctx.lineWidth = Math.max(2, width / 360)
    processor.ctx.setLineDash([8, 6])
    processor.ctx.strokeRect(regionX, regionY, regionWidth, regionHeight)
    processor.ctx.fillStyle = 'rgba(2, 6, 23, 0.72)'
    processor.ctx.fillRect(regionX, regionY - 28, Math.min(360, regionWidth), 24)
    processor.ctx.fillStyle = '#bae6fd'
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

  const isController = form.role === 'controller'
  const expectedParticipants = sessionCapacity[form.sessionFormat]
  const participantPeers = useMemo(() => callPeers.filter((peer) => peer.role === 'participant'), [callPeers])
  const controllerPeers = useMemo(() => callPeers.filter((peer) => peer.role === 'controller'), [callPeers])
  const visibleRoomPeers = callState === 'idle' || callState === 'error' ? roomPresence?.peers ?? [] : callPeers

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
    const fallback = isController ? 'Controller' : 'Participant'
    return form.displayName.trim() || (isController && form.raId ? `Controller ${form.raId}` : fallback)
  }

  const generateNewRoom = (): void => {
    const roomId = makeRoomId(form.dyadId)
    updateForm('roomId', roomId)
    addLog(`New meeting ID created: ${roomId}`, 'success')
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
    async (quiet = false): Promise<boolean> => {
      if (!form.callSignalUrl.trim() || !form.roomId.trim()) {
        if (!quiet) addLog('Enter a call server URL and meeting ID before checking the room.', 'error')
        return false
      }

      try {
        const url = new URL('/room', signalBaseUrl())
        url.searchParams.set('roomId', form.roomId.trim())
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
    (payload: unknown, sender = 'Controller'): void => {
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
    remoteStreamsRef.current.set(targetUserId, {
      userId: targetUserId,
      displayName: peerMeta?.displayName || targetUserId,
      role: peerMeta?.role || 'participant',
      stream: remoteStream
    })
    syncRemoteTiles()

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
      setCallPeers(peers)
      if (peers.some((peer) => peer.userId !== callUserIdRef.current)) setCallState('connecting')
      peers.forEach(maybeOfferToPeer)
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
        applyRemoteLiveControl(envelope.payload?.payload, envelope.payload?.displayName || 'Controller')
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
    const peerMeta = callPeers.find((item) => item.userId === from)
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
        addLog('Camera and mic started. Controller settings now affect your outgoing stream.', 'success')
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
      addLog('Select an output folder before recording.', 'error')
      return
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
        'alteredVideo is the outgoing participant stream after live controller settings.',
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
    if (!form.roomId.trim()) {
      addLog('Create or enter a meeting ID before continuing.', 'error')
      return
    }
    if (!form.callSignalUrl.trim()) {
      addLog('Enter the call server URL before continuing.', 'error')
      return
    }

    if (isController) {
      const result = await startSignalServer()
      if (!result.ok) return
    } else {
      const reachable = await checkRoomStatus(false)
      if (!reachable) return
    }

    setSetupComplete(true)
  }

  if (!setupComplete) {
    return (
      <div className="setup-shell">
        <section className="setup-card">
          <div className="setup-header">
            <div>
              <h1>DuckSoup Conference Lab</h1>
              <p>Set up the study room before anyone joins the live call.</p>
            </div>
            <div className="setup-pill">{sessionLabels[form.sessionFormat]}</div>
          </div>

          <div className="setup-grid">
            <section className="panel">
              <div className="section-title accent">1. Choose Role</div>
              <div className="role-switch">
                <button
                  className={form.role === 'participant' ? 'role-button active' : 'role-button'}
                  onClick={() => updateForm('role', 'participant')}
                >
                  Participant
                </button>
                <button
                  className={form.role === 'controller' ? 'role-button active' : 'role-button'}
                  onClick={() => updateForm('role', 'controller')}
                >
                  Controller
                </button>
              </div>
              <p className="plain-text">
                Participants only see the call, chat, recording, and self-view controls. Controllers see the study controls and can change live face and voice settings.
              </p>
            </section>

            <section className="panel">
              <div className="section-title accent">2. Study Format</div>
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
                Dyad expects 2 participants, triad expects 3, and quad expects 4. The controller can join without a camera.
              </p>
            </section>

            <section className="panel">
              <div className="section-title accent">3. Meeting</div>
              <label>
                Meeting ID
                <div className="input-action-row">
                  <input value={form.roomId} onChange={(event) => updateForm('roomId', event.target.value)} />
                  <button onClick={generateNewRoom}>New</button>
                </div>
              </label>
              <label>
                Call server URL
                <input
                  value={form.callSignalUrl}
                  onChange={(event) => updateForm('callSignalUrl', event.target.value)}
                  placeholder="Mac: http://localhost:8765, Windows: http://Mac-IP:8765"
                />
              </label>
              {isController && (
                <div className="button-row">
                  <button onClick={startSignalServer}>Start server here</button>
                </div>
              )}
              <div className="button-row">
                <button onClick={() => checkSignalServer()}>Check server</button>
                <button onClick={() => checkRoomStatus(false)}>Check room</button>
              </div>
              {signalServer.active && (
                <div className="host-summary">
                  <span>This computer is hosting the room</span>
                  <strong>{signalServer.lanUrl}</strong>
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
                      : roomPresence.peers.map((peer) => `${peer.displayName} (${peer.role})`).join(', ')}
                  </p>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="section-title accent">4. Session Details</div>
              <div className="field-grid two">
                <label>
                  Display name
                  <input value={form.displayName} onChange={(event) => updateForm('displayName', event.target.value)} />
                </label>
                <label>
                  Study
                  <input value={form.studyId} onChange={(event) => updateForm('studyId', event.target.value)} />
                </label>
                <label>
                  RA
                  <input value={form.raId} onChange={(event) => updateForm('raId', event.target.value)} />
                </label>
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
              <div className="folder-row">
                <input value={form.outputFolder} readOnly placeholder="Choose output folder for recordings" />
                <button className="browse-button" onClick={pickFolder}>
                  Browse
                </button>
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
          <h1>DuckSoup Conference Lab</h1>
          <div className="inline-status">
            <span className={`status-dot status-${callState === 'connected' ? 'connected' : callState === 'error' ? 'error' : callState === 'idle' ? 'idle' : 'connecting'}`} />
            {sessionLabels[form.sessionFormat]} room · {isController ? 'Controller' : 'Participant'} · {callState}
          </div>
        </div>
        <div className="topbar-actions">
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
                <span>Server</span>
                <strong>{form.callSignalUrl}</strong>
              </div>
              <div className="metric">
                <span>Expected participants</span>
                <strong>{participantPeers.length}/{expectedParticipants}</strong>
              </div>
            </div>
            <div className="button-row">
              <button onClick={checkSignalServer}>Check server</button>
              <button onClick={() => checkRoomStatus(false)}>Check room</button>
              {isController && <button onClick={startSignalServer}>Start server</button>}
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
                    {peer.displayName} · {peer.role}
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
                      ? 'Join as controller, then participants will appear here as they enter the same meeting ID.'
                      : 'Waiting for another participant or controller in this meeting ID.'}
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
                The controller manages face and voice settings. Keep this window open, use chat for issues, and record only when the study protocol tells you to.
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
        {tile.displayName} · {tile.role}
      </div>
      <video ref={videoRef} data-remote-call-video="true" autoPlay playsInline className="video-surface" />
      {tile.stream.getTracks().length === 0 && <div className="video-empty">Connected, waiting for video/audio.</div>}
    </div>
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
          {isController ? <option value="participants">All participants</option> : <option value="controllers">Control room</option>}
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
