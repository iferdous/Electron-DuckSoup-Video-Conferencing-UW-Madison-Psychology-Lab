import { describe, expect, it } from 'vitest'
import {
  buildParticipantSessionLink,
  validateParticipantSessionLink
} from './session-link'
import type { SessionForm } from './types'

const normalizeMediaUrl = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return new URL(withScheme).toString().replace(/\/$/, '')
}

const baseForm: Pick<
  SessionForm,
  'roomId' | 'studyId' | 'sessionFormat' | 'mediaTransport' | 'duckSoupUrl' | 'dyadId'
> = {
  roomId: 'synclink-room-123',
  studyId: 'NELF2026',
  sessionFormat: 'dyad',
  mediaTransport: 'mesh',
  duckSoupUrl: '',
  dyadId: 'dyad-7'
}

describe('participant session links', () => {
  it('rejects missing or local-only participant links before copying', () => {
    expect(validateParticipantSessionLink('').ok).toBe(false)
    expect(
      validateParticipantSessionLink('http://localhost:8765/join?roomId=abc&transport=mesh').ok
    ).toBe(false)
    expect(
      validateParticipantSessionLink('http://127.0.0.1:8765/join?roomId=abc&transport=mesh').ok
    ).toBe(false)
  })

  it('builds a LAN participant link after the local server returns a host address', () => {
    const link = buildParticipantSessionLink(baseForm, 'http://192.168.1.50:8765', normalizeMediaUrl)
    const validation = validateParticipantSessionLink(link)
    const url = new URL(link)

    expect(validation).toEqual({ ok: true, url: link })
    expect(url.hostname).toBe('192.168.1.50')
    expect(url.pathname).toBe('/join')
    expect(url.searchParams.get('roomId')).toBe('synclink-room-123')
    expect(url.searchParams.get('studyId')).toBe('NELF2026')
    expect(url.searchParams.get('format')).toBe('dyad')
    expect(url.searchParams.get('transport')).toBe('mesh')
    expect(url.searchParams.get('dyadId')).toBe('dyad-7')
  })

  it('accepts hosted signaling links without rewriting them', () => {
    const link = buildParticipantSessionLink(baseForm, 'https://nelf-call-signaling.onrender.com', normalizeMediaUrl)
    const validation = validateParticipantSessionLink(link)
    const url = new URL(link)

    expect(validation).toEqual({ ok: true, url: link })
    expect(url.origin).toBe('https://nelf-call-signaling.onrender.com')
  })

  it('preserves the DuckSoup media server address in the ds parameter', () => {
    const form = {
      ...baseForm,
      mediaTransport: 'ducksoup' as const,
      duckSoupUrl: '192.168.1.50:8100'
    }
    const link = buildParticipantSessionLink(form, 'http://192.168.1.50:8765', normalizeMediaUrl)
    const validation = validateParticipantSessionLink(link, {
      requireDuckSoupDs: true,
      expectedDuckSoupUrl: 'http://192.168.1.50:8100'
    })
    const url = new URL(link)

    expect(validation).toEqual({ ok: true, url: link })
    expect(url.searchParams.get('transport')).toBe('ducksoup')
    expect(url.searchParams.get('ds')).toBe('http://192.168.1.50:8100')
  })

  it('rejects DuckSoup links when the media server parameter is missing', () => {
    const link = buildParticipantSessionLink(
      { ...baseForm, mediaTransport: 'ducksoup', duckSoupUrl: '' },
      'http://192.168.1.50:8765',
      normalizeMediaUrl
    )

    expect(validateParticipantSessionLink(link, { requireDuckSoupDs: true }).ok).toBe(false)
  })

  it('rejects DuckSoup links with local-only media server addresses', () => {
    const link = buildParticipantSessionLink(
      { ...baseForm, mediaTransport: 'ducksoup', duckSoupUrl: 'http://localhost:8100' },
      'http://192.168.1.50:8765',
      normalizeMediaUrl
    )

    const validation = validateParticipantSessionLink(link, { requireDuckSoupDs: true })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.reason).toContain('LAN address')
  })

  it('rejects DuckSoup links whose media server does not match the checked server', () => {
    const link = buildParticipantSessionLink(
      { ...baseForm, mediaTransport: 'ducksoup', duckSoupUrl: 'http://192.168.1.99:8100' },
      'http://192.168.1.50:8765',
      normalizeMediaUrl
    )

    const validation = validateParticipantSessionLink(link, {
      requireDuckSoupDs: true,
      expectedDuckSoupUrl: 'http://192.168.1.50:8100'
    })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.reason).toContain('outdated')
  })

  it('allows localhost DuckSoup media only for explicit one-machine testing', () => {
    const link = buildParticipantSessionLink(
      { ...baseForm, mediaTransport: 'ducksoup', duckSoupUrl: 'localhost:8100' },
      'http://192.168.1.50:8765',
      normalizeMediaUrl
    )

    expect(
      validateParticipantSessionLink(link, {
        requireDuckSoupDs: true,
        allowLocalhostDs: true,
        expectedDuckSoupUrl: 'http://localhost:8100'
      }).ok
    ).toBe(true)
  })
})
