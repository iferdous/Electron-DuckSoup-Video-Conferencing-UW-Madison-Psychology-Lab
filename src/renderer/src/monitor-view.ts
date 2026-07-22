import type { CallPeer } from './types'

export type MonitorFeedKind = 'clean' | 'altered'

export type MonitorFeedStatus =
  | 'waiting-participant'
  | 'waiting-local-stream'
  | 'waiting-partner-stream'
  | 'sharing-with-experimenter'
  | 'connected'
  | 'failed'

export type MonitorStreamDescriptor = {
  streamId: string
  kind: MonitorFeedKind
  userId: string
  displayName: string
}

export type MonitorFeedState = {
  status: MonitorFeedStatus
  message: string
}

export type DuckSoupStreamResolution = {
  userId: string | null
  reason: 'mapped' | 'dyad-fallback' | 'missing-stream' | 'ambiguous' | 'no-partner'
}

export type DuckSoupStartGate = {
  ready: boolean
  reason: 'controller' | 'not-ducksoup' | 'already-started' | 'waiting-participants' | 'ready'
  participantCount: number
}

export const monitorFeedKey = (userId: string, kind: MonitorFeedKind): string => `${userId}:${kind}`

export function monitorWaitingState(peer: CallPeer | undefined, kind: MonitorFeedKind): MonitorFeedState {
  if (!peer) {
    return {
      status: 'waiting-participant',
      message: 'Waiting for this participant to join.'
    }
  }

  return kind === 'clean'
    ? {
        status: 'waiting-local-stream',
        message: `${peer.displayName} joined. Waiting for their unaltered camera feed.`
      }
    : {
        status: 'waiting-partner-stream',
        message: `${peer.displayName} joined. Waiting for the altered partner feed.`
      }
}

export function resolveDuckSoupTrackUserId(params: {
  streamId?: string
  mappedUserId?: string
  localUserId: string
  peers: CallPeer[]
}): DuckSoupStreamResolution {
  if (params.mappedUserId) return { userId: params.mappedUserId, reason: 'mapped' }
  if (!params.streamId) return { userId: null, reason: 'missing-stream' }

  const participantPeers = params.peers.filter(
    (peer) => peer.role === 'participant' && peer.userId !== params.localUserId
  )

  if (participantPeers.length === 0) return { userId: null, reason: 'no-partner' }
  if (participantPeers.length === 1) return { userId: participantPeers[0].userId, reason: 'dyad-fallback' }

  return { userId: null, reason: 'ambiguous' }
}

export function safeMonitorDescriptors(
  descriptors: MonitorStreamDescriptor[]
): MonitorStreamDescriptor[] {
  return descriptors.filter((descriptor) => {
    if (!descriptor.streamId || !descriptor.userId || descriptor.userId.startsWith('peer-')) return false
    return descriptor.kind === 'clean' || descriptor.kind === 'altered'
  })
}

export function duckSoupStartGate(params: {
  isController: boolean
  useDuckSoup: boolean
  duckSoupActive: boolean
  duckSoupStartInFlight: boolean
  localUserId: string
  peers: CallPeer[]
  expectedParticipants: number
}): DuckSoupStartGate {
  const participantCount = params.peers.filter((peer) => peer.role === 'participant').length
  if (params.isController) return { ready: false, reason: 'controller', participantCount }
  if (!params.useDuckSoup) return { ready: false, reason: 'not-ducksoup', participantCount }
  if (params.duckSoupActive || params.duckSoupStartInFlight) {
    return { ready: false, reason: 'already-started', participantCount }
  }
  if (participantCount < params.expectedParticipants) {
    return { ready: false, reason: 'waiting-participants', participantCount }
  }
  return { ready: true, reason: 'ready', participantCount }
}
