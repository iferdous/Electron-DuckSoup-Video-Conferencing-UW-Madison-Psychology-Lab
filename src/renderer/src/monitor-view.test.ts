import { describe, expect, it } from 'vitest'
import {
  duckSoupStartGate,
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

  it('can treat dyad local-loopback metadata as the only partner when requested', () => {
    expect(
      resolveDuckSoupTrackUserId({
        streamId: 'loopback-stream',
        mappedUserId: 'p1',
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2')],
        preferDyadPartnerForLocalLoopback: true
      })
    ).toEqual({ userId: 'p2', reason: 'dyad-local-loopback' })
  })

  it('does not guess local-loopback metadata in triads or quads', () => {
    expect(
      resolveDuckSoupTrackUserId({
        streamId: 'loopback-stream',
        mappedUserId: 'p1',
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2'), peer('p3')],
        preferDyadPartnerForLocalLoopback: true
      })
    ).toEqual({ userId: 'p1', reason: 'mapped' })
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

  it('filters synthetic monitor descriptors before the controller accepts them', () => {
    const descriptors: MonitorStreamDescriptor[] = [
      { streamId: 'clean-p1', kind: 'clean', userId: 'p1', displayName: 'P1' },
      { streamId: 'altered-p2', kind: 'altered', userId: 'p2', displayName: 'P2' },
      { streamId: 'synthetic', kind: 'altered', userId: 'peer-random-stream', displayName: 'Bad' },
      { streamId: '', kind: 'clean', userId: 'p1', displayName: 'Missing stream' },
      { streamId: 'unknown-clean', kind: 'clean', userId: 'p9', displayName: 'Unknown' }
    ]

    expect(safeMonitorDescriptors(descriptors)).toEqual([descriptors[0], descriptors[1], descriptors[4]])
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

  it('holds DuckSoup media until all expected dyad participants are visible in signaling', () => {
    expect(
      duckSoupStartGate({
        isController: false,
        useDuckSoup: true,
        duckSoupActive: false,
        duckSoupStartInFlight: false,
        localUserId: 'p1',
        peers: [peer('p1')],
        expectedParticipants: 2
      })
    ).toMatchObject({ ready: false, reason: 'waiting-participants', participantCount: 1 })

    expect(
      duckSoupStartGate({
        isController: false,
        useDuckSoup: true,
        duckSoupActive: false,
        duckSoupStartInFlight: false,
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2'), peer('experimenter', 'controller')],
        expectedParticipants: 2
      })
    ).toMatchObject({ ready: true, reason: 'ready', participantCount: 2 })
  })

  it('does not start DuckSoup media for the experimenter or an already-started participant', () => {
    expect(
      duckSoupStartGate({
        isController: true,
        useDuckSoup: true,
        duckSoupActive: false,
        duckSoupStartInFlight: false,
        localUserId: 'experimenter',
        peers: [peer('p1'), peer('p2'), peer('experimenter', 'controller')],
        expectedParticipants: 2
      }).reason
    ).toBe('controller')

    expect(
      duckSoupStartGate({
        isController: false,
        useDuckSoup: true,
        duckSoupActive: true,
        duckSoupStartInFlight: false,
        localUserId: 'p1',
        peers: [peer('p1'), peer('p2')],
        expectedParticipants: 2
      }).reason
    ).toBe('already-started')
  })
})
