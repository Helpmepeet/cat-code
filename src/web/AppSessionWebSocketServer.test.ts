import { afterEach, describe, expect, test } from 'bun:test'
import { WebSocket } from 'ws'
import { AppSessionController } from '../app-runtime/AppSessionController.js'
import { startAppSessionWebSocketServer } from './AppSessionWebSocketServer.js'

const servers: Array<{ stop: () => Promise<void> | void }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop()
  }
})

type ConnectOptions = {
  host?: string
  origin?: string | null
}

function connect(
  url: string,
  token?: string,
  { host, origin = 'http://localhost:5173' }: ConnectOptions = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (origin !== null) headers.Origin = origin
    if (host) headers.Host = host
    const options =
      Object.keys(headers).length > 0 ? { headers } : undefined
    const ws = new WebSocket(url, token ? [`cat-code.${token}`] : [], options)
    ws.once('open', () => resolve(ws))
    ws.on('error', error => {
      reject(
        error instanceof Error ? error : new Error('WebSocket connection failed'),
      )
    })
  })
}

function nextJson(ws: WebSocket): Promise<unknown> {
  return new Promise(resolve => {
    ws.once('message', raw => resolve(JSON.parse(String(raw))))
  })
}

function closeWebSocket(ws: WebSocket): Promise<void> {
  return new Promise(resolve => {
    if (ws.readyState === ws.CLOSED) {
      resolve()
      return
    }

    ws.once('close', () => resolve())
    if (ws.readyState === ws.OPEN) {
      ws.close()
    }
  })
}

function collectJsonFor(ws: WebSocket, timeoutMs: number): Promise<unknown[]> {
  return new Promise(resolve => {
    const messages: unknown[] = []
    const onMessage = (raw: Buffer) => {
      messages.push(JSON.parse(String(raw)))
    }
    ws.on('message', onMessage)
    setTimeout(() => {
      ws.off('message', onMessage)
      resolve(messages)
    }, timeoutMs)
  })
}

function isIdleStatus(message: unknown): boolean {
  return (
    isObject(message) &&
    message.type === 'app.event' &&
    isObject(message.event) &&
    message.event.type === 'status.update' &&
    message.event.activeTurn === false &&
    message.event.inputEnabled === true
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe('AppSessionWebSocketServer', () => {
  test('requires the session token', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    await expect(connect(`ws://127.0.0.1:${server.port}/ws`)).rejects.toThrow()
  })

  test('requires an allowed origin', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    await expect(
      connect(`ws://127.0.0.1:${server.port}/ws`, 'secret', { origin: null }),
    ).rejects.toThrow()
  })

  test('rejects empty origin headers', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    await expect(
      connect(`ws://127.0.0.1:${server.port}/ws`, 'secret', { origin: '' }),
    ).rejects.toThrow()
  })

  test('rejects disallowed origin headers', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    await expect(
      connect(`ws://127.0.0.1:${server.port}/ws`, 'secret', {
        origin: 'http://evil.localhost:5173',
      }),
    ).rejects.toThrow()
  })

  test('rejects bad host headers', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    await expect(
      connect(`ws://127.0.0.1:${server.port}/ws`, 'secret', {
        host: 'evil.example:5173',
      }),
    ).rejects.toThrow()
  })

  test('stops accepting connections after stop resolves', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })

    await server.stop()

    await expect(connect(server.url, 'secret')).rejects.toThrow()
  })

  test('does not report idle when a concurrent submit is rejected', async () => {
    let releaseTurn: (() => void) | undefined
    const turnReleased = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const controller = new AppSessionController({
      async *runTurn() {
        await turnReleased
      },
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)
    const firstClient = await connect(
      `ws://127.0.0.1:${server.port}/ws`,
      'secret',
    )
    await nextJson(firstClient)
    const secondClient = await connect(
      `ws://127.0.0.1:${server.port}/ws`,
      'secret',
    )
    await nextJson(secondClient)

    firstClient.send(
      JSON.stringify({
        type: 'app.submit',
        requestId: 'submit-1',
        prompt: 'first',
      }),
    )
    expect(await nextJson(firstClient)).toEqual({
      type: 'app.ack',
      requestId: 'submit-1',
    })
    expect(await nextJson(firstClient)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: true,
        inputEnabled: false,
      },
    })
    const firstClientMessagesAfterSecondSubmit = collectJsonFor(firstClient, 50)
    const secondClientMessagesAfterSecondSubmit = collectJsonFor(secondClient, 50)
    secondClient.send(
      JSON.stringify({
        type: 'app.submit',
        requestId: 'submit-2',
        prompt: 'second',
      }),
    )
    const secondClientMessages = await secondClientMessagesAfterSecondSubmit
    expect(secondClientMessages).toContainEqual({
      type: 'app.ack',
      requestId: 'submit-2',
    })
    expect(
      secondClientMessages.find(
        message =>
          isObject(message) &&
          message.type === 'app.error' &&
          message.requestId === 'submit-2',
      ),
    ).toMatchObject({
      type: 'app.error',
      requestId: 'submit-2',
      code: 'turn_already_running',
      retryable: true,
    })
    expect(
      (await firstClientMessagesAfterSecondSubmit).some(isIdleStatus),
    ).toBe(false)

    releaseTurn?.()
    expect(await nextJson(firstClient)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: false,
        inputEnabled: true,
      },
    })
    await Promise.all([
      closeWebSocket(firstClient),
      closeWebSocket(secondClient),
    ])
  })

  test('sends input disabled in ready while a turn is active', async () => {
    let releaseTurn: (() => void) | undefined
    const turnReleased = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const controller = new AppSessionController({
      async *runTurn() {
        await turnReleased
      },
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)
    const activeClient = await connect(
      `ws://127.0.0.1:${server.port}/ws`,
      'secret',
    )
    expect(await nextJson(activeClient)).toMatchObject({
      type: 'app.ready',
      inputEnabled: true,
    })

    activeClient.send(
      JSON.stringify({
        type: 'app.submit',
        requestId: 'submit-1',
        prompt: 'first',
      }),
    )
    expect(await nextJson(activeClient)).toEqual({
      type: 'app.ack',
      requestId: 'submit-1',
    })
    expect(await nextJson(activeClient)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: true,
        inputEnabled: false,
      },
    })

    const midTurnClient = await connect(
      `ws://127.0.0.1:${server.port}/ws`,
      'secret',
    )
    expect(await nextJson(midTurnClient)).toMatchObject({
      type: 'app.ready',
      inputEnabled: false,
    })

    releaseTurn?.()
    await Promise.all([
      closeWebSocket(activeClient),
      closeWebSocket(midTurnClient),
    ])
  })

  test('sends ready then submits a prompt and relays mapped messages', async () => {
    const prompts: unknown[] = []
    const controller = new AppSessionController({
      async *runTurn({ prompt }) {
        prompts.push(prompt)
        yield {
          type: 'assistant',
          uuid: 'assistant-1',
          message: { content: [{ type: 'text', text: 'hello from runtime' }] },
        } as never
      },
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    const ws = await connect(`ws://127.0.0.1:${server.port}/ws`, 'secret')

    expect(await nextJson(ws)).toMatchObject({
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
    })

    ws.send(
      JSON.stringify({
        type: 'app.submit',
        requestId: 'submit-1',
        prompt: 'hi',
      }),
    )

    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'submit-1',
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: true,
        inputEnabled: false,
      },
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'message.append',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello from runtime',
          sdkType: 'assistant',
        },
      },
    })
    expect(prompts).toEqual(['hi'])
    await closeWebSocket(ws)
  })

  test('responds to pending permissions and aborts active turns', async () => {
    let permissionResponse: unknown
    let releaseTurn: (() => void) | undefined
    const turnReleased = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const controller = new AppSessionController({
      async *runTurn({ onPermissionRequest }) {
        permissionResponse = await onPermissionRequest({
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        })
        await turnReleased
      },
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)
    const ws = await connect(`ws://127.0.0.1:${server.port}/ws`, 'secret')
    await nextJson(ws)

    ws.send(JSON.stringify({ type: 'app.submit', requestId: 'submit-1', prompt: 'hi' }))
    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'submit-1',
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: true,
        inputEnabled: false,
      },
    })

    expect(await nextJson(ws)).toMatchObject({
      type: 'app.event',
      event: {
        type: 'permission.requested',
        request: { requestId: 'perm-1' },
      },
    })

    ws.send(
      JSON.stringify({
        type: 'permission.response',
        requestId: 'perm-1',
        response: {
          behavior: 'deny',
          message: 'no',
          interrupt: true,
        },
      }),
    )

    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'perm-1',
    })
    expect(await nextJson(ws)).toMatchObject({
      type: 'app.event',
      event: {
        type: 'permission.resolved',
        requestId: 'perm-1',
      },
    })
    expect(permissionResponse).toMatchObject({ behavior: 'deny', message: 'no' })

    ws.send(JSON.stringify({ type: 'app.abort', requestId: 'abort-1', reason: 'stop' }))
    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'abort-1',
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'abort.status',
        abort: { status: 'requested', reason: 'stop' },
      },
    })
    releaseTurn?.()
    await closeWebSocket(ws)
  })
})
