import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

type SseMessage = {
  type: string
  payload?: {
    from?: string
    to?: string
    type?: string
    payload?: unknown
  }
}

const processes: ChildProcess[] = []

const waitForHealth = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Signaling server did not become healthy.')
}

const connectEvents = async (
  baseUrl: string,
  roomId: string,
  userId: string,
  controller: AbortController,
  role = 'participant',
  connectionId = '',
  participantId = ''
) => {
  const params = new URLSearchParams({
    roomId,
    userId,
    role,
    displayName: userId
  })
  if (connectionId) params.set('connectionId', connectionId)
  if (participantId) params.set('participantId', participantId)
  const response = await fetch(
    `${baseUrl}/events?${params.toString()}`,
    { signal: controller.signal }
  )
  if (!response.ok || !response.body) throw new Error(`Could not connect ${userId} to signaling events.`)
  return response.body.getReader()
}

const waitForSignal = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signalType: string
): Promise<SseMessage> => {
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out waiting for ${signalType}.`)), 3_000)
      )
    ])
    if (read.done) throw new Error('Signaling event stream closed unexpectedly.')
    buffer += decoder.decode(read.value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const line = block
        .split('\n')
        .find((candidate) => candidate.startsWith('data: '))
      if (!line) continue
      const message = JSON.parse(line.slice(6)) as SseMessage
      if (message.type === 'signal' && message.payload?.type === signalType) return message
    }
  }
  throw new Error(`Timed out waiting for ${signalType}.`)
}

const expectNoSignal = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signalType: string,
  timeoutMs = 250
): Promise<void> => {
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const read = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining))
    ])
    if (!read) return
    if (read.done) return
    const text = decoder.decode(read.value, { stream: true })
    for (const block of text.split('\n\n')) {
      const line = block
        .split('\n')
        .find((candidate) => candidate.startsWith('data: '))
      if (!line) continue
      const message = JSON.parse(line.slice(6)) as SseMessage
      expect(message.payload?.type).not.toBe(signalType)
    }
  }
}

afterEach(() => {
  for (const child of processes.splice(0)) child.kill('SIGTERM')
})

describe('smile synchrony signaling', () => {
  it('delivers matched participant onset and offset cues directly to the intended partner', async () => {
    const port = 18_000 + Math.floor(Math.random() * 1_000)
    const baseUrl = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server/signaling-server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    })
    processes.push(child)
    await waitForHealth(baseUrl)

    const p1Abort = new AbortController()
    const p2Abort = new AbortController()
    const p1Reader = await connectEvents(baseUrl, 'smile-room', 'p1', p1Abort)
    const p2Reader = await connectEvents(baseUrl, 'smile-room', 'p2', p2Abort)
    const cue = {
      eventId: 'smile-p1-1',
      cue: 'smile-onset',
      sourceUserId: 'p1',
      sourceParticipantId: 'P001',
      targetUserId: 'p2',
      observedAtEpochMs: Date.now(),
      normalizedSmile: 0.72
    }

    const response = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'smile-room',
        from: 'p1',
        to: 'p2',
        type: 'smile-onset-cue',
        payload: cue,
        role: 'participant',
        displayName: 'P1'
      })
    })
    expect(response.ok).toBe(true)

    const delivered = await waitForSignal(p2Reader, 'smile-onset-cue')
    expect(delivered.payload?.from).toBe('p1')
    expect(delivered.payload?.to).toBe('p2')
    expect(delivered.payload?.payload).toMatchObject(cue)

    const offset = {
      eventId: cue.eventId,
      cue: 'smile-offset',
      sourceUserId: 'p1',
      sourceParticipantId: 'P001',
      targetUserId: 'p2',
      observedAtEpochMs: Date.now(),
      normalizedSmile: 0.08,
      smoothedNormalizedSmile: 0.1
    }
    const offsetResponse = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'smile-room',
        from: 'p1',
        to: 'p2',
        type: 'smile-offset-cue',
        payload: offset,
        role: 'participant',
        displayName: 'P1'
      })
    })
    expect(offsetResponse.ok).toBe(true)

    const deliveredOffset = await waitForSignal(p2Reader, 'smile-offset-cue')
    expect(deliveredOffset.payload?.from).toBe('p1')
    expect(deliveredOffset.payload?.to).toBe('p2')
    expect(deliveredOffset.payload?.payload).toMatchObject(offset)

    p1Abort.abort()
    p2Abort.abort()
    await p1Reader.cancel().catch(() => undefined)
    await p2Reader.cancel().catch(() => undefined)
  })

  it('routes experimenter monitor offers, answers, and ICE candidates only to the intended peer', async () => {
    const port = 19_000 + Math.floor(Math.random() * 1_000)
    const baseUrl = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server/signaling-server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    })
    processes.push(child)
    await waitForHealth(baseUrl)

    const p1Abort = new AbortController()
    const p2Abort = new AbortController()
    const controllerAbort = new AbortController()
    const p1Reader = await connectEvents(baseUrl, 'monitor-room', 'p1', p1Abort)
    const p2Reader = await connectEvents(baseUrl, 'monitor-room', 'p2', p2Abort)
    const controllerReader = await connectEvents(baseUrl, 'monitor-room', 'controller', controllerAbort, 'controller')

    const offerResponse = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'monitor-room',
        from: 'p1',
        to: 'controller',
        type: 'monitor-offer',
        payload: { sdp: { type: 'offer', sdp: 'fake' }, streamMap: [] },
        role: 'participant',
        displayName: 'P1'
      })
    })
    expect(offerResponse.ok).toBe(true)
    const offer = await waitForSignal(controllerReader, 'monitor-offer')
    expect(offer.payload?.from).toBe('p1')
    expect(offer.payload?.to).toBe('controller')
    await expectNoSignal(p2Reader, 'monitor-offer')

    const answerResponse = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'monitor-room',
        from: 'controller',
        to: 'p1',
        type: 'monitor-answer',
        payload: { type: 'answer', sdp: 'fake-answer' },
        role: 'controller',
        displayName: 'Experimenter'
      })
    })
    expect(answerResponse.ok).toBe(true)
    expect((await waitForSignal(p1Reader, 'monitor-answer')).payload?.to).toBe('p1')

    const candidateResponse = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'monitor-room',
        from: 'p1',
        to: 'controller',
        type: 'monitor-candidate',
        payload: { candidate: 'candidate', sdpMid: '0' },
        role: 'participant',
        displayName: 'P1'
      })
    })
    expect(candidateResponse.ok).toBe(true)
    expect((await waitForSignal(controllerReader, 'monitor-candidate')).payload?.to).toBe('controller')

    p1Abort.abort()
    p2Abort.abort()
    controllerAbort.abort()
    await p1Reader.cancel().catch(() => undefined)
    await p2Reader.cancel().catch(() => undefined)
    await controllerReader.cancel().catch(() => undefined)
  })

  it('keeps a rejoined station active when stale leave and signal messages arrive later', async () => {
    const port = 20_000 + Math.floor(Math.random() * 1_000)
    const baseUrl = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server/signaling-server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    })
    processes.push(child)
    await waitForHealth(baseUrl)

    const p1OldAbort = new AbortController()
    const p1NewAbort = new AbortController()
    const p2Abort = new AbortController()
    const p1OldReader = await connectEvents(baseUrl, 'rejoin-room', 'p1', p1OldAbort, 'participant', 'p1-old', 'P001')
    const p2Reader = await connectEvents(baseUrl, 'rejoin-room', 'p2', p2Abort, 'participant', 'p2-live', 'P002')
    const p1NewReader = await connectEvents(baseUrl, 'rejoin-room', 'p1', p1NewAbort, 'participant', 'p1-new', 'P001')

    const statusAfterRejoin = await fetch(`${baseUrl}/room?roomId=rejoin-room`).then((response) => response.json())
    expect(statusAfterRejoin.peers).toHaveLength(2)
    expect(statusAfterRejoin.peers.find((peer: { userId: string }) => peer.userId === 'p1')).toMatchObject({
      participantId: 'P001',
      connectionId: 'p1-new'
    })

    const staleLeave = await fetch(`${baseUrl}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'rejoin-room', from: 'p1', connectionId: 'p1-old' })
    })
    expect(staleLeave.ok).toBe(true)

    const statusAfterStaleLeave = await fetch(`${baseUrl}/room?roomId=rejoin-room`).then((response) => response.json())
    expect(statusAfterStaleLeave.peers).toHaveLength(2)
    expect(statusAfterStaleLeave.peers.find((peer: { userId: string }) => peer.userId === 'p1')).toMatchObject({
      participantId: 'P001',
      connectionId: 'p1-new'
    })

    const staleSignal = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'rejoin-room',
        from: 'p1',
        to: 'p2',
        type: 'offer',
        connectionId: 'p1-old',
        payload: { sdp: 'stale' }
      })
    })
    expect(staleSignal.ok).toBe(true)
    await expect(staleSignal.json()).resolves.toMatchObject({ ok: true, dropped: true, reason: 'stale-connection' })

    const currentSignal = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'rejoin-room',
        from: 'p1',
        to: 'p2',
        type: 'offer',
        connectionId: 'p1-new',
        payload: { sdp: 'current' }
      })
    })
    expect(currentSignal.ok).toBe(true)
    const delivered = await waitForSignal(p2Reader, 'offer')
    expect(delivered.payload?.from).toBe('p1')
    expect(delivered.payload?.connectionId).toBe('p1-new')
    expect(delivered.payload?.payload).toMatchObject({ sdp: 'current' })

    p1OldAbort.abort()
    p1NewAbort.abort()
    p2Abort.abort()
    await p1OldReader.cancel().catch(() => undefined)
    await p1NewReader.cancel().catch(() => undefined)
    await p2Reader.cancel().catch(() => undefined)
  })
})
