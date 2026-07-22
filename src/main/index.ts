import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, session, shell, systemPreferences } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import dgram, { type Socket } from 'node:dgram'
import { mkdir, writeFile, readdir, copyFile, stat, readFile } from 'node:fs/promises'
import http, { type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import { extname, normalize } from 'node:path'
import { join, sanitize, dirname } from './path-utils'

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
  connectionId?: string
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
  connectionId?: string
  senderRole?: CallRole
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

// Fix F: the packaged renderer is served from a privileged custom `app://` scheme instead of
// file:// so it gets a stable web origin (`app://bundle`). That origin is accepted by the
// DuckSoup SFU WS-origin allowlist and lets MediaPipe fetch() local wasm/model assets.
// IMPORTANT: DUCKSOUP_ALLOWED_WS_ORIGINS must include `app://bundle` for production
// (the env file is edited separately). This only affects the packaged build; `npm run dev`
// still loads the electron-vite dev server URL and is untouched.
const APP_SCHEME = 'app'
const APP_HOST = 'bundle'

const RENDERER_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

// Must run before the app is ready (module top level satisfies that).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

let advertisementSocket: Socket | null = null
let advertisementTimer: NodeJS.Timeout | null = null
let callSignalServer: Server | null = null
let callSignalServerPort: number | null = null
// Fix A: set by the renderer via 'set-saving-state' while a save/recording write is in flight,
// so quitting/closing the window waits instead of truncating the file.
let isSaving = false
const signalClients = new Map<string, SignalClient>()

// Fix H: a single dead SSE socket or a stray async throw must never take down the whole main
// process (and with it every room's signaling). Log and keep running. The per-request handlers
// still guard their own writes; this is the last-resort backstop the standalone server has too.
process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

// Fix F: serve the packaged renderer output dir over app://bundle/<path>. `/` and missing
// paths fall back to index.html. Paths are normalized to stay inside the renderer dir.
const registerRendererProtocol = (): void => {
  const rendererDir = join(__dirname, '../renderer')
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url)
      let relativePath = decodeURIComponent(requestUrl.pathname)
      if (!relativePath || relativePath === '/') relativePath = '/index.html'
      const safeRelative = normalize(relativePath).replace(/^([\\/]|\.\.[\\/])+/, '')
      const filePath = join(rendererDir, safeRelative)
      const body = await readFile(filePath)
      const contentType = RENDERER_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'Content-Type': contentType } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

const safeSegment = (value: string, fallback: string): string => {
  const trimmed = sanitize(value).trim()
  return trimmed.length > 0 ? trimmed : fallback
}

const timestampSegment = (): string => new Date().toISOString().replace(/[:.]/g, '-')

// Candidate roots for DuckSoup's server-side recording volume (docker/ducksoup/data), tried in
// order. The env override and packaged-exe locations keep this working in a packaged build where
// process.cwd()/getAppPath() no longer point at the repo; dev (cwd = repo root) resolves first.
// Called lazily from handlers (after app is ready), so app.getAppPath/getPath are safe here.
const duckSoupDataRootCandidates = (): string[] =>
  [
    process.env.SYNCLINK_DUCKSOUP_DATA,
    join(process.cwd(), 'docker', 'ducksoup', 'data'),
    join(app.getAppPath(), 'docker', 'ducksoup', 'data'),
    join(dirname(app.getPath('exe')), 'docker', 'ducksoup', 'data')
  ].filter((root): root is string => Boolean(root))

const localAddresses = (): string[] => {
  const interfaces = os.networkInterfaces()
  return Object.values(interfaces)
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address)
}

// Fix E: prefer a real private-LAN address over the first NIC, which on Windows is often a
// WSL/Hyper-V virtual adapter. Order: 192.168.* > 10.* > 172.16-31.* > other, and push
// 169.254.* link-local addresses last.
const lanAddressRank = (address: string): number => {
  if (/^192\.168\./.test(address)) return 0
  if (/^10\./.test(address)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2
  if (/^169\.254\./.test(address)) return 4
  return 3
}

const firstLanAddress = (): string => {
  const best = localAddresses()
    .map((address, index) => ({ address, index, rank: lanAddressRank(address) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]
  return best?.address ?? '127.0.0.1'
}

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
  // Fix B: never write to a dead SSE socket; drop the client instead of throwing.
  if (client.response.destroyed || client.response.writableEnded) {
    removeSignalClient(client, false)
    return
  }
  try {
    client.response.write(`data: ${JSON.stringify({ type, payload })}\n\n`)
  } catch {
    removeSignalClient(client, false)
  }
}

const roomClients = (roomId: string): SignalClient[] =>
  [...signalClients.values()].filter((client) => client.roomId === roomId)

// Fix H: only a peer that actually holds a live SSE connection in a room may push signals or
// director-control into it. Blocks a departed/duplicate/rogue LAN client from injecting fake
// smile cues, WebRTC offers, or experimenter control messages by knowing only the roomId.
const userInRoom = (roomId: string, userId: string): boolean =>
  roomClients(roomId).some((client) => client.userId === userId)

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
            serverEpochMs: Date.now(),
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
          const connectionId = url.searchParams.get('connectionId')?.trim() || ''

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
          // Fix H: enable TCP keepalive so a silently dropped peer (sleep / Wi-Fi loss / NAT
          // timeout — no FIN/RST) is detected and evicted in seconds instead of lingering as a
          // ghost that keeps bothParticipantsPresent true and the call timer running. Disable the
          // socket idle timeout so the long-lived SSE stream is never closed for being quiet.
          try {
            request.socket.setKeepAlive(true, 15000)
            request.socket.setTimeout(0)
          } catch {
            // best effort — not all socket types support these
          }
          try {
            response.write(': connected\n\n')
          } catch {
            return
          }

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
            connectionId,
            response,
            joinedAt: Date.now()
          }
          signalClients.set(client.id, client)
          client.heartbeat = setInterval(() => {
            // Fix B: drop the client if its socket is gone; guard the keepalive write too.
            if (response.destroyed || response.writableEnded) {
              removeSignalClient(client, true)
              return
            }
            try {
              response.write(': keepalive\n\n')
            } catch {
              removeSignalClient(client, true)
            }
          }, 10000)
          sendSignalEvent(client, 'hello', {
            peer: peerPayload(client),
            peers: roomPeers(roomId),
            serverEpochMs: Date.now()
          })
          broadcastSignalEvent(roomId, 'peer-joined', { peer: peerPayload(client) }, client.id)
          broadcastSignalEvent(roomId, 'peer-list', { peers: roomPeers(roomId) })

          // Fix B: a socket error should also evict the client.
          response.on('error', () => {
            removeSignalClient(client, true)
          })
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

          // Fix B: only evict the caller's own connection. With a connectionId, scope the
          // removal to that exact connection so a stale duplicate cannot drop a live one.
          const from = message.from
          const connectionId = typeof message.connectionId === 'string' ? message.connectionId : ''
          for (const client of roomClients(message.roomId)) {
            // Scope by connectionId when given; a leave with none only removes connections that
            // also have none, so a stale/early leave can't kick an already-rejoined peer.
            const matches = connectionId ? client.connectionId === connectionId : !client.connectionId
            if (client.userId === from && matches) {
              removeSignalClient(client, true, true)
            }
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
          // Fix H: only a live member of the room may relay signals (smile cues, WebRTC
          // offers/answers/candidates, monitor negotiation) through it.
          if (!userInRoom(message.roomId, message.from)) {
            jsonResponse(response, 403, { ok: false, error: 'Sender is not in this room.' })
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
          // Fix H: gate director-control on room membership unconditionally (the standalone
          // server does; the embedded one previously only checked when a connectionId was
          // present, so a message that omitted it could broadcast control to any room).
          if (!userInRoom(message.roomId, message.from)) {
            jsonResponse(response, 403, { ok: false, error: 'Sender is not in this room.' })
            return
          }
          // Fix B: when a connectionId is supplied, verify the sender owns that live
          // connection and stamp the authoritative role before relaying; drop if unknown.
          const connectionId = typeof message.connectionId === 'string' ? message.connectionId : ''
          if (connectionId) {
            const sender = roomClients(message.roomId).find(
              (client) => client.userId === message.from && client.connectionId === connectionId
            )
            if (!sender) {
              jsonResponse(response, 200, { ok: true })
              return
            }
            message.senderRole = sender.role
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
        // Fix H: on the SSE /events path the headers are already sent, so calling jsonResponse
        // (which writes headers again) would throw a second time inside the catch → unhandled
        // rejection. Only send a JSON error if the response hasn't started; otherwise just end it.
        if (!response.headersSent) {
          jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : 'Signal server error.' })
        } else {
          try {
            response.end()
          } catch {
            // socket already gone
          }
        }
      }
    })

    // Fix C: surface a clear message on port conflicts and close the failed server so it
    // does not leak; other errors reject as before.
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error?.code === 'EADDRINUSE') {
        try {
          server.close()
        } catch {
          // server never started listening; nothing to clean up
        }
        reject(new Error(`Call signal server port ${port} is already in use — close other app instances.`))
        return
      }
      reject(error)
    })
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
  // Fix H: clear each client's heartbeat BEFORE emptying the map. If we cleared the map first,
  // the still-armed 10 s heartbeats would fire, call removeSignalClient, hit its `!removed`
  // early-return, and never clear themselves — leaking a timer (and the retained socket) forever.
  for (const client of signalClients.values()) {
    if (client.heartbeat) clearInterval(client.heartbeat)
    try {
      client.response.end()
    } catch {
      // socket already closed
    }
  }
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
    title: 'SyncLink',
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
    // DEV: electron-vite dev server — leave completely unchanged.
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    // Fix F: PROD loads via the privileged app:// scheme (origin app://bundle) instead of
    // loadFile's file:// origin. DUCKSOUP_ALLOWED_WS_ORIGINS must include `app://bundle`.
    mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`)
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular')
    app.dock?.show()
  }

  electronApp.setAppUserModelId('edu.wisc.niedenthal.emotionslab')

  // Fix F: wire up the app:// scheme so the production window can load app://bundle/index.html.
  registerRendererProtocol()

  // Fix G2: Chromium routes every getUserMedia / device request through the session permission
  // handlers. With none registered, our custom `app://bundle` origin is treated as an
  // un-established permission on each request, which (on top of the unsigned-app TCC problem) is a
  // classic cause of repeated media prompts and silent denials. This app IS the only content it
  // ever loads, so grant camera/mic for our own renderer origins and remember devices.
  const isTrustedRendererOrigin = (origin?: string | null): boolean =>
    !!origin && (origin === `${APP_SCHEME}://${APP_HOST}` || origin.startsWith('http://localhost'))
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === 'media') return isTrustedRendererOrigin(requestingOrigin)
    return false
  })
  session.defaultSession.setDevicePermissionHandler(() => true)

  // Fix G: request camera + microphone access once, up front, on macOS, and AWAIT them before the
  // window (and therefore any getUserMedia) can exist. The app otherwise only triggers the OS
  // permission prompt via getUserMedia *inside* a call, where DuckSoup's 15 s fill-or-abort window
  // can tear the prompt down before macOS commits the grant — so the mic kept re-prompting forever.
  // Prompting at launch, outside any call, and blocking window creation until the user answers
  // gives macOS a calm moment to record the grant. Awaited sequentially (mic then camera) so the
  // two prompts don't race for the single TCC UI slot. Non-fatal if it throws (already
  // granted / denied) — the in-call request still runs.
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone')
    } catch {
      // already granted or denied — nothing to do
    }
    try {
      await systemPreferences.askForMediaAccess('camera')
    } catch {
      // already granted or denied — nothing to do
    }
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Fix A: the renderer flips this while writing recordings/session data so a quit does not
  // truncate an in-progress save.
  ipcMain.on('set-saving-state', (_e, saving) => {
    isSaving = Boolean(saving)
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

    const outputRoot = metadata.outputFolder || join(app.getPath('documents'), 'SyncLink Sessions')
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
      // Ensure the target dir exists even if createSessionDirectory wasn't the caller's first step.
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, Buffer.from(payload.buffer))
      return filePath
    }
  )

  ipcMain.handle(
    'write-text-file',
    async (_, payload: { sessionDir: string; filename: string; contents: string }) => {
      const filePath = join(payload.sessionDir, 'data', safeSegment(payload.filename, 'session.txt'))
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, payload.contents, 'utf8')
      return filePath
    }
  )

  ipcMain.handle('check-ducksoup', async (_, baseUrl: string) => {
    // Bound the probe so a routable-but-dead address (SYN black-hole) can't hang the setup
    // "Continue" button on the OS TCP timeout.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const mirrorUrl = new URL('/test/mirror/', baseUrl)
      const scriptUrl = new URL('/assets/v1.93/js/ducksoup.js', baseUrl)
      const [mirrorResponse, scriptResponse] = await Promise.all([
        fetch(mirrorUrl, { method: 'GET', signal: controller.signal }),
        fetch(scriptUrl, { method: 'GET', signal: controller.signal })
      ])
      const mirrorReachable = mirrorResponse.ok || mirrorResponse.status === 401
      const scriptReachable = scriptResponse.ok || scriptResponse.status === 401
      const reachable = mirrorReachable && scriptReachable
      return {
        ok: reachable,
        status: reachable ? 200 : scriptResponse.status || mirrorResponse.status,
        detail: reachable
          ? 'DuckSoup/Mozza media server is reachable.'
          : !mirrorReachable
            ? `DuckSoup mirror page did not respond correctly (HTTP ${mirrorResponse.status}).`
            : `DuckSoup client asset is missing or blocked (HTTP ${scriptResponse.status}).`
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        status: 0,
        detail: aborted
          ? 'Media server did not respond within 5 seconds.'
          : error instanceof Error
            ? error.message
            : 'Local media server is not reachable.'
      }
    } finally {
      clearTimeout(timer)
    }
  })

  // Best-effort copy of DuckSoup's server-side recordings (clean -dry + altered -wet) into
  // the session output folder. Only works when the media server runs on this machine (the
  // data volume is docker/ducksoup/data). When the server is remote, returns copied: [] and
  // the caller keeps the server-side paths in the manifest.
  ipcMain.handle(
    'collect-ducksoup-recordings',
    async (_, payload: { destDir: string; namespace: string; interaction: string; sinceEpochMs?: number }) => {
      // Fix C (H3): candidate data roots keep this working in a packaged build where
      // process.cwd()/getAppPath() no longer point at the repo (see duckSoupDataRootCandidates).
      const candidateRoots = duckSoupDataRootCandidates()
      const copied: string[] = []
      const copiedPaths: string[] = []
      let dataDir: string | null = null

      // Fix C: when the caller passes the interaction start time, skip recordings left over
      // from earlier interactions that reused this room folder. 5s buffer absorbs mtime skew.
      const sinceEpochMs =
        typeof payload.sinceEpochMs === 'number' && payload.sinceEpochMs > 0 ? payload.sinceEpochMs : 0
      const cutoffMs = sinceEpochMs > 0 ? sinceEpochMs - 5000 : 0

      for (const root of candidateRoots) {
        const recordingsDir = join(
          root,
          safeSegment(payload.namespace, 'default'),
          safeSegment(payload.interaction, 'interaction'),
          'recordings'
        )
        try {
          const entries = await readdir(recordingsDir)
          const allMedia = entries.filter((name) => /\.(webm|mp4|mkv|ogg)$/i.test(name))
          if (allMedia.length === 0) continue
          dataDir = recordingsDir

          let media = allMedia
          if (cutoffMs > 0) {
            const fresh: string[] = []
            for (const name of allMedia) {
              try {
                const info = await stat(join(recordingsDir, name))
                if (info.mtimeMs >= cutoffMs) fresh.push(name)
              } catch {
                // If the file cannot be stat'd, err on the side of copying it.
                fresh.push(name)
              }
            }
            media = fresh
          }

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
      // Rank-sorted (192.168 > 10 > 172.16-31 > other > 169.254 link-local) so the renderer's
      // media-URL prefill picks a real LAN address, not a WSL/Hyper-V virtual adapter that a
      // participant machine can't reach.
      addresses: [...localAddresses()].sort((a, b) => lanAddressRank(a) - lanAddressRank(b))
    }
  })

  // Absolute paths so the UI can show exactly where recordings land on this computer:
  // the DuckSoup server-side recordings (dry/wet .mp4) and the default session output folder.
  ipcMain.handle('get-storage-paths', async () => {
    // Fix H: resolve the same candidate roots collect-ducksoup-recordings uses and prefer the
    // first that exists, so a packaged build shows a real path (there, process.cwd() is the launch
    // dir, not the repo, so the old join(process.cwd(), …) pointed at a folder that doesn't exist).
    const candidates = duckSoupDataRootCandidates()
    let serverDataDir = candidates[0] ?? join(process.cwd(), 'docker', 'ducksoup', 'data')
    for (const root of candidates) {
      try {
        await stat(root)
        serverDataDir = root
        break
      } catch {
        // try the next candidate
      }
    }
    return {
      serverDataDir,
      sessionsDir: join(app.getPath('documents'), 'SyncLink Sessions')
    }
  })

  ipcMain.handle('copy-text-to-clipboard', async (_, value: string) => {
    clipboard.writeText(value)
    return { ok: true }
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

// Fix A: if the renderer is mid-save (isSaving), block the quit and poll until the save
// clears, then quit — instead of tearing the process down and truncating the file. When
// idle, quitting proceeds normally (unchanged behavior).
// Cap the save-wait so a renderer that crashes mid-save (isSaving stuck true) can't wedge the
// app open forever — force the quit after this deadline.
const MAX_SAVE_WAIT_MS = 15_000

app.on('before-quit', (event) => {
  if (!isSaving) return
  event.preventDefault()
  const deadline = Date.now() + MAX_SAVE_WAIT_MS
  const waitThenQuit = (): void => {
    if (isSaving && Date.now() < deadline) {
      setTimeout(waitThenQuit, 200)
      return
    }
    app.quit()
  }
  setTimeout(waitThenQuit, 200)
})

app.on('window-all-closed', () => {
  stopAdvertisement()
  stopCallSignalServer()
  if (process.platform === 'darwin') return
  const deadline = Date.now() + MAX_SAVE_WAIT_MS
  const quitWhenIdle = (): void => {
    if (isSaving && Date.now() < deadline) {
      setTimeout(quitWhenIdle, 200)
      return
    }
    app.quit()
  }
  quitWhenIdle()
})
