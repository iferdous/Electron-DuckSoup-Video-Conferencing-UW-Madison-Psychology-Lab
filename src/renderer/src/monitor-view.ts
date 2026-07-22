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
  reason: 'mapped' | 'dyad-fallback' | 'self' | 'missing-stream' | 'ambiguous' | 'no-partner'
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
  descriptors: MonitorStreamDescriptor[],
  knownParticipantIds: Set<string>
): MonitorStreamDescriptor[] {
  return descriptors.filter((descriptor) => {
    if (!descriptor.streamId || !descriptor.userId || descriptor.userId.startsWith('peer-')) return false
    return knownParticipantIds.has(descriptor.userId)
  })
}
