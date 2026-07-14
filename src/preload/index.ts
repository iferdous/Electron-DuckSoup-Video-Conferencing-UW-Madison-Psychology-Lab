import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const researchApi = {
  selectOutputFolder: (): Promise<string | null> => ipcRenderer.invoke('select-output-folder'),
  createSessionDirectory: (metadata: Record<string, string>): Promise<{ sessionDir: string }> =>
    ipcRenderer.invoke('create-session-directory', metadata),
  saveBlob: (payload: {
    sessionDir: string
    filename: string
    buffer: ArrayBuffer
  }): Promise<string> => ipcRenderer.invoke('save-blob', payload),
  writeTextFile: (payload: {
    sessionDir: string
    filename: string
    contents: string
  }): Promise<string> => ipcRenderer.invoke('write-text-file', payload),
  checkDuckSoup: (baseUrl: string): Promise<{ ok: boolean; status: number; detail: string }> =>
    ipcRenderer.invoke('check-ducksoup', baseUrl),
  getNetworkInfo: (): Promise<{ hostname: string; addresses: string[] }> =>
    ipcRenderer.invoke('get-network-info'),
  getStoragePaths: (): Promise<{ serverDataDir: string; sessionsDir: string }> =>
    ipcRenderer.invoke('get-storage-paths'),
  advertiseDuckSoupHost: (payload: {
    serverName: string
    duckSoupUrl: string
    callSignalUrl?: string
    roomId: string
  }): Promise<{ ok: boolean; detail: string; url?: string }> =>
    ipcRenderer.invoke('advertise-ducksoup-host', payload),
  stopDuckSoupHostAdvertisement: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('stop-ducksoup-host-advertisement'),
  discoverDuckSoupHosts: (): Promise<
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
  > => ipcRenderer.invoke('discover-ducksoup-hosts'),
  startCallSignalServer: (port?: number): Promise<{ ok: boolean; localUrl: string; lanUrl: string }> =>
    ipcRenderer.invoke('start-call-signal-server', port),
  stopCallSignalServer: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('stop-call-signal-server'),
  checkCallSignalServer: (baseUrl: string): Promise<{ ok: boolean; status: number; detail: string }> =>
    ipcRenderer.invoke('check-call-signal-server', baseUrl),
  collectDuckSoupRecordings: (payload: {
    destDir: string
    namespace: string
    interaction: string
    sinceEpochMs?: number
  }): Promise<{ copied: string[]; copiedPaths: string[]; dataDir: string | null }> =>
    ipcRenderer.invoke('collect-ducksoup-recordings', payload),
  setSavingState: (saving: boolean): void => ipcRenderer.send('set-saving-state', saving)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('researchApi', researchApi)
} else {
  const unsafeWindow = window as typeof window & {
    electron: typeof electronAPI
    researchApi: typeof researchApi
  }
  unsafeWindow.electron = electronAPI
  unsafeWindow.researchApi = researchApi
}
