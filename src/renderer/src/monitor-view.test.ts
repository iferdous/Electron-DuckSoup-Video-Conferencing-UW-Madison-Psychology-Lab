import { describe, expect, it } from 'vitest'
import {
  monitorFeedKey,
  monitorWaitingState,
  resolveDuckSoupTrackUserId,
  safeMonitorDescriptors,
  type MonitorStreamDescriptor
} from './monitor-view'
import type { CallPeer } from './types'

const peer = (userId: string, role: CallPeer['role'] = 'participant'): CallPeer => ({
  userId,
  role,
  displayName: userId.toUpperCase(),
  joinedAt: 1
})

describe('experimenter monitor helpers', () => {
  it('uses the explicit DuckSoup stream mapping when available', () => {
    expect(
      resolveDuckSoupTrackUserId({
        streamId: 'stream-p2',
        mappedUserId: 'p2',
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2')]
      })
    ).toEqual({ userId: 'p2', reason: 'mapped' })
  })

  it('falls back to the only possible dyad partner instead of creating a peer stream id', () => {
    expect(
      resolveDuckSoupTrackUserId({
        streamId: 'duck-stream-without-user-meta',
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2'), peer('experimenter', 'controller')]
      })
    ).toEqual({ userId: 'p2', reason: 'dyad-fallback' })
  })

  it('refuses to guess when triad or quad streams are ambiguous', () => {
    expect(
      resolveDuckSoupTrackUserId({
        streamId: 'unknown-stream',
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2'), peer('p3')]
      })
    ).toEqual({ userId: null, reason: 'ambiguous' })
  })

  it('filters unsafe monitor descriptors before the controller accepts them', () => {
    const descriptors: MonitorStreamDescriptor[] = [
      { streamId: 'clean-p1', kind: 'clean', userId: 'p1', displayName: 'P1' },
      { streamId: 'altered-p2', kind: 'altered', userId: 'p2', displayName: 'P2' },
      { streamId: 'synthetic', kind: 'altered', userId: 'peer-random-stream', displayName: 'Bad' },
      { streamId: '', kind: 'clean', userId: 'p1', displayName: 'Missing stream' },
      { streamId: 'unknown-clean', kind: 'clean', userId: 'p9', displayName: 'Unknown' }
    ]

    expect(safeMonitorDescriptors(descriptors, new Set(['p1', 'p2']))).toEqual(descriptors.slice(0, 2))
  })

  it('builds stable feed keys and default waiting messages', () => {
    expect(monitorFeedKey('p1', 'altered')).toBe('p1:altered')
    expect(monitorWaitingState(peer('p1'), 'clean')).toMatchObject({
      status: 'waiting-local-stream'
    })
    expect(monitorWaitingState(peer('p1'), 'altered')).toMatchObject({
      status: 'waiting-partner-stream'
    })
  })
})
