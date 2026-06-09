import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, sanitize } from './path-utils'

type SessionMetadata = {
  studyId: string
  dyadId: string
  participantId: string
  partnerId: string
  raId: string
  condition: string
  roomId: string
  outputFolder: string
}

const safeSegment = (value: string, fallback: string): string => {
  const trimmed = sanitize(value).trim()
  return trimmed.length > 0 ? trimmed : fallback
}

const timestampSegment = (): string => new Date().toISOString().replace(/[:.]/g, '-')

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: 'DuckSoup Conference Lab',
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('edu.wisc.niedenthal.ducksoupconference')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('select-output-folder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Select session output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('create-session-directory', async (_, metadata: SessionMetadata) => {
    const folderName = [
      safeSegment(metadata.studyId, 'study'),
      safeSegment(metadata.dyadId, 'dyad'),
      safeSegment(metadata.participantId, 'participant'),
      timestampSegment()
    ].join('_')

    const sessionDir = join(metadata.outputFolder, folderName)
    await mkdir(sessionDir, { recursive: true })
    await mkdir(join(sessionDir, 'video'), { recursive: true })
    await mkdir(join(sessionDir, 'data'), { recursive: true })
    return { sessionDir }
  })

  ipcMain.handle(
    'save-blob',
    async (_, payload: { sessionDir: string; filename: string; buffer: ArrayBuffer }) => {
      const filePath = join(payload.sessionDir, 'video', safeSegment(payload.filename, 'recording.webm'))
      await writeFile(filePath, Buffer.from(payload.buffer))
      return filePath
    }
  )

  ipcMain.handle(
    'write-text-file',
    async (_, payload: { sessionDir: string; filename: string; contents: string }) => {
      const filePath = join(payload.sessionDir, 'data', safeSegment(payload.filename, 'session.txt'))
      await writeFile(filePath, payload.contents, 'utf8')
      return filePath
    }
  )

  ipcMain.handle('check-ducksoup', async (_, baseUrl: string) => {
    try {
      const url = new URL('/test/mirror/', baseUrl)
      const response = await fetch(url, { method: 'GET' })
      const reachable = response.ok || response.status === 401
      return {
        ok: reachable,
        status: response.status,
        detail: reachable
          ? 'DuckSoup server is reachable.'
          : `HTTP ${response.status}`
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        detail: error instanceof Error ? error.message : 'DuckSoup is not reachable.'
      }
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
