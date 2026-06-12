import type { ElectronAPI } from '@electron-toolkit/preload'

type DuckSoupCallbackMessage = {
  kind: string
  payload?: unknown
}

type DuckSoupPlayer = {
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

declare global {
  interface Window {
    electron: ElectronAPI
    researchApi: {
      selectOutputFolder: () => Promise<string | null>
      createSessionDirectory: (metadata: Record<string, string>) => Promise<{ sessionDir: string }>
      saveBlob: (payload: {
        sessionDir: string
        filename: string
        buffer: ArrayBuffer
      }) => Promise<string>
      writeTextFile: (payload: {
        sessionDir: string
        filename: string
        contents: string
      }) => Promise<string>
      checkDuckSoup: (baseUrl: string) => Promise<{ ok: boolean; status: number; detail: string }>
      getNetworkInfo: () => Promise<{ hostname: string; addresses: string[] }>
      advertiseDuckSoupHost: (payload: {
        serverName: string
        duckSoupUrl: string
        callSignalUrl?: string
        roomId: string
      }) => Promise<{ ok: boolean; detail: string; url?: string }>
      stopDuckSoupHostAdvertisement: () => Promise<{ ok: boolean }>
      discoverDuckSoupHosts: () => Promise<
        Array<{
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
        }>
      >
      startCallSignalServer: (port?: number) => Promise<{ ok: boolean; localUrl: string; lanUrl: string }>
      stopCallSignalServer: () => Promise<{ ok: boolean }>
      checkCallSignalServer: (baseUrl: string) => Promise<{ ok: boolean; status: number; detail: string }>
    }
    DuckSoup?: {
      render: (
        embedOptions: {
          callback: (message: DuckSoupCallbackMessage) => void
          stats?: boolean
          mountEl?: HTMLElement
        },
        peerOptions: {
          signalingUrl: string
          interactionName: string
          userId: string
          duration: number
          audioOnly?: boolean
          size?: number
          width?: number
          height?: number
          framerate?: number
          namespace?: string
          videoFormat?: 'H264' | 'VP8'
          recordingMode?: string
          gpu?: boolean
          audioFx?: string
          videoFx?: string
          overlay?: boolean
          logLevel?: number
          audio?: MediaTrackConstraints
          video?: MediaTrackConstraints
        }
      ) => Promise<DuckSoupPlayer>
    }
  }
}
