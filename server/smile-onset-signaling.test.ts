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

const connectEvents = async (baseUrl: string, roomId: string, userId: string, controller: AbortController) => {
  const response = await fetch(
    `${baseUrl}/events?roomId=${roomId}&userId=${userId}&role=participant&displayName=${userId}`,
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
})
