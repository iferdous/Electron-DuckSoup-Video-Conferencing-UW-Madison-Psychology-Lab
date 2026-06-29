// Thin wrapper around the DuckSoup browser client (ducksoup.js).
//
// DuckSoup is the WebRTC SFU + GStreamer/Mozza effects server. The client script is
// served by the DuckSoup server itself at `<httpBaseUrl>/assets/<version>/js/ducksoup.js`
// and exposes a global `window.DuckSoup.render(embedOptions, peerOptions)`.
//
// We load it dynamically from the configured server (so the client version always
// matches the running server) and adapt it to the app:
//   - http(s)://host:8100  ->  signalingUrl ws(s)://host:8100/ws
//   - callback mode (no mountEl) so React owns the <video> elements.
//
// The global Window.DuckSoup type lives in src/preload/index.d.ts.

// Asset version served by the upstream `ducksouplab/ducksoup` image (config/version.yml).
// Bump if the server image is upgraded.
export const DUCKSOUP_ASSET_VERSION = 'v1.93'

// Mozza is the face-only smile warp (GStreamer plugin). videoFx string + the live-tunable
// property names verified against `gst-inspect-1.0 mozza` on ducksouplab/ducksoup:latest.
export const MOZZA_FX_NAME = 'video_fx'
export const MOZZA_AUDIO_FX_NAME = 'audio_fx'

export type DuckSoupCallbackMessage = {
  kind: string
  payload?: unknown
}

export type DuckSoupPlayer = {
  stop: (closeCode?: number) => void
  controlFx: (
    name: string,
    property: string,
    value: number | string,
    duration?: number,
    userId?: string
  ) => void
  polyControlFx: (name: string, property: string, kind: string, value: unknown) => void
  serverLog: (name: string, payload: unknown) => void
  limit: (kilobitsPerSecond: number) => Promise<void>
}

export type DuckSoupEmbedOptions = {
  callback: (message: DuckSoupCallbackMessage) => void
  stats?: boolean
  mountEl?: HTMLElement
}

// peerOptions minus signalingUrl (we derive that from the http base URL).
export type DuckSoupPeerOptions = {
  interactionName: string
  userId: string
  duration: number
  size?: number
  width?: number
  height?: number
  framerate?: number
  namespace?: string
  videoFormat?: 'H264' | 'VP8'
  recordingMode?: string
  gpu?: boolean
  audioOnly?: boolean
  audioFx?: string
  videoFx?: string
  overlay?: boolean
  logLevel?: number
  audio?: MediaTrackConstraints
  video?: MediaTrackConstraints
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

// http://host:8100 -> ws://host:8100/ws ; https -> wss
export const toSignalingUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export const duckSoupScriptUrl = (httpBaseUrl: string): string =>
  `${trimTrailingSlash(httpBaseUrl)}/assets/${DUCKSOUP_ASSET_VERSION}/js/ducksoup.js`

let scriptPromise: Promise<void> | null = null
let scriptLoadedFrom = ''

// Inject ducksoup.js once. ducksoup.js registers a DOMContentLoaded handler (for a
// Chrome>=122 SDP fix); since we inject after the document is already loaded, we
// re-dispatch the event after onload so that handler still runs.
export const ensureDuckSoupLoaded = (httpBaseUrl: string): Promise<void> => {
  if (typeof window !== 'undefined' && window.DuckSoup) return Promise.resolve()
  if (scriptPromise && scriptLoadedFrom === httpBaseUrl) return scriptPromise

  scriptLoadedFrom = httpBaseUrl
  scriptPromise = new Promise<void>((resolve, reject) => {
    const src = duckSoupScriptUrl(httpBaseUrl)
    const finish = (): void => {
      if (window.DuckSoup) {
        // Trigger ducksoup.js' DOMContentLoaded-bound browser detection (we loaded late).
        try {
          document.dispatchEvent(new Event('DOMContentLoaded'))
        } catch {
          // non-fatal
        }
        resolve()
      } else {
        scriptPromise = null
        reject(new Error('DuckSoup client loaded but window.DuckSoup is missing.'))
      }
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-ducksoup="true"]')
    if (existing) {
      if (window.DuckSoup) {
        finish()
      } else {
        existing.addEventListener('load', finish, { once: true })
        existing.addEventListener(
          'error',
          () => {
            scriptPromise = null
            reject(new Error(`Could not load the DuckSoup client from ${src}.`))
          },
          { once: true }
        )
      }
      return
    }

    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.dataset.ducksoup = 'true'
    script.addEventListener('load', finish, { once: true })
    script.addEventListener(
      'error',
      () => {
        script.remove()
        scriptPromise = null
        reject(new Error(`Could not load the DuckSoup client from ${src}. Is the media server running?`))
      },
      { once: true }
    )
    document.head.appendChild(script)
  })
  return scriptPromise
}

export const renderDuckSoup = async (
  httpBaseUrl: string,
  embedOptions: DuckSoupEmbedOptions,
  peerOptions: DuckSoupPeerOptions
): Promise<DuckSoupPlayer> => {
  await ensureDuckSoupLoaded(httpBaseUrl)
  if (!window.DuckSoup) throw new Error('DuckSoup client is unavailable.')
  const signalingUrl = toSignalingUrl(httpBaseUrl)
  return window.DuckSoup.render(embedOptions, { ...peerOptions, signalingUrl }) as Promise<DuckSoupPlayer>
}

// --- Mozza face manipulation mapping -------------------------------------------------
//
// App control  ->  mozza GStreamer property (verified via `gst-inspect-1.0 mozza`):
//   smileAlpha       -> alpha       (float,  neutral 0, positive = smile, negative = frown; realistic ~ -1..1)
//   faceThreshold    -> face-thresh (double, 0..1, dlib detector confidence)
//   landmarkBeta     -> beta        (float,  0..1, One-Euro filter lag)
//   smoothingCutoff  -> fc          (float,  0..1000, One-Euro filter jitter cutoff)
//   overlay          -> overlay     (bool,  landmark debug overlay; render-time only)
//
// `deform=plugins/smile10.dfm` resolves against the server working dir /app (plugins
// are mounted at /app/plugins). `shape-model` is left unset -> mozza's default
// /usr/share/dlib/shape_predictor_68_face_landmarks.dat (shipped in the image).
export type MozzaFaceParams = {
  smileAlpha: number
  faceThreshold: number
  landmarkBeta: number
  smoothingCutoff: number
  overlay: boolean
}

export type LiveMozzaFaceParams = Omit<MozzaFaceParams, 'overlay'>

export const buildMozzaVideoFx = (p: MozzaFaceParams): string =>
  [
    'mozza',
    'deform=plugins/smile10.dfm',
    `alpha=${p.smileAlpha}`,
    `face-thresh=${p.faceThreshold}`,
    `beta=${p.landmarkBeta}`,
    `fc=${p.smoothingCutoff}`,
    `overlay=${p.overlay ? 'true' : 'false'}`,
    `name=${MOZZA_FX_NAME}`
  ].join(' ')

// Outgoing voice pitch as a controllable GStreamer element. Other voice controls
// (gain, delay, tone shelving) remain on the local-canvas path for now.
export const buildAudioFx = (pitch: number): string => `pitch pitch=${pitch} name=${MOZZA_AUDIO_FX_NAME}`

// Push the live face controls onto a running mozza pipeline. `alpha` is interpolated
// smoothly; the One-Euro params and detector threshold are set instantly. `face-thresh`
// is a double, so it goes through polyControlFx; overlay is a bool set only at render.
export const applyMozzaControls = (
  player: DuckSoupPlayer,
  p: LiveMozzaFaceParams,
  alphaTransitionMs = 300
): void => {
  player.controlFx(MOZZA_FX_NAME, 'alpha', p.smileAlpha, alphaTransitionMs)
  player.controlFx(MOZZA_FX_NAME, 'beta', p.landmarkBeta)
  player.controlFx(MOZZA_FX_NAME, 'fc', p.smoothingCutoff)
  player.polyControlFx(MOZZA_FX_NAME, 'face-thresh', 'double', p.faceThreshold)
}

// Slider drags can produce dozens of updates per second. Apply only changed values so
// DuckSoup does not queue redundant control messages while it is decoding, tracking,
// warping, recording, and re-encoding both dyad streams.
export const applyMozzaControlChanges = (
  player: DuckSoupPlayer,
  current: LiveMozzaFaceParams,
  previous: LiveMozzaFaceParams | null,
  alphaTransitionMs = 150
): void => {
  if (!previous || current.smileAlpha !== previous.smileAlpha) {
    player.controlFx(MOZZA_FX_NAME, 'alpha', current.smileAlpha, alphaTransitionMs)
  }
  if (!previous || current.landmarkBeta !== previous.landmarkBeta) {
    player.controlFx(MOZZA_FX_NAME, 'beta', current.landmarkBeta)
  }
  if (!previous || current.smoothingCutoff !== previous.smoothingCutoff) {
    player.controlFx(MOZZA_FX_NAME, 'fc', current.smoothingCutoff)
  }
  if (!previous || current.faceThreshold !== previous.faceThreshold) {
    player.polyControlFx(MOZZA_FX_NAME, 'face-thresh', 'double', current.faceThreshold)
  }
}
