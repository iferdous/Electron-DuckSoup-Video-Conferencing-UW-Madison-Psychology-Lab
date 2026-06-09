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
    ipcRenderer.invoke('check-ducksoup', baseUrl)
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
