import type { SessionForm } from './types'

export type ParticipantLinkStatus = 'not-ready' | 'starting-server' | 'ready' | 'error'

export type ParticipantLinkValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string }

const LOCAL_ONLY_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0'])

export const isLocalOnlyHost = (host: string): boolean => LOCAL_ONLY_HOSTS.has(host.toLowerCase())

export const buildParticipantSessionLink = (
  form: Pick<
    SessionForm,
    'roomId' | 'studyId' | 'sessionFormat' | 'mediaTransport' | 'duckSoupUrl' | 'dyadId'
  >,
  linkBase: string,
  normalizeMediaUrl: (value: string) => string
): string => {
  const url = new URL('/join', linkBase)
  url.searchParams.set('roomId', form.roomId)
  url.searchParams.set('studyId', form.studyId)
  url.searchParams.set('format', form.sessionFormat)
  url.searchParams.set('transport', form.mediaTransport)
  if (form.mediaTransport === 'ducksoup' && form.duckSoupUrl.trim()) {
    url.searchParams.set('ds', normalizeMediaUrl(form.duckSoupUrl) || form.duckSoupUrl.trim())
  }
  if (form.dyadId.trim()) url.searchParams.set('dyadId', form.dyadId.trim())
  return url.toString()
}

export const validateParticipantSessionLink = (
  value: string,
  options: { allowLocalhost?: boolean; requireDuckSoupDs?: boolean } = {}
): ParticipantLinkValidation => {
  if (!value.trim()) return { ok: false, reason: 'The participant link is not ready yet. Create the room first.' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'The participant link is malformed. Create the room again.' }
  }

  if (url.pathname !== '/join') return { ok: false, reason: 'The participant link is missing the /join page.' }
  if (!url.searchParams.get('roomId')?.trim()) return { ok: false, reason: 'The participant link is missing a meeting ID.' }
  if (!url.searchParams.get('transport')?.trim()) return { ok: false, reason: 'The participant link is missing the media transport.' }
  if (!options.allowLocalhost && isLocalOnlyHost(url.hostname)) {
    return {
      ok: false,
      reason:
        'This link only works on this computer. Create the room first so participants receive the host computer link.'
    }
  }
  if (options.requireDuckSoupDs && !url.searchParams.get('ds')?.trim()) {
    return { ok: false, reason: 'The DuckSoup participant link is missing the media server address.' }
  }

  return { ok: true, url: url.toString() }
}
