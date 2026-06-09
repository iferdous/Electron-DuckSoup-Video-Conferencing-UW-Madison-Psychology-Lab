export type ConnectionState = 'idle' | 'checking' | 'ready' | 'connecting' | 'connected' | 'error'
export type RecordingState = 'idle' | 'recording' | 'saving'

export type SessionForm = {
  studyId: string
  raId: string
  dyadId: string
  participantId: string
  partnerId: string
  roomId: string
  targetUserId: string
  duckSoupUrl: string
  outputFolder: string
  condition: string
}

export type ManipulationControls = {
  smileAlpha: number
  faceThreshold: number
  landmarkBeta: number
  smoothingCutoff: number
  overlay: boolean
  partnerVolume: number
  synchronyDelayMs: number
}

export type ControlEvent = {
  id: string
  timestamp: string
  elapsedMs: number
  roomId: string
  participantId: string
  partnerId: string
  targetUserId: string
  condition: string
  control: string
  value: string | number | boolean
  appliedToDuckSoup: boolean
  notes: string
}

export type LogEvent = {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

