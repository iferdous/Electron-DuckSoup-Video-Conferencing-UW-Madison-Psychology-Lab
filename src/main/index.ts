import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import dgram, { type Socket } from 'node:dgram'
import { mkdir, writeFile, readdir, copyFile } from 'node:fs/promises'
import http, { type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import { join, sanitize } from './path-utils'

type SessionMetadata = {
  serverName?: string
  studyId: string
  dyadId: string
  participantId: string
  partnerId: string
  raId: string
  condition: string
  roomId: string
  outputFolder: string
}

type HostAdvertisement = {
  serverName: string
  duckSoupUrl: string
  callSignalUrl?: string
  roomId: string
}

type DiscoveryPacket = {
  app: 'ducksoup-conference-lab'
  version: 1
  serverName: string
  hostName: string
  duckSoupUrl: string
  callSignalUrl: string
  roomId: string
  addresses: string[]
  port: number
  signalPort: number
  sentAt: number
}

type DiscoveredHost = {
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
}

type CallRole = 'participant' | 'controller'

type SignalClient = {
  id: string
  roomId: string
  userId: string
  role: CallRole
  displayName: string
  participantId: string
  response: ServerResponse
  joinedAt: number
  heartbeat?: NodeJS.Timeout
}

type SignalMessage = {
  roomId: string
  from: string
  to?: string
  type: string
  payload?: unknown
  role?: CallRole
  displayName?: string
}

type ChatMessage = {
  id?: string
  roomId: string
  from: string
  fromName: string
  fromRole: CallRole
  text: string
  sentAt?: string
  to?: string
  targetRole?: CallRole
}

const DISCOVERY_GROUP = '239.255.42.99'
const DISCOVERY_PORT = 44563
const DEFAULT_SIGNAL_PORT = 8765

let advertisementSocket: Socket | null = null
let advertisementTimer: NodeJS.Timeout | null = null
let callSignalServer: Server | null = null
let callSignalServerPort: number | null = null
const signalClients = new Map<string, SignalClient>()

const safeSegment = (value: string, fallback: string): string => {
  const trimmed = sanitize(value).trim()
  return trimmed.length > 0 ? trimmed : fallback
}

const timestampSegment = (): string => new Date().toISOString().replace(/[:.]/g, '-')

const localAddresses = (): string[] => {
  const interfaces = os.networkInterfaces()
  return Object.values(interfaces)
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address)
}

const firstLanAddress = (): string => localAddresses()[0] ?? '127.0.0.1'

const hostUrlFrom = (baseUrl: string, fallbackAddress = firstLanAddress(), fallbackPort = 8100): string => {
  try {
    const url = new URL(baseUrl)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = fallbackAddress
    }
    if (!url.port) url.port = String(fallbackPort)
    return url.toString().replace(/\/$/, '')
  } catch {
    return `http://${fallbackAddress}:${fallbackPort}`
  }
}

const stopAdvertisement = (): void => {
  if (advertisementTimer) {
    clearInterval(advertisementTimer)
    advertisementTimer = null
  }
  if (advertisementSocket) {
    advertisementSocket.close()
    advertisementSocket = null
  }
}

const startAdvertisement = (payload: HostAdvertisement): Promise<{ ok: boolean; detail: string; url?: string }> => {
  stopAdvertisement()

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    advertisementSocket = socket
    let resolved = false

    const finish = (result: { ok: boolean; detail: string; url?: string }): void => {
      if (resolved) return
      resolved = true
      resolve(result)
    }

    const address = firstLanAddress()
    const duckSoupUrl = hostUrlFrom(payload.duckSoupUrl, address, 8100)
    const callSignalUrl = hostUrlFrom(
      payload.callSignalUrl || `http://localhost:${callSignalServerPort ?? DEFAULT_SIGNAL_PORT}`,
      address,
      callSignalServerPort ?? DEFAULT_SIGNAL_PORT
    )
    const packet = (): Buffer =>
      Buffer.from(
        JSON.stringify({
          app: 'ducksoup-conference-lab',
          version: 1,
          serverName: payload.serverName.trim() || os.hostname(),
          hostName: os.hostname(),
          duckSoupUrl,
          callSignalUrl,
          roomId: payload.roomId,
          addresses: localAddresses(),
          port: 8100,
          signalPort: callSignalServerPort ?? DEFAULT_SIGNAL_PORT,
          sentAt: Date.now()
        } satisfies DiscoveryPacket)
      )

    const sendPacket = (): void => {
      const message = packet()
      socket.send(message, 0, message.length, DISCOVERY_PORT, DISCOVERY_GROUP)
      socket.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255')
    }

    socket.on('error', (error) => {
      stopAdvertisement()
      finish({ ok: false, detail: error.message })
    })

    socket.bind(() => {
      try {
        socket.setBroadcast(true)
        socket.setMulticastTTL(2)
        socket.setMulticastLoopback(true)
        sendPacket()
        advertisementTimer = setInterval(sendPacket, 1000)
        finish({ ok: true, detail: `Advertising local media server ${duckSoupUrl} and call server ${callSignalUrl}.`, url: duckSoupUrl })
      } catch (error) {
        stopAdvertisement()
        finish({ ok: false, detail: error instanceof Error ? error.message : 'Could not advertise host.' })
      }
    })
  })
}

const discoverHosts = (durationMs = 3500): Promise<DiscoveredHost[]> => {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map<string, DiscoveredHost>()
    let timer: NodeJS.Timeout | null = null

    const close = (): void => {
      if (timer) clearTimeout(timer)
      socket.close()
      resolve([...found.values()].sort((a, b) => b.seenAt - a.seenAt))
    }

    socket.on('message', (message, remoteInfo) => {
      try {
        const packet = JSON.parse(message.toString()) as Partial<DiscoveryPacket>
        if (packet.app !== 'ducksoup-conference-lab' || packet.version !== 1) return
        const address = remoteInfo.address
        const duckSoupUrl = hostUrlFrom(packet.duckSoupUrl || `http://${address}:8100`, address, 8100)
        const signalPort = packet.signalPort ?? DEFAULT_SIGNAL_PORT
        const callSignalUrl = hostUrlFrom(packet.callSignalUrl || `http://${address}:${signalPort}`, address, signalPort)
        const id = `${address}:${packet.port ?? 8100}:${signalPort}:${packet.roomId ?? ''}`
        found.set(id, {
          id,
          serverName: packet.serverName || packet.hostName || address,
          hostName: packet.hostName || address,
          duckSoupUrl,
          callSignalUrl,
          roomId: packet.roomId || '',
          address,
          port: packet.port ?? 8100,
          signalPort,
          seenAt: Date.now()
        })
      } catch {
        // Ignore unrelated multicast traffic.
      }
    })

    socket.on('error', close)

    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.addMembership(DISCOVERY_GROUP)
        socket.setBroadcast(true)
      } catch {
        // Some networks disallow multicast membership; broadcast packets can still arrive.
      }
      timer = setTimeout(close, durationMs)
    })
  })
}

const jsonResponse = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  })
  response.end(JSON.stringify(payload))
}

const readJsonBody = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const sendSignalEvent = (client: SignalClient, type: string, payload: unknown): void => {
  client.response.write(`data: ${JSON.stringify({ type, payload })}\n\n`)
}

const roomClients = (roomId: string): SignalClient[] =>
  [...signalClients.values()].filter((client) => client.roomId === roomId)

const roomPeers = (roomId: string): Array<Omit<SignalClient, 'id' | 'response' | 'roomId'>> => {
  const unique = new Map<string, Omit<SignalClient, 'id' | 'response' | 'roomId'>>()
  for (const client of roomClients(roomId)) {
    unique.set(client.userId, {
      userId: client.userId,
      role: client.role,
      displayName: client.displayName,
      joinedAt: client.joinedAt,
      participantId: client.participantId
    })
  }
  return [...unique.values()]
}

const peerPayload = (client: SignalClient): Omit<SignalClient, 'id' | 'response' | 'roomId'> => ({
  userId: client.userId,
  role: client.role,
  displayName: client.displayName,
  joinedAt: client.joinedAt,
  participantId: client.participantId
})

const removeSignalClient = (client: SignalClient, notify = true, closeResponse = false): void => {
  const removed = signalClients.delete(client.id)
  if (!removed) return

  if (client.heartbeat) clearInterval(client.heartbeat)
  if (closeResponse && !client.response.destroyed) client.response.end()

  if (notify) {
    broadcastSignalEvent(client.roomId, 'peer-left', {
      userId: client.userId,
      displayName: client.displayName,
      role: client.role
    })
    broadcastSignalEvent(client.roomId, 'peer-list', { peers: roomPeers(client.roomId) })
  }
}

const broadcastSignalEvent = (
  roomId: string,
  type: string,
  payload: unknown,
  exceptClientId?: string,
  toUserId?: string
): void => {
  for (const client of roomClients(roomId)) {
    if (client.id === exceptClientId) continue
    if (toUserId && client.userId !== toUserId) continue
    sendSignalEvent(client, type, payload)
  }
}

const broadcastSignalEventWhere = (
  roomId: string,
  type: string,
  payload: unknown,
  predicate: (client: SignalClient) => boolean
): void => {
  for (const client of roomClients(roomId)) {
    if (predicate(client)) sendSignalEvent(client, type, payload)
  }
}

const startCallSignalServer = (port = DEFAULT_SIGNAL_PORT): Promise<{ ok: boolean; localUrl: string; lanUrl: string }> => {
  if (callSignalServer) {
    const activePort = callSignalServerPort ?? port
    return Promise.resolve({
      ok: true,
      localUrl: `http://localhost:${activePort}`,
      lanUrl: `http://${firstLanAddress()}:${activePort}`
    })
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method === 'OPTIONS') {
          jsonResponse(response, 204, {})
          return
        }

        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${port}`}`)

        if (request.method === 'GET' && url.pathname === '/health') {
          jsonResponse(response, 200, {
            ok: true,
            rooms: [...new Set([...signalClients.values()].map((client) => client.roomId))]
          })
          return
        }

        if (request.method === 'GET' && url.pathname === '/room') {
          const roomId = url.searchParams.get('roomId')?.trim()
          if (!roomId) {
            jsonResponse(response, 400, { ok: false, error: 'Missing roomId.' })
            return
          }

          jsonResponse(response, 200, {
            ok: true,
            roomId,
            peers: roomPeers(roomId),
            checkedAt: new Date().toISOString()
          })
          return
        }

        if (request.method === 'GET' && url.pathname === '/events') {
          const roomId = url.searchParams.get('roomId')?.trim()
          const userId = url.searchParams.get('userId')?.trim()
          const requestedRole = url.searchParams.get('role')
          const role = requestedRole === 'director' ? 'controller' : ((requestedRole as CallRole | null) ?? 'participant')
          const displayName = url.searchParams.get('displayName')?.trim() || userId || 'Participant'
          const participantId = url.searchParams.get('participantId')?.trim() || ''

          if (!roomId || !userId || !['participant', 'controller'].includes(role)) {
            jsonResponse(response, 400, { ok: false, error: 'Missing roomId, userId, or role.' })
            return
          }

          response.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream'
          })
          response.write(': connected\n\n')

          for (const existing of roomClients(roomId)) {
            if (existing.userId === userId) {
              removeSignalClient(existing, false, true)
            }
          }

          const client: SignalClient = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            roomId,
            userId,
            role,
            displayName,
            participantId,
            response,
            joinedAt: Date.now()
          }
          signalClients.set(client.id, client)
          client.heartbeat = setInterval(() => {
            if (response.destroyed) {
              removeSignalClient(client, true)
              return
            }
            response.write(': keepalive\n\n')
          }, 10000)
          sendSignalEvent(client, 'hello', { peer: peerPayload(client), peers: roomPeers(roomId) })
          broadcastSignalEvent(roomId, 'peer-joined', { peer: peerPayload(client) }, client.id)
          broadcastSignalEvent(roomId, 'peer-list', { peers: roomPeers(roomId) })

          request.on('close', () => {
            removeSignalClient(client, true)
          })
          return
        }

        if (request.method === 'POST' && url.pathname === '/leave') {
          const message = (await readJsonBody(request)) as Partial<SignalMessage>
          if (!message.roomId || !message.from) {
            jsonResponse(response, 400, { ok: false, error: 'Missing roomId or from.' })
            return
          }

          for (const client of roomClients(message.roomId)) {
            if (client.userId === message.from) removeSignalClient(client, true, true)
          }

          jsonResponse(response, 200, { ok: true })
          return
        }

        if (request.method === 'POST' && url.pathname === '/signal') {
          const message = (await readJsonBody(request)) as SignalMessage
          if (!message.roomId || !message.from || !message.type) {
            jsonResponse(response, 400, { ok: false, error: 'Missing roomId, from, or type.' })
            return
          }
          broadcastSignalEvent(
            message.roomId,
            'signal',
            {
              from: message.from,
              to: message.to,
              type: message.type,
              payload: message.payload,
              role: message.role,
              displayName: message.displayName
            },
            undefined,
            message.to
          )
          jsonResponse(response, 200, { ok: true })
          return
        }

        if (request.method === 'POST' && url.pathname === '/director-control') {
          const message = (await readJsonBody(request)) as SignalMessage
          if (!message.roomId || !message.from) {
            jsonResponse(response, 400, { ok: false, error: 'Missing roomId or from.' })
            return
          }
          broadcastSignalEvent(message.roomId, 'director-control', message)
          jsonResponse(response, 200, { ok: true })
          return
        }

        if (request.method === 'POST' && url.pathname === '/chat') {
          const message = (await readJsonBody(request)) as ChatMessage
          const text = typeof message.text === 'string' ? message.text.trim() : ''
          if (!message.roomId || !message.from || !text) {
            jsonResponse(response, 400, { ok: false, error: 'Missing roomId, sender, or message text.' })
            return
          }

          const payload: ChatMessage = {
            id: message.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            roomId: message.roomId,
            from: message.from,
            fromName: message.fromName || 'Unknown',
            fromRole: message.fromRole,
            text,
            sentAt: message.sentAt || new Date().toISOString(),
            to: message.to,
            targetRole: message.targetRole
          }

          if (payload.to) {
            broadcastSignalEventWhere(payload.roomId, 'chat-message', payload, (client) => client.userId === payload.to || client.userId === payload.from)
          } else if (payload.targetRole) {
            broadcastSignalEventWhere(payload.roomId, 'chat-message', payload, (client) => client.role === payload.targetRole || client.userId === payload.from)
          } else {
            broadcastSignalEvent(payload.roomId, 'chat-message', payload)
          }

          jsonResponse(response, 200, { ok: true })
          return
        }

        jsonResponse(response, 404, { ok: false, error: 'Not found.' })
      } catch (error) {
        jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : 'Signal server error.' })
      }
    })

    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      callSignalServer = server
      callSignalServerPort = port
      resolve({
        ok: true,
        localUrl: `http://localhost:${port}`,
        lanUrl: `http://${firstLanAddress()}:${port}`
      })
    })
  })
}

const stopCallSignalServer = (): void => {
  for (const client of signalClients.values()) client.response.end()
  signalClients.clear()
  callSignalServer?.close()
  callSignalServer = null
  callSignalServerPort = null
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    x: 60,
    y: 80,
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    show: true,
    title: 'Niedenthal Emotions Lab',
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setBounds({ x: 60, y: 80, width: 1440, height: 920 })
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setBounds({ x: 60, y: 80, width: 1440, height: 920 })
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.error(`Renderer failed to load: ${errorCode} ${errorDescription}`)
    if (!mainWindow.isVisible()) mainWindow.show()
  })

  setTimeout(() => {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setBounds({ x: 60, y: 80, width: 1440, height: 920 })
    mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()
    app.focus({ steal: true })
  }, 1000)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular')
    app.dock?.show()
  }

  electronApp.setAppUserModelId('edu.wisc.niedenthal.emotionslab')

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

    const outputRoot = metadata.outputFolder || join(app.getPath('documents'), 'Niedenthal Emotions Lab Sessions')
    const sessionDir = join(outputRoot, folderName)
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
          ? 'Local media server is reachable.'
          : `HTTP ${response.status}`
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        detail: error instanceof Error ? error.message : 'Local media server is not reachable.'
      }
    }
  })

  // Best-effort copy of DuckSoup's server-side recordings (clean -dry + altered -wet) into
  // the session output folder. Only works when the media server runs on this machine (the
  // data volume is docker/ducksoup/data). When the server is remote, returns copied: [] and
  // the caller keeps the server-side paths in the manifest.
  ipcMain.handle(
    'collect-ducksoup-recordings',
    async (_, payload: { destDir: string; namespace: string; interaction: string }) => {
      const candidateRoots = [
        join(process.cwd(), 'docker', 'ducksoup', 'data'),
        join(app.getAppPath(), 'docker', 'ducksoup', 'data')
      ]
      const copied: string[] = []
      const copiedPaths: string[] = []
      let dataDir: string | null = null

      for (const root of candidateRoots) {
        const recordingsDir = join(
          root,
          safeSegment(payload.namespace, 'default'),
          safeSegment(payload.interaction, 'interaction'),
          'recordings'
        )
        try {
          const entries = await readdir(recordingsDir)
          const media = entries.filter((name) => /\.(webm|mp4|mkv|ogg)$/i.test(name))
          if (media.length === 0) continue
          dataDir = recordingsDir
          const destVideo = join(payload.destDir, 'video')
          await mkdir(destVideo, { recursive: true })
          for (const name of media) {
            const destination = join(destVideo, safeSegment(name, 'recording'))
            await copyFile(join(recordingsDir, name), destination)
            copied.push(name)
            copiedPaths.push(destination)
          }
          break
        } catch {
          // try the next candidate root
        }
      }

      return { copied, copiedPaths, dataDir }
    }
  )

  ipcMain.handle('get-network-info', () => {
    return {
      hostname: os.hostname(),
      addresses: localAddresses()
    }
  })

  // Absolute paths so the UI can show exactly where recordings land on this computer:
  // the DuckSoup server-side recordings (dry/wet .mp4) and the default session output folder.
  ipcMain.handle('get-storage-paths', () => {
    return {
      serverDataDir: join(process.cwd(), 'docker', 'ducksoup', 'data'),
      sessionsDir: join(app.getPath('documents'), 'Niedenthal Emotions Lab Sessions')
    }
  })

  ipcMain.handle('advertise-ducksoup-host', async (_, payload: HostAdvertisement) => {
    return startAdvertisement(payload)
  })

  ipcMain.handle('stop-ducksoup-host-advertisement', () => {
    stopAdvertisement()
    return { ok: true }
  })

  ipcMain.handle('discover-ducksoup-hosts', async () => discoverHosts())

  ipcMain.handle('start-call-signal-server', async (_, port?: number) => startCallSignalServer(port))

  ipcMain.handle('stop-call-signal-server', () => {
    stopCallSignalServer()
    return { ok: true }
  })

  ipcMain.handle('check-call-signal-server', async (_, baseUrl: string) => {
    try {
      const response = await fetch(new URL('/health', baseUrl))
      return {
        ok: response.ok,
        status: response.status,
        detail: response.ok ? 'Video call signal server is reachable.' : `HTTP ${response.status}`
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        detail: error instanceof Error ? error.message : 'Video call signal server is not reachable.'
      }
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopAdvertisement()
  stopCallSignalServer()
  if (process.platform !== 'darwin') app.quit()
})
