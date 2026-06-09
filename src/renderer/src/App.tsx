import {
  Activity,
  FolderOpen,
  HeartPulse,
  Mic2,
  Network,
  Phone,
  PhoneOff,
  Radio,
  Save,
  Settings2,
  SlidersHorizontal,
  Square,
  Video
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnectionState, ControlEvent, LogEvent, ManipulationControls, RecordingState, SessionForm } from './types'

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

  const statusLabel = useMemo(() => {
    const labels: Record<ConnectionState, string> = {
      idle: 'Not checked',
      checking: 'Checking DuckSoup',
      ready: 'DuckSoup ready',
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
    (property: string, value: number | boolean, notes = '') => {
      const normalizedValue = typeof value === 'boolean' ? (value ? 1 : 0) : value
      const targetUser = form.targetUserId || form.participantId
      if (playerRef.current) {
        playerRef.current.controlFx('mozza', property, normalizedValue, undefined, targetUser)
        appendControlEvent(property, value, true, notes)
        addLog(`Applied ${property} = ${value} to ${targetUser || 'current user'}.`, 'info')
      } else {
        appendControlEvent(property, value, false, 'Queued/logged before DuckSoup connection. ' + notes)
        addLog(`Logged ${property} = ${value}; connect before it can be applied live.`, 'warn')
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

  const connect = useCallback(async () => {
    try {
      setConnectionState('connecting')
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
          stats: false,
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
            } else if (message.kind === 'closed' || message.kind === 'end') {
              setConnectionState('ready')
              addLog('DuckSoup connection closed.', 'warn')
            } else if (message.kind.startsWith('error')) {
              setConnectionState('error')
              addLog(`${message.kind}: ${String(message.payload ?? '')}`, 'error')
            }
          }
        },
        {
          signalingUrl: buildSignalingUrl(form.duckSoupUrl),
          interactionName: form.roomId,
          userId: form.participantId || `station-${Date.now()}`,
          duration: 3600,
          size: 2,
          width: 1280,
          height: 720,
          framerate: 30,
          videoFormat: 'H264',
          recordingMode: 'forced',
          namespace: 'uw_conference_lab',
          gpu: false,
          videoFx: `mozza alpha=${controls.smileAlpha} face-thresh=${controls.faceThreshold} beta=${controls.landmarkBeta} fc=${controls.smoothingCutoff} overlay=${controls.overlay ? 'true' : 'false'}`
        }
      )

      playerRef.current = player
      appendControlEvent('connect', form.roomId, true, 'DuckSoup WebRTC room joined.')
    } catch (error) {
      setConnectionState('error')
      addLog(error instanceof Error ? error.message : 'Connection failed.', 'error')
    }
  }, [addLog, appendControlEvent, controls, form.duckSoupUrl, form.participantId, form.roomId, loadDuckSoupScript])

  const disconnect = (): void => {
    playerRef.current?.stop()
    playerRef.current = null
    cleanStreamRef.current?.getTracks().forEach((track) => track.stop())
    alteredStreamRef.current?.getTracks().forEach((track) => track.stop())
    cleanStreamRef.current = null
    alteredStreamRef.current = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (localDiagnosticVideoRef.current) localDiagnosticVideoRef.current.srcObject = null
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
          <p>Niedenthal Emotions Lab · live manipulation and recording console</p>
        </div>
        <div className={`status-pill status-${connectionState}`}>
          <span />
          {statusLabel}
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel">
            <div className="section-title">
              <Settings2 size={16} />
              Session
            </div>
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
            <label>
              DuckSoup server
              <input value={form.duckSoupUrl} onChange={(event) => updateForm('duckSoupUrl', event.target.value)} />
            </label>
            <div className="folder-row">
              <input value={form.outputFolder} readOnly placeholder="Choose output folder" />
              <button className="icon-button" onClick={pickFolder} title="Select output folder">
                <FolderOpen size={17} />
              </button>
            </div>
            <div className="button-row">
              <button onClick={checkDuckSoup}>
                <Network size={16} />
                Check
              </button>
              {connectionState === 'connected' ? (
                <button className="danger" onClick={disconnect}>
                  <PhoneOff size={16} />
                  Disconnect
                </button>
              ) : (
                <button className="primary" onClick={connect} disabled={!duckSoupReady && connectionState !== 'ready'}>
                  <Phone size={16} />
                  Connect
                </button>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="section-title">
              <SlidersHorizontal size={16} />
              Modification Condition
            </div>
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
              <Radio size={17} />
              Start recording
            </button>
            <button onClick={stopRecording} disabled={recordingState !== 'recording'} className="stop">
              <Square size={15} />
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
            <div className="metric wide">
              <span>Session folder</span>
              <strong>{sessionDir || 'created on recording start'}</strong>
            </div>
          </div>

          <section className="panel">
            <div className="section-title">
              <Save size={16} />
              Output to PPS / Questionnaire Pipeline
            </div>
            <p className="plain-text">
              Each recorded session writes a clean video, an altered video, a JSON manifest, and a manipulation-events CSV. The PPS app can use the chosen video as its later conversation playback file; the manifest keeps dyad, participant, condition, and live-control timing together.
            </p>
          </section>

          <section className="panel log-panel">
            <div className="section-title">
              <Activity size={16} />
              Event Log
            </div>
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
            <div className="section-title accent">
              <HeartPulse size={16} />
              Face Modulation
            </div>
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
            <div className="section-title">
              <Mic2 size={16} />
              Voice / Synchrony
            </div>
            <RangeControl
              label="Partner playback volume"
              value={controls.partnerVolume}
              min={0}
              max={2}
              step={0.05}
              markers={['Muted', 'Normal', 'Boosted']}
              onChange={(value) =>
                setControl('partnerVolume', value, undefined, 'Local participant playback gain. This does not yet rewrite the outgoing DuckSoup audio track.')
              }
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
              Voice warmth, pitch, eye-contact redirection, and true AV delay should be implemented as DuckSoup/GStreamer effects so both participants receive the same controlled manipulation.
            </div>
          </section>

          <section className="panel">
            <div className="section-title">
              <Video size={16} />
              Analysis Hooks
            </div>
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
