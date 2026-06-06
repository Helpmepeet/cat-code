import { WebSocketServer, type WebSocket } from 'ws'
import type { AppSessionController } from '../app-runtime/AppSessionController.js'
import {
  appClientMessageSchema,
  type AppServerMessage,
} from './appSessionProtocol.js'
import { createAppSessionEventMapper } from './appSessionEventMapper.js'

type StartAppSessionWebSocketServerOptions = {
  port: number
  token: string
  allowedOrigins: string[]
  controller: AppSessionController
}

type StartedAppSessionWebSocketServer = {
  port: number
  url: string
  protocol: string
  stop(): Promise<void>
}

const MAX_MESSAGE_BYTES = 128 * 1024

export async function startAppSessionWebSocketServer({
  port,
  token,
  allowedOrigins,
  controller,
}: StartAppSessionWebSocketServerOptions): Promise<StartedAppSessionWebSocketServer> {
  const requiredProtocol = `cat-code.${token}`
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols(protocols) {
      return protocols.has(requiredProtocol) ? requiredProtocol : false
    },
    verifyClient(info) {
      const protocolHeader = info.req.headers['sec-websocket-protocol']
      const protocols = String(protocolHeader ?? '')
        .split(',')
        .map(protocol => protocol.trim())
      if (!protocols.includes(requiredProtocol)) return false

      const origin = info.origin?.trim()
      if (!origin || !allowedOrigins.includes(origin)) return false

      const host = info.req.headers.host ?? ''
      return host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
    },
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const clients = new Set<WebSocket>()
  let activeTurn = false
  const mapper = createAppSessionEventMapper()
  const unsubscribe = controller.subscribe(event => {
    for (const mappedEvent of mapper.map(event)) {
      broadcast(clients, { type: 'app.event', event: mappedEvent })
    }
  })

  server.on('connection', ws => {
    clients.add(ws)

    send(ws, {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: !activeTurn,
      abort: controller.getAbortState(),
      goalSnapshot: controller.getGoalSnapshot(),
      pendingPermissionRequests: controller.getPendingPermissionRequests(),
    })

    ws.on('message', raw => {
      if (raw.length > MAX_MESSAGE_BYTES) {
        send(ws, {
          type: 'app.error',
          code: 'bad_request',
          message: 'Message is too large',
          retryable: false,
        })
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        send(ws, {
          type: 'app.error',
          code: 'bad_request',
          message: 'Message is not valid JSON',
          retryable: false,
        })
        return
      }

      const result = appClientMessageSchema.safeParse(parsed)
      if (!result.success) {
        send(ws, {
          type: 'app.error',
          code: 'bad_request',
          message: result.error.issues[0]?.message ?? 'Invalid message',
          retryable: false,
        })
        return
      }

      const message = result.data
      if (message.type === 'app.ping') {
        send(ws, { type: 'app.pong', nonce: message.nonce })
        return
      }

      if (message.type === 'app.abort') {
        send(ws, { type: 'app.ack', requestId: message.requestId })
        controller.abort(message.reason)
        return
      }

      if (message.type === 'permission.response') {
        const pending = controller
          .getPendingPermissionRequests()
          .some(request => request.requestId === message.requestId)
        if (!pending) {
          send(ws, {
            type: 'app.error',
            requestId: message.requestId,
            code: 'permission_not_found',
            message: 'Permission request is no longer pending',
            retryable: false,
          })
          return
        }

        send(ws, { type: 'app.ack', requestId: message.requestId })
        controller.respondToPermissionRequest(
          message.requestId,
          message.response,
        )
        return
      }

      send(ws, { type: 'app.ack', requestId: message.requestId })
      if (activeTurn) {
        send(ws, {
          type: 'app.error',
          requestId: message.requestId,
          code: 'turn_already_running',
          message: 'Session turn already running',
          retryable: true,
        })
        return
      }

      activeTurn = true
      broadcastTurnStatus(clients, true)
      void controller
        .submit(message.prompt, message.options)
        .catch(error => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          send(ws, {
            type: 'app.error',
            requestId: message.requestId,
            code:
              errorMessage === 'Session turn already running'
                ? 'turn_already_running'
                : 'internal_error',
            message: errorMessage,
            retryable: errorMessage === 'Session turn already running',
          })
        })
        .finally(() => {
          activeTurn = false
          broadcastTurnStatus(clients, false)
        })
    })

    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  const address = server.address()
  const actualPort =
    typeof address === 'object' && address !== null ? address.port : port

  return {
    port: actualPort,
    url: `ws://127.0.0.1:${actualPort}/ws`,
    protocol: requiredProtocol,
    async stop() {
      unsubscribe()
      for (const client of new Set([...clients, ...server.clients])) {
        if (client.readyState === client.OPEN) {
          client.close()
        }
      }
      await waitForClientsClosed(server)
      await closeServer(server)
    },
  }
}

function broadcastTurnStatus(clients: Set<WebSocket>, activeTurn: boolean): void {
  broadcast(clients, {
    type: 'app.event',
    event: {
      type: 'status.update',
      activeTurn,
      inputEnabled: !activeTurn,
    },
  })
}

function waitForClientsClosed(server: WebSocketServer): Promise<void> {
  return new Promise(resolve => {
    const wait = () => {
      if (server.clients.size === 0) {
        resolve()
        return
      }
      setTimeout(wait, 0)
    }
    wait()
  })
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const waitUntilClosed = () => {
      if (server.address() === null) {
        done()
        return
      }
      setTimeout(waitUntilClosed, 0)
    }

    server.close(done)
    waitUntilClosed()
  })
}

function broadcast(clients: Set<WebSocket>, message: AppServerMessage): void {
  for (const client of clients) {
    send(client, message)
  }
}

function send(ws: WebSocket, message: AppServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message))
  }
}
