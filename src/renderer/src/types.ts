export type ConnectionState = 'idle' | 'checking' | 'ready' | 'connecting' | 'connected' | 'error'
export type RecordingState = 'idle' | 'recording' | 'saving'
export type ComputerRole = 'mac-host' | 'windows'
export type CallRole = 'participant' | 'controller'
export type CallState = 'idle' | 'starting' | 'waiting' | 'connecting' | 'connected' | 'error'
export type SessionFormat = 'dyad' | 'triad' | 'quad'

export type SessionForm = {
  role: CallRole
  sessionFormat: SessionFormat
  serverName: string
  studyId: string
  raId: string
  dyadId: string
  displayName: string
  participantId: string
  partnerId: string
  roomId: string
  targetUserId: string
  duckSoupUrl: string
  callSignalUrl: string
  outputFolder: string
  condition: string
}

export type ChatTarget = 'room' | 'controllers' | 'participants' | string

export type ChatMessage = {
  id: string
  roomId: string
  from: string
  fromName: string
  fromRole: CallRole
  text: string
  sentAt: string
  to?: string
  targetRole?: CallRole
}

export type ManipulationControls = {
  smileAlpha: number
  faceThreshold: number
  landmarkBeta: number
  smoothingCutoff: number
  overlay: boolean
  audioPreset: string
  audioPitch: number
  audioGain: number
  partnerVolume: number
  synchronyDelayMs: number
}

export type LatencyStats = {
  rttMs: number | null
  jitterMs: number | null
  audioRttMs: number | null
  videoRttMs: number | null
  packetsLost: number
  updatedAt: string
}

export type LocalNetworkInfo = {
  hostname: string
  addresses: string[]
}

export type DiscoveredDuckSoupHost = {
  id: string
  serverName: string
  hostName: string
  duckSoupUrl: string
  callSignalUrl: string
  roomId: string
  address: string
  port: number
  signalPort: number
  seenAt: number
}

export type CallPeer = {
  userId: string
  displayName: string
  role: CallRole
  joinedAt: number
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
