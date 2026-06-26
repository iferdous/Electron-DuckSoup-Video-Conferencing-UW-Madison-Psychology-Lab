import http from 'node:http'

const port = Number(process.env.PORT || 8765)
const serviceName = process.env.SERVICE_NAME || 'Niedenthal Emotions Lab Signaling'
const signalClients = new Map()

const jsonResponse = (response, status, payload) => {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  })
  response.end(JSON.stringify(payload))
}

const htmlResponse = (response, status, html) => {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/html; charset=utf-8'
  })
  response.end(html)
}

const readJsonBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const sendSignalEvent = (client, type, payload) => {
  client.response.write(`data: ${JSON.stringify({ type, payload })}\n\n`)
}

const roomClients = (roomId) => [...signalClients.values()].filter((client) => client.roomId === roomId)

const roomPeers = (roomId) => {
  const unique = new Map()
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

const peerPayload = (client) => ({
  userId: client.userId,
  role: client.role,
  displayName: client.displayName,
  joinedAt: client.joinedAt,
  participantId: client.participantId
})

const broadcastSignalEvent = (roomId, type, payload, exceptClientId, toUserId) => {
  for (const client of roomClients(roomId)) {
    if (client.id === exceptClientId) continue
    if (toUserId && client.userId !== toUserId) continue
    sendSignalEvent(client, type, payload)
  }
}

const broadcastSignalEventWhere = (roomId, type, payload, predicate) => {
  for (const client of roomClients(roomId)) {
    if (predicate(client)) sendSignalEvent(client, type, payload)
  }
}

const removeSignalClient = (client, notify = true, closeResponse = false) => {
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

const joinPage = (requestUrl) => {
  const roomId = requestUrl.searchParams.get('roomId') || ''
  const studyId = requestUrl.searchParams.get('studyId') || 'NELF2026'
  const sessionFormat = requestUrl.searchParams.get('format') || 'dyad'
  const dyadId = requestUrl.searchParams.get('dyadId') || ''
  const link = requestUrl.toString()

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Niedenthal Emotions Lab Session</title>
    <style>
      body { margin: 0; background: #0a0f1e; color: #e7edf7; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
      section { border: 1px solid #263246; border-radius: 10px; background: #111827; padding: 24px; }
      h1 { margin: 0 0 10px; font-size: 30px; }
      p { color: #a8b3c7; line-height: 1.55; }
      dl { display: grid; grid-template-columns: 150px 1fr; gap: 12px; border-top: 1px solid #263246; padding-top: 18px; }
      dt { color: #8d98ad; font-weight: 800; text-transform: uppercase; font-size: 12px; }
      dd { margin: 0; overflow-wrap: anywhere; }
      code { background: #0d1423; border: 1px solid #263246; border-radius: 6px; padding: 3px 6px; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Niedenthal Emotions Lab Session</h1>
        <p>Open the desktop app, paste this session link into the participant setup screen, then join the room.</p>
        <dl>
          <dt>Study</dt><dd>${studyId}</dd>
          <dt>Format</dt><dd>${sessionFormat}</dd>
          <dt>Meeting ID</dt><dd><code>${roomId}</code></dd>
          <dt>Session ID</dt><dd>${dyadId || 'not set'}</dd>
          <dt>Link</dt><dd><code>${link}</code></dd>
        </dl>
      </section>
    </main>
  </body>
</html>`
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      jsonResponse(response, 204, {})
      return
    }

    const url = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`)

    if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/join')) {
      htmlResponse(response, 200, joinPage(url))
      return
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/health') {
      jsonResponse(response, 200, {
        ok: true,
        service: serviceName,
        rooms: [...new Set([...signalClients.values()].map((client) => client.roomId))],
        peers: signalClients.size,
        checkedAt: new Date().toISOString()
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
      const role = requestedRole === 'director' ? 'controller' : requestedRole || 'participant'
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
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no'
      })
      response.write(': connected\n\n')

      for (const existing of roomClients(roomId)) {
        if (existing.userId === userId) removeSignalClient(existing, false, true)
      }

      const client = {
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

      request.on('close', () => removeSignalClient(client, true))
      return
    }

    if (request.method === 'POST' && url.pathname === '/leave') {
      const message = await readJsonBody(request)
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
      const message = await readJsonBody(request)
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
      const message = await readJsonBody(request)
      if (!message.roomId || !message.from) {
        jsonResponse(response, 400, { ok: false, error: 'Missing roomId or from.' })
        return
      }
      broadcastSignalEvent(message.roomId, 'director-control', message)
      jsonResponse(response, 200, { ok: true })
      return
    }

    if (request.method === 'POST' && url.pathname === '/chat') {
      const message = await readJsonBody(request)
      const text = typeof message.text === 'string' ? message.text.trim() : ''
      if (!message.roomId || !message.from || !text) {
        jsonResponse(response, 400, { ok: false, error: 'Missing roomId, sender, or message text.' })
        return
      }

      const payload = {
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

server.listen(port, '0.0.0.0', () => {
  console.log(`${serviceName} listening on 0.0.0.0:${port}`)
})

const shutdown = () => {
  for (const client of signalClients.values()) {
    if (client.heartbeat) clearInterval(client.heartbeat)
    if (!client.response.destroyed) client.response.end()
  }
  signalClients.clear()
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
