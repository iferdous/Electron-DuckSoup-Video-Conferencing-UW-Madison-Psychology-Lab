import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ConnectionState,
  ControlEvent,
  LatencyStats,
  LocalNetworkInfo,
  LogEvent,
  ManipulationControls,
  RecordingState,
  SessionForm
} from './types'

const initialForm: SessionForm = {
  studyId: 'PPS2026',
  raId: '',
  dyadId: '',
  participantId: '',
  partnerId: '',
  roomId: `pps-room-${Date.now()}`,
  targetUserId: '',
  duckSoupUrl: 'http://localhost:8100',
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

type DuckSoupPlayerHandle = Awaited<ReturnType<NonNullable<Window['DuckSoup']>['render']>>

const conditionPresets: Array<{ label: string; alpha: number; threshold?: number; note: string }> = [
  { label: 'Neutral / Sham', alpha: 1, note: 'No intended smile/frown shift.' },
  { label: 'Smile + subtle', alpha: 0.6, note: 'Naturalistic positive shift from Mozza notes.' },
  { label: 'Smile + strong', alpha: 1.8, note: 'Stronger positive shift for pilot testing.' },
  { label: 'Smile - subtle', alpha: -0.6, note: 'Subtle frown/opposite-direction deformation.' },
  { label: 'Smile - strong', alpha: -1.5, note: 'Stronger frown/opposite-direction deformation.' },
  { label: 'Low confidence lighting', alpha: 1, threshold: 0.05, note: 'More sensitive face detection.' },
  { label: 'Strict tracking', alpha: 1, threshold: 0.55, note: 'Rejects weaker detections.' }
]

const audioPresets: Array<{
  label: string
  preset: string
  effectName: 'pitch' | 'volume' | ''
  property: string
  value: number
  audioFx: string
  note: string
}> = [
  {
    label: 'Voice neutral',
    preset: 'none',
    effectName: '',
    property: '',
    value: 1,
    audioFx: '',
    note: 'No DuckSoup audio effect requested.'
  },
  {
    label: 'Warmer voice',
    preset: 'warmer',
    effectName: 'pitch',
    property: 'pitch',
    value: 0.92,
    audioFx: 'pitch pitch=0.92',
    note: 'DuckSoup audioFx preset using the pitch effect.'
  },
  {
    label: 'Brighter voice',
    preset: 'brighter',
    effectName: 'pitch',
    property: 'pitch',
    value: 1.08,
    audioFx: 'pitch pitch=1.08',
    note: 'DuckSoup audioFx preset using the pitch effect.'
  },
  {
    label: 'Quieter voice',
    preset: 'quieter',
    effectName: 'volume',
    property: 'volume',
    value: 0.75,
    audioFx: 'volume volume=0.75',
    note: 'DuckSoup audioFx preset using a GStreamer volume element.'
  },
  {
    label: 'Louder voice',
    preset: 'louder',
    effectName: 'volume',
    property: 'volume',
    value: 1.25,
    audioFx: 'volume volume=1.25',
    note: 'DuckSoup audioFx preset using a GStreamer volume element.'
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

const buildDuckSoupScriptUrl = (baseUrl: string): string => {
  const url = new URL('/assets/v1.93/js/ducksoup.js', baseUrl)
  return url.toString()
}

const buildSignalingUrl = (baseUrl: string): string => {
  const url = new URL('/ws', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const selectedAudioFx = (controlState: ManipulationControls): string | undefined => {
  if (controlState.audioPreset === 'custom-pitch') {
    return `pitch pitch=${controlState.audioPitch}`
  }
  if (controlState.audioPreset === 'custom-volume') {
    return `volume volume=${controlState.audioGain}`
  }
  const match = audioPresets.find((item) => item.preset === controlState.audioPreset)
  return match?.audioFx || undefined
}

const toMs = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null
}

const readPacketsLost = (stats: Record<string, unknown> | undefined): number => {
  return typeof stats?.packetsLost === 'number' ? stats.packetsLost : 0
}

const latencyFromStats = (payload: unknown): LatencyStats | null => {
  if (!payload || typeof payload !== 'object') return null
  const stats = payload as {
    remoteInboundRTPVideo?: Record<string, unknown>
    remoteInboundRTPAudio?: Record<string, unknown>
    inboundRTPVideo?: Record<string, unknown>
    inboundRTPAudio?: Record<string, unknown>
  }
  const videoRttMs = toMs(stats.remoteInboundRTPVideo?.roundTripTime)
  const audioRttMs = toMs(stats.remoteInboundRTPAudio?.roundTripTime)
  const jitterMs = toMs(stats.inboundRTPVideo?.jitter) ?? toMs(stats.inboundRTPAudio?.jitter)
  const rttValues = [videoRttMs, audioRttMs].filter((value): value is number => value !== null)
  const rttMs =
    rttValues.length > 0
      ? Math.round(rttValues.reduce((total, value) => total + value, 0) / rttValues.length)
      : null

  return {
    rttMs,
    jitterMs,
    audioRttMs,
    videoRttMs,
    packetsLost:
      readPacketsLost(stats.remoteInboundRTPVideo) +
      readPacketsLost(stats.remoteInboundRTPAudio) +
      readPacketsLost(stats.inboundRTPVideo) +
      readPacketsLost(stats.inboundRTPAudio),
    updatedAt: new Date().toLocaleTimeString()
  }
}

const supportedRecorderType = (): string => {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

export default function App(): ReactElement {
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const localDiagnosticVideoRef = useRef<HTMLVideoElement>(null)
  const cleanStreamRef = useRef<MediaStream | null>(null)
  const alteredStreamRef = useRef<MediaStream | null>(null)
  const playerRef = useRef<DuckSoupPlayerHandle | null>(null)
  const recordingStartRef = useRef<number | null>(null)
  const cleanRecorderRef = useRef<MediaRecorder | null>(null)
  const alteredRecorderRef = useRef<MediaRecorder | null>(null)
  const cleanChunksRef = useRef<Blob[]>([])
  const alteredChunksRef = useRef<Blob[]>([])

  const [form, setForm] = useState<SessionForm>(initialForm)
  const [controls, setControls] = useState<ManipulationControls>(initialControls)
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [sessionDir, setSessionDir] = useState<string>('')
  const [duckSoupReady, setDuckSoupReady] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [logs, setLogs] = useState<LogEvent[]>([])
  const [controlEvents, setControlEvents] = useState<ControlEvent[]>([])
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [latency, setLatency] = useState<LatencyStats>(emptyLatency)
  const [networkInfo, setNetworkInfo] = useState<LocalNetworkInfo>({ hostname: '', addresses: [] })

  const statusLabel = useMemo(() => {
    const labels: Record<ConnectionState, string> = {
      idle: 'Not checked',
      checking: 'Checking DuckSoup',
      ready: 'Server reachable',
      connecting: 'Joining room',
      connected: 'Connected',
      error: 'Needs attention'
    }
    return labels[connectionState]
  }, [connectionState])

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
      ].slice(0, 80)
    )
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (recordingStartRef.current) {
        setRecordingSeconds(Math.floor((Date.now() - recordingStartRef.current) / 1000))
      }
    }, 500)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    window.researchApi
      .getNetworkInfo()
      .then(setNetworkInfo)
      .catch(() => setNetworkInfo({ hostname: '', addresses: [] }))
  }, [])

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.volume = Math.min(Math.max(controls.partnerVolume, 0), 2)
    }
  }, [controls.partnerVolume])

  const updateForm = (field: keyof SessionForm, value: string): void => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const loadDuckSoupScript = useCallback(async () => {
    if (window.DuckSoup) {
      setDuckSoupReady(true)
      return
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-ducksoup-client]')
    if (existing) existing.remove()

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.dataset.ducksoupClient = 'true'
      script.src = buildDuckSoupScriptUrl(form.duckSoupUrl)
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error(`Could not load ${script.src}`))
      document.head.appendChild(script)
    })

    if (!window.DuckSoup) {
      throw new Error('DuckSoup script loaded, but window.DuckSoup was not registered.')
    }
    setDuckSoupReady(true)
  }, [form.duckSoupUrl])

  const checkDuckSoup = useCallback(async () => {
    setConnectionState('checking')
    setDuckSoupReady(false)
    try {
      const result = await window.researchApi.checkDuckSoup(form.duckSoupUrl)
      if (!result.ok) {
        setConnectionState('error')
        addLog(result.detail, 'error')
        return
      }
      await loadDuckSoupScript()
      setConnectionState('ready')
      addLog('DuckSoup server and client script are reachable.', 'success')
    } catch (error) {
      setConnectionState('error')
      addLog(error instanceof Error ? error.message : 'DuckSoup check failed.', 'error')
    }
  }, [addLog, form.duckSoupUrl, loadDuckSoupScript])

  const appendControlEvent = useCallback(
    (control: string, value: string | number | boolean, appliedToDuckSoup: boolean, notes = '') => {
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
        appliedToDuckSoup,
        notes
      }
      setControlEvents((prev) => [...prev, event])
    },
    [form]
  )

  const sendDuckSoupControl = useCallback(
    (property: string, value: number | boolean, notes = '', effectName = 'mozza') => {
      const normalizedValue = typeof value === 'boolean' ? (value ? 1 : 0) : value
      const targetUser = form.targetUserId || form.participantId
      if (playerRef.current) {
        playerRef.current.controlFx(effectName, property, normalizedValue, undefined, targetUser)
        appendControlEvent(`${effectName}.${property}`, value, true, notes)
        addLog(`Applied ${effectName}.${property} = ${value} to ${targetUser || 'current user'}.`, 'info')
      } else {
        appendControlEvent(`${effectName}.${property}`, value, false, 'Queued/logged before DuckSoup connection. ' + notes)
        addLog(`Logged ${effectName}.${property} = ${value}; connect before it can be applied live.`, 'warn')
      }
    },
    [addLog, appendControlEvent, form.participantId, form.targetUserId]
  )

  const setControl = <K extends keyof ManipulationControls>(
    key: K,
    value: ManipulationControls[K],
    duckSoupProperty?: string,
    notes?: string
  ): void => {
    setControls((prev) => ({ ...prev, [key]: value }))
    if (duckSoupProperty) {
      sendDuckSoupControl(duckSoupProperty, value as number | boolean, notes)
    } else {
      appendControlEvent(String(key), value, false, notes)
    }
  }

  const applyPreset = (preset: (typeof conditionPresets)[number]): void => {
    updateForm('condition', preset.label)
    setControls((prev) => ({
      ...prev,
      smileAlpha: preset.alpha,
      faceThreshold: preset.threshold ?? prev.faceThreshold
    }))
    sendDuckSoupControl('alpha', preset.alpha, preset.note)
    if (typeof preset.threshold === 'number') sendDuckSoupControl('face-thresh', preset.threshold, preset.note)
  }

  const applyAudioPreset = (preset: (typeof audioPresets)[number]): void => {
    setControls((prev) => ({
      ...prev,
      audioPreset: preset.preset,
      audioPitch: preset.effectName === 'pitch' ? preset.value : prev.audioPitch,
      audioGain: preset.effectName === 'volume' ? preset.value : prev.audioGain
    }))

    if (preset.effectName) {
      sendDuckSoupControl(preset.property, preset.value, preset.note, preset.effectName)
    } else {
      appendControlEvent('audioFx', 'none', false, preset.note)
      addLog('Audio preset set to neutral. Reconnect to remove an active DuckSoup audio effect.', 'info')
    }
  }

  const connect = useCallback(async () => {
    try {
      const stationId = form.participantId.trim()
      const partnerId = form.partnerId.trim()
      if (!stationId) {
        setConnectionState('error')
        addLog('Enter a unique This station ID before connecting, for example P001 or P002.', 'error')
        return
      }
      if (partnerId && stationId === partnerId) {
        setConnectionState('error')
        addLog('This station ID and Partner ID must be different. DuckSoup rejects duplicate users in the same room.', 'error')
        return
      }

      setConnectionState('connecting')
      setLatency(emptyLatency)
      await loadDuckSoupScript()

      const cleanStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true
      })
      cleanStreamRef.current = cleanStream
      if (localDiagnosticVideoRef.current) {
        localDiagnosticVideoRef.current.srcObject = cleanStream
        await localDiagnosticVideoRef.current.play().catch(() => undefined)
      }

      const remoteStream = new MediaStream()
      alteredStreamRef.current = remoteStream
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
      }

      const player = await window.DuckSoup!.render(
        {
          stats: true,
          callback: (message) => {
            if (message.kind === 'track') {
              const event = message.payload as RTCTrackEvent
              remoteStream.addTrack(event.track)
              addLog(`Remote ${event.track.kind} track received.`, 'success')
              remoteVideoRef.current?.play().catch(() => undefined)
            } else if (message.kind === 'start') {
              setConnectionState('connected')
              addLog('DuckSoup room started.', 'success')
            } else if (message.kind === 'joined') {
              addLog('Joined DuckSoup room.', 'success')
            } else if (message.kind === 'other_joined') {
              addLog('Partner station joined the DuckSoup room.', 'success')
            } else if (message.kind === 'other_left') {
              addLog('Partner station left the DuckSoup room.', 'warn')
            } else if (message.kind === 'closed' || message.kind === 'end') {
              setConnectionState('ready')
              addLog('DuckSoup connection closed.', 'warn')
            } else if (message.kind.startsWith('error')) {
              setConnectionState('error')
              const detail = String(message.payload ?? message.kind)
              if (detail.toLowerCase().includes('duplicate') || message.kind.toLowerCase().includes('duplicate')) {
                addLog('DuckSoup rejected the join as a duplicate user. Use different station IDs on the two laptops, such as P001 and P002.', 'error')
              } else {
                addLog(`${message.kind}: ${detail}`, 'error')
              }
            } else if (message.kind === 'stats') {
              const nextLatency = latencyFromStats(message.payload)
              if (nextLatency) setLatency(nextLatency)
            }
          }
        },
        {
          signalingUrl: buildSignalingUrl(form.duckSoupUrl),
          interactionName: form.roomId,
          userId: stationId,
          duration: 3600,
          size: 2,
          width: 1280,
          height: 720,
          framerate: 30,
          videoFormat: 'H264',
          recordingMode: 'forced',
          namespace: 'uw_conference_lab',
          gpu: false,
          audioFx: selectedAudioFx(controls),
          videoFx: `mozza alpha=${controls.smileAlpha} face-thresh=${controls.faceThreshold} beta=${controls.landmarkBeta} fc=${controls.smoothingCutoff} overlay=${controls.overlay ? 'true' : 'false'}`
        }
      )

      playerRef.current = player
      appendControlEvent('connect', form.roomId, true, 'DuckSoup WebRTC room joined.')
    } catch (error) {
      setConnectionState('error')
      addLog(error instanceof Error ? error.message : 'Connection failed.', 'error')
    }
  }, [addLog, appendControlEvent, controls, form, loadDuckSoupScript])

  const disconnect = (): void => {
    playerRef.current?.stop()
    playerRef.current = null
    cleanStreamRef.current?.getTracks().forEach((track) => track.stop())
    alteredStreamRef.current?.getTracks().forEach((track) => track.stop())
    cleanStreamRef.current = null
    alteredStreamRef.current = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (localDiagnosticVideoRef.current) localDiagnosticVideoRef.current.srcObject = null
    setLatency(emptyLatency)
    setConnectionState(duckSoupReady ? 'ready' : 'idle')
    addLog('Disconnected and released local media tracks.', 'info')
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await window.researchApi.selectOutputFolder()
    if (folder) {
      updateForm('outputFolder', folder)
      addLog(`Output folder selected: ${folder}`, 'success')
    }
  }

  const startRecording = async (): Promise<void> => {
    const cleanStream = cleanStreamRef.current
    const alteredStream = alteredStreamRef.current
    if (!cleanStream || !alteredStream || alteredStream.getTracks().length === 0) {
      addLog('Need both clean local media and altered remote media before recording.', 'error')
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
    appendControlEvent('recording', 'start', true, `Session directory: ${createdDir}`)
    cleanRecorderRef.current.start(1000)
    alteredRecorderRef.current.start(1000)
    addLog('Recording clean and altered streams.', 'success')
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
        'alteredVideo is the returned DuckSoup/Mozza stream seen by the station.',
        'manipulation_events.csv contains live control changes with timestamps relative to recording start.'
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
            appliedToDuckSoup: true,
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>DuckSoup Conference Lab</h1>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel">
            <div className="section-title">Session</div>
            <div className="field-grid two">
              <label>
                Study
                <input value={form.studyId} onChange={(event) => updateForm('studyId', event.target.value)} />
              </label>
              <label>
                RA
                <input value={form.raId} onChange={(event) => updateForm('raId', event.target.value)} />
              </label>
              <label>
                Dyad ID
                <input value={form.dyadId} onChange={(event) => updateForm('dyadId', event.target.value)} />
              </label>
              <label>
                This station ID
                <input value={form.participantId} onChange={(event) => updateForm('participantId', event.target.value)} />
              </label>
              <label>
                Partner ID
                <input value={form.partnerId} onChange={(event) => updateForm('partnerId', event.target.value)} />
              </label>
              <label>
                Target user
                <input
                  value={form.targetUserId}
                  placeholder="default: this station"
                  onChange={(event) => updateForm('targetUserId', event.target.value)}
                />
              </label>
            </div>
            <label>
              Room ID
              <input value={form.roomId} onChange={(event) => updateForm('roomId', event.target.value)} />
            </label>
            <div className={form.participantId && form.participantId === form.partnerId ? 'connection-tip error' : 'connection-tip'}>
              <strong>Two-laptop rule:</strong> use the same Room ID, different station IDs, and press Connect on both laptops within about 10 seconds.
            </div>
            <label>
              DuckSoup server
              <input value={form.duckSoupUrl} onChange={(event) => updateForm('duckSoupUrl', event.target.value)} />
            </label>
            <div className="folder-row">
              <input value={form.outputFolder} readOnly placeholder="Choose output folder" />
              <button className="browse-button" onClick={pickFolder} title="Select output folder">
                Browse
              </button>
            </div>
            <div className="button-row">
              <button onClick={checkDuckSoup}>
                Check
              </button>
              {connectionState === 'connected' ? (
                <button className="danger" onClick={disconnect}>
                  Disconnect
                </button>
              ) : (
                <button className="primary" onClick={connect} disabled={!duckSoupReady && connectionState !== 'ready'}>
                  Connect
                </button>
              )}
            </div>
            <div className="inline-status">
              <span className={`status-dot status-${connectionState}`} />
              {statusLabel}
            </div>
          </section>

          <section className="panel">
            <div className="section-title">Two-Computer Setup</div>
            <p className="plain-text">
              Run DuckSoup on one host laptop. Use the same Room ID on both laptops, but set different station IDs, such as P001 on laptop A and P002 on laptop B.
            </p>
            <div className="network-list">
              <div><strong>Host name</strong><span>{networkInfo.hostname || 'unknown'}</span></div>
              {networkInfo.addresses.length === 0 ? (
                <div><strong>LAN IP</strong><span>not detected</span></div>
              ) : (
                networkInfo.addresses.map((address) => (
                  <button
                    key={address}
                    className="network-address"
                    onClick={() => updateForm('duckSoupUrl', `http://${address}:8100`)}
                  >
                    http://{address}:8100
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="section-title">Modification Condition</div>
            <div className="preset-list">
              {conditionPresets.map((preset) => (
                <button
                  key={preset.label}
                  className={form.condition === preset.label ? 'preset active' : 'preset'}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="center-stage">
          <div className="video-grid">
            <div className="video-panel">
              <div className="video-label">Partner view · altered stream participant sees</div>
              <video ref={remoteVideoRef} autoPlay playsInline className="video-surface" />
              {connectionState !== 'connected' && <div className="video-empty">Connect to a DuckSoup room to receive the partner stream.</div>}
            </div>
            <div className="video-panel diagnostic-panel">
              <div className="video-label">Diagnostics · local clean capture</div>
              <video
                ref={localDiagnosticVideoRef}
                autoPlay
                muted
                playsInline
                className={showDiagnostics ? 'video-surface' : 'video-surface hidden-preview'}
              />
              {!showDiagnostics && <div className="video-empty">Self-view hidden for participant-facing sessions.</div>}
              <button className="overlay-button" onClick={() => setShowDiagnostics((prev) => !prev)}>
                {showDiagnostics ? 'Hide self check' : 'Show self check'}
              </button>
            </div>
          </div>

          <div className="operations-row">
            <button onClick={startRecording} disabled={recordingState !== 'idle' || connectionState !== 'connected'} className="record">
              Start recording
            </button>
            <button onClick={stopRecording} disabled={recordingState !== 'recording'} className="stop">
              Stop
            </button>
            <div className="metric">
              <span>Recording</span>
              <strong>{recordingState === 'recording' ? `${recordingSeconds}s` : recordingState}</strong>
            </div>
            <div className="metric">
              <span>Events logged</span>
              <strong>{controlEvents.length}</strong>
            </div>
            <div className="metric">
              <span>RTT</span>
              <strong>{latency.rttMs === null ? 'waiting' : `${latency.rttMs} ms`}</strong>
            </div>
            <div className="metric">
              <span>Jitter</span>
              <strong>{latency.jitterMs === null ? 'waiting' : `${latency.jitterMs} ms`}</strong>
            </div>
            <div className="metric wide">
              <span>Session folder</span>
              <strong>{sessionDir || 'created on recording start'}</strong>
            </div>
          </div>

          <section className="panel">
            <div className="section-title">Output to PPS / Questionnaire Pipeline</div>
            <p className="plain-text">
              Each recorded session writes clean and altered `.webm` videos, a JSON manifest, and a manipulation-events CSV. The PPS app can use the chosen video as its later conversation playback file; the manifest keeps dyad, participant, condition, and live-control timing together.
            </p>
          </section>

          <section className="panel log-panel">
            <div className="section-title">Event Log</div>
            <div className="log-list">
              {logs.length === 0 ? (
                <p className="muted">No events yet. Start by checking DuckSoup.</p>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className={`log-line ${log.level}`}>
                    <span>{log.timestamp}</span>
                    {log.message}
                  </div>
                ))
              )}
            </div>
          </section>
        </section>

        <aside className="controls">
          <section className="panel">
            <div className="section-title accent">Face Modulation</div>
            <RangeControl
              label="Smile alpha"
              value={controls.smileAlpha}
              min={-2}
              max={5}
              step={0.1}
              markers={['Frown', 'Neutral', 'Smile']}
              onChange={(value) => setControl('smileAlpha', value, 'alpha')}
            />
            <RangeControl
              label="Detection threshold"
              value={controls.faceThreshold}
              min={0}
              max={1}
              step={0.05}
              markers={['Sensitive', 'Default', 'Strict']}
              onChange={(value) => setControl('faceThreshold', value, 'face-thresh')}
            />
            <RangeControl
              label="Landmark beta"
              value={controls.landmarkBeta}
              min={0}
              max={1}
              step={0.05}
              markers={['Stable', 'Default', 'Fast motion']}
              onChange={(value) => setControl('landmarkBeta', value, 'beta')}
            />
            <RangeControl
              label="Smoothing cutoff"
              value={controls.smoothingCutoff}
              min={0}
              max={20}
              step={0.5}
              markers={['Smooth', 'Default', 'Responsive']}
              onChange={(value) => setControl('smoothingCutoff', value, 'fc')}
            />
            <label className="toggle-row">
              <span>Debug overlay</span>
              <input
                type="checkbox"
                checked={controls.overlay}
                onChange={(event) => setControl('overlay', event.target.checked, 'overlay')}
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
              value={controls.partnerVolume}
              min={0}
              max={2}
              step={0.05}
              markers={['Muted', 'Normal', 'Boosted']}
              onChange={(value) =>
                setControl('partnerVolume', value, undefined, 'Local playback monitor gain. DuckSoup voice manipulation is controlled by the audioFx presets below.')
              }
            />
            <RangeControl
              label="DuckSoup pitch"
              value={controls.audioPitch}
              min={0.6}
              max={1.4}
              step={0.02}
              markers={['Deeper', 'Neutral', 'Brighter']}
              onChange={(value) => {
                setControls((prev) => ({ ...prev, audioPreset: 'custom-pitch', audioPitch: value }))
                sendDuckSoupControl('pitch', value, 'Custom DuckSoup pitch audioFx control.', 'pitch')
              }}
            />
            <RangeControl
              label="DuckSoup gain"
              value={controls.audioGain}
              min={0}
              max={2}
              step={0.05}
              markers={['Muted', 'Neutral', 'Boosted']}
              onChange={(value) => {
                setControls((prev) => ({ ...prev, audioPreset: 'custom-volume', audioGain: value }))
                sendDuckSoupControl('volume', value, 'Custom DuckSoup volume audioFx control.', 'volume')
              }}
            />
            <RangeControl
              label="Synchrony delay target (ms)"
              value={controls.synchronyDelayMs}
              min={0}
              max={1200}
              step={50}
              markers={['Live', 'Lagged', 'Very delayed']}
              onChange={(value) =>
                setControl('synchronyDelayMs', value, undefined, 'Logged design variable. Live media delay requires a dedicated delay buffer in the DuckSoup/GStreamer pipeline.')
              }
            />
            <div className="constraint-note">
              Audio presets are sent as DuckSoup `audioFx` requests. If a neutral preset is selected after a live audio effect, reconnect the room to fully remove the active effect chain.
            </div>
          </section>

          <section className="panel">
            <div className="section-title">Latency Viewer</div>
            <div className="analysis-list">
              <div><strong>Round trip</strong><span>{latency.rttMs === null ? 'waiting' : `${latency.rttMs} ms`}</span></div>
              <div><strong>Video RTT</strong><span>{latency.videoRttMs === null ? 'waiting' : `${latency.videoRttMs} ms`}</span></div>
              <div><strong>Audio RTT</strong><span>{latency.audioRttMs === null ? 'waiting' : `${latency.audioRttMs} ms`}</span></div>
              <div><strong>Jitter</strong><span>{latency.jitterMs === null ? 'waiting' : `${latency.jitterMs} ms`}</span></div>
              <div><strong>Packets lost</strong><span>{latency.packetsLost}</span></div>
              <div><strong>Updated</strong><span>{latency.updatedAt || 'waiting'}</span></div>
            </div>
          </section>

          <section className="panel">
            <div className="section-title">Analysis Hooks</div>
            <div className="analysis-list">
              <div><strong>Emotion inference</strong><span>adapter placeholder</span></div>
              <div><strong>Smile intensity</strong><span>Mozza alpha log</span></div>
              <div><strong>Synchrony</strong><span>delay/timing log</span></div>
              <div><strong>Engagement</strong><span>future gaze/head pose</span></div>
            </div>
          </section>
        </aside>
      </main>
    </div>
  )
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  markers,
  onChange
}: {
  label: string
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
        <span>{label}</span>
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
