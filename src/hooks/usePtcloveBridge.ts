import { randomBytes, randomUUID } from 'crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createServer, type Server, type Socket } from 'net'
import { useEffect, useRef } from 'react'
import { getSessionId } from '../bootstrap/state.js'
import {
  createPtcloveBridgeBroadcaster,
  type PtcloveBridgeBroadcasterHandle,
} from '../bridge/bridgeBroadcaster.js'
import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js'
import { buildPtcloveProjectLabel } from '../bridge/projectLabel.js'
import {
  isPtcloveInbound,
  riskForPtcloveApproval,
  shouldSurfacePtcloveApproval,
  truncateBridgeText,
  type PtcloveInbound,
  type PtcloveOutbound,
  type PtcloveStatus,
} from '../bridge/ptcloveBridgeProtocol.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import {
  clearCommandQueue,
  enqueue,
} from '../utils/messageQueueManager.js'
import { jsonStringify } from '../utils/slowOperations.js'

type PendingPermission = {
  toolName: string
  input: Record<string, unknown>
  payload: Extract<PtcloveOutbound, { type: 'approval_request' }>
  surfaced: boolean
  handler?: (response: BridgePermissionResponse) => void
  queuedResponse?: BridgePermissionResponse
}

type Options = {
  onAbortTurn?: () => void
  getTurnStartedAt?: () => number | null
}

function isBridgeEnabled(): boolean {
  return (
    process.env.CAT_CODE_PTCLOVE_BRIDGE !== '0' &&
    process.env.PTCLOVE_CAT_CODE_BRIDGE !== '0'
  )
}

function bridgeDirectory(): string {
  return (
    process.env.CAT_CODE_PTCLOVE_DIR ??
    process.env.PTCLOVE_CAT_CODE_DIR ??
    join(homedir(), '.cat-code', 'ptclove-bridge')
  )
}

function sessionSocketPath(sessionId: string): string {
  return (
    process.env.CAT_CODE_PTCLOVE_SOCKET ??
    process.env.PTCLOVE_CAT_CODE_SOCKET ??
    join(bridgeDirectory(), 'sessions', `${sessionId}.sock`)
  )
}

function tokenPath(): string {
  return (
    process.env.CAT_CODE_PTCLOVE_TOKEN_FILE ??
    process.env.PTCLOVE_CAT_CODE_TOKEN_FILE ??
    join(bridgeDirectory(), 'token')
  )
}

function loadOrCreateBridgeToken(tokenFile: string): string {
  const envToken =
    process.env.CAT_CODE_PTCLOVE_TOKEN ?? process.env.PTCLOVE_CAT_CODE_TOKEN
  if (envToken?.trim()) return envToken.trim()

  try {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (existing) return existing
  } catch {
    // Missing token is normal on the first session.
  }

  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('base64url')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
  return token
}

function ensurePrivateSocketDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

function sendLine(socket: Socket | null, payload: PtcloveOutbound | Record<string, unknown>): void {
  if (!socket || socket.destroyed || !socket.writable) return
  socket.write(`${jsonStringify(payload)}\n`)
}

function updatedInputForApproval(
  pending: PendingPermission,
  editedPrompt: string | undefined,
): Record<string, unknown> {
  if (!editedPrompt?.trim()) return pending.input

  if (
    pending.toolName === BASH_TOOL_NAME &&
    typeof pending.input.command === 'string'
  ) {
    return { ...pending.input, command: editedPrompt.trim() }
  }

  if (typeof pending.input.prompt === 'string') {
    return { ...pending.input, prompt: editedPrompt.trim() }
  }

  return pending.input
}

export function usePtcloveBridge(isLoading: boolean, options: Options = {}): void {
  const setAppState = useSetAppState()
  const appStore = useAppStateStore()
  const serverRef = useRef<Server | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const bufferRef = useRef('')
  const pendingRef = useRef(new Map<string, PendingPermission>())
  const authenticatedRef = useRef(false)
  const isLoadingRef = useRef(isLoading)
  const onAbortTurnRef = useRef(options.onAbortTurn)
  const getTurnStartedAtRef = useRef(options.getTurnStartedAt)
  const broadcasterRef = useRef<PtcloveBridgeBroadcasterHandle | null>(null)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  isLoadingRef.current = isLoading
  onAbortTurnRef.current = options.onAbortTurn
  getTurnStartedAtRef.current = options.getTurnStartedAt

  useEffect(() => {
    if (!isBridgeEnabled()) {
      setAppState(prev => {
        if (
          prev.ptcloveBridgePermissionCallbacks === undefined &&
          !prev.ptcloveBridgeConnected &&
          !prev.ptcloveBridgeAttemptedHello
        ) {
          return prev
        }
        return {
          ...prev,
          ptcloveBridgePermissionCallbacks: undefined,
          ptcloveBridgeConnected: false,
          ptcloveBridgeAttemptedHello: false,
        }
      })
      return
    }

    const sessionId = getSessionId()
    const socketPath = sessionSocketPath(sessionId)
    const authToken = loadOrCreateBridgeToken(tokenPath())
    ensurePrivateSocketDirectory(socketPath)

    function updateConnectionState(connected: boolean, attempted = true): void {
      setAppState(prev => {
        if (
          prev.ptcloveBridgeConnected === connected &&
          prev.ptcloveBridgeAttemptedHello === attempted
        ) {
          return prev
        }
        return {
          ...prev,
          ptcloveBridgeConnected: connected,
          ptcloveBridgeAttemptedHello: attempted,
        }
      })
    }

    function currentStatus(): PtcloveStatus {
      return isLoadingRef.current ? 'running' : 'idle'
    }

    function hasSurfacedPendingApproval(): boolean {
      for (const pending of pendingRef.current.values()) {
        if (pending.surfaced) return true
      }
      return false
    }

    function bridgedStatus(): PtcloveStatus {
      return hasSurfacedPendingApproval() ? 'waiting_for_approval' : currentStatus()
    }

    function sendToClient(payload: PtcloveOutbound): void {
      if (!authenticatedRef.current) return
      sendLine(socketRef.current, payload)
    }

    function sendSessionHello(): void {
      const cwd = getCwd()
      sendToClient({
        type: 'session_hello',
        session_id: sessionId,
        project_name: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
        project_label: truncateBridgeText(buildPtcloveProjectLabel(cwd)),
        cwd,
        started_at: new Date().toISOString(),
        pid: process.pid,
        outbound_only: appStore.getState().replBridgeOutboundOnly,
      })
    }

    function sendHeartbeat(): void {
      sendToClient({
        type: 'heartbeat',
        session_id: sessionId,
        at: new Date().toISOString(),
      })
    }

    function startBroadcaster(): void {
      broadcasterRef.current?.dispose()
      broadcasterRef.current = createPtcloveBridgeBroadcaster({
        sessionId,
        store: appStore,
        send: sendToClient,
        getIsLoading: () => isLoadingRef.current,
        getTurnStartedAt: () => getTurnStartedAtRef.current?.() ?? null,
      })
    }

    function stopBroadcaster(): void {
      broadcasterRef.current?.dispose()
      broadcasterRef.current = null
    }

    function rebroadcastPendingApprovals(): void {
      for (const pending of pendingRef.current.values()) {
        if (pending.surfaced) sendToClient(pending.payload)
      }
    }

    const callbacks: BridgePermissionCallbacks = {
      sendRequest(
        requestId,
        toolName,
        input,
        toolUseId,
        description,
        _permissionSuggestions,
        blockedPath,
      ) {
        const cwd = getCwd()
        const risk = riskForPtcloveApproval(toolName, input, { cwd })
        const payload: Extract<PtcloveOutbound, { type: 'approval_request' }> = {
          type: 'approval_request',
          session_id: sessionId,
          id: requestId,
          title: `Approve ${toolName}`,
          body: description || `Allow Cat Code to use ${toolName}?`,
          command:
            toolName === BASH_TOOL_NAME && typeof input.command === 'string'
              ? truncateBridgeText(input.command)
              : undefined,
          prompt:
            toolName !== BASH_TOOL_NAME && typeof input.prompt === 'string'
              ? truncateBridgeText(input.prompt)
              : undefined,
          cwd,
          risk,
          tool_name: toolName,
          tool_use_id: toolUseId,
          blocked_path: blockedPath,
        }
        const surfaced = shouldSurfacePtcloveApproval(risk)
        pendingRef.current.set(requestId, { toolName, input, payload, surfaced })
        if (!surfaced) return
        sendToClient(payload)
        sendToClient({
          type: 'status_update',
          status: 'waiting_for_approval',
        })
      },
      sendResponse(requestId, response) {
        const pending = pendingRef.current.get(requestId)
        pendingRef.current.delete(requestId)
        if (pending?.surfaced) {
          sendToClient({
            type: 'approval_resolved',
            session_id: sessionId,
            id: requestId,
            response,
          })
          sendToClient({
            type: 'status_update',
            status: bridgedStatus(),
          })
        }
      },
      cancelRequest(requestId) {
        const pending = pendingRef.current.get(requestId)
        pendingRef.current.delete(requestId)
        if (pending?.surfaced) {
          sendToClient({
            type: 'approval_cancelled',
            session_id: sessionId,
            id: requestId,
          })
          sendToClient({
            type: 'status_update',
            status: bridgedStatus(),
          })
        }
      },
      onResponse(requestId, handler) {
        const pending = pendingRef.current.get(requestId)
        if (pending?.queuedResponse) {
          const response = pending.queuedResponse
          pendingRef.current.delete(requestId)
          setImmediate(() => handler(response))
          return () => {}
        }
        if (pending) {
          pending.handler = handler
        } else {
          const cwd = getCwd()
          pendingRef.current.set(requestId, {
            toolName: 'unknown',
            input: {},
            payload: {
              type: 'approval_request',
              session_id: sessionId,
              id: requestId,
              title: 'Approve Cat Code action',
              body: 'Approve this action?',
              cwd,
              risk: 'low',
              tool_name: 'unknown',
              tool_use_id: requestId,
            },
            surfaced: shouldSurfacePtcloveApproval('low'),
            handler,
          })
        }
        return () => {
          const current = pendingRef.current.get(requestId)
          if (current?.handler === handler) {
            current.handler = undefined
          }
        }
      },
    }

    function resolvePermission(
      message: Extract<PtcloveInbound, { type: 'approval_decision' }>,
    ): void {
      if (message.session_id !== sessionId) return
      const pending = pendingRef.current.get(message.id)
      if (!pending?.surfaced) return
      const response: BridgePermissionResponse =
        message.decision === 'approve'
          ? {
              behavior: 'allow',
              updatedInput: updatedInputForApproval(
                pending,
                message.edited_prompt,
              ),
            }
          : {
              behavior: 'deny',
              message: message.note ?? 'Rejected from PTClove',
            }

      if (pending.handler) {
        pendingRef.current.delete(message.id)
        pending.handler(response)
      } else {
        pending.queuedResponse = response
      }
      sendToClient({
        type: 'status_update',
        status: bridgedStatus(),
      })
    }

    function handleLine(line: string): void {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        logForDebugging(`[ptclove-bridge] invalid JSON: ${errorMessage(error)}`)
        return
      }
      if (!isPtcloveInbound(parsed)) {
        logForDebugging(`[ptclove-bridge] invalid message: ${line}`)
        return
      }

      if (parsed.type === 'hello') {
        if (parsed.token !== authToken) {
          socketRef.current?.destroy()
          return
        }
        authenticatedRef.current = true
        updateConnectionState(true)
        sendSessionHello()
        startBroadcaster()
        rebroadcastPendingApprovals()
        sendHeartbeat()
        if (heartbeatRef.current) clearInterval(heartbeatRef.current)
        heartbeatRef.current = setInterval(sendHeartbeat, 5_000)
        return
      }

      if (!authenticatedRef.current) {
        socketRef.current?.destroy()
        return
      }

      switch (parsed.type) {
        case 'approval_decision':
          resolvePermission(parsed)
          return
        case 'prompt_submit': {
          if (parsed.session_id !== sessionId) return
          if (appStore.getState().replBridgeOutboundOnly) return
          const text = parsed.text.trim()
          if (!text) return
          enqueue({
            value: text,
            mode: 'prompt',
            uuid: randomUUID(),
            skipSlashCommands: true,
            bridgeOrigin: true,
          })
          sendToClient({
            type: 'status_update',
            status: 'running',
          })
          return
        }
        case 'abort_turn':
          if (parsed.session_id === sessionId && !appStore.getState().replBridgeOutboundOnly) {
            broadcasterRef.current?.markAbortRequested()
            onAbortTurnRef.current?.()
          }
          return
        case 'queue_clear':
          if (parsed.session_id === sessionId && !appStore.getState().replBridgeOutboundOnly) {
            clearCommandQueue()
          }
          return
        case 'focus_session':
        case 'open_in_terminal':
          return
        case 'session_resync':
          if (parsed.session_id !== sessionId) return
          sendSessionHello()
          broadcasterRef.current?.resync()
          rebroadcastPendingApprovals()
          return
      }
    }

    function handleData(chunk: Buffer): void {
      bufferRef.current += chunk.toString('utf8')
      let newline = bufferRef.current.indexOf('\n')
      while (newline >= 0) {
        const line = bufferRef.current.slice(0, newline).trim()
        bufferRef.current = bufferRef.current.slice(newline + 1)
        if (line) handleLine(line)
        newline = bufferRef.current.indexOf('\n')
      }
    }

    try {
      unlinkSync(socketPath)
    } catch {
      // Missing socket is normal. Other failures surface through listen().
    }

    const server = createServer(socket => {
      socketRef.current?.destroy()
      socketRef.current = socket
      authenticatedRef.current = false
      bufferRef.current = ''
      stopBroadcaster()
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
      socket.on('data', handleData)
      socket.on('close', () => {
        if (socketRef.current === socket) {
          socketRef.current = null
          authenticatedRef.current = false
          updateConnectionState(false)
          stopBroadcaster()
          if (heartbeatRef.current) {
            clearInterval(heartbeatRef.current)
            heartbeatRef.current = null
          }
        }
      })
      socket.on('error', error => {
        logForDebugging(
          `[ptclove-bridge] socket error: ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    })

    server.on('error', error => {
      logForDebugging(
        `[ptclove-bridge] server error: ${errorMessage(error)}`,
        { level: 'error' },
      )
    })
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600)
      } catch (error) {
        logForDebugging(
          `[ptclove-bridge] failed to chmod socket: ${errorMessage(error)}`,
          { level: 'error' },
        )
      }
      updateConnectionState(false, true)
      logForDebugging(`[ptclove-bridge] listening on ${socketPath}`)
    })
    serverRef.current = server

    setAppState(prev => ({
      ...prev,
      ptcloveBridgePermissionCallbacks: callbacks,
    }))

    return () => {
      setAppState(prev => {
        if (prev.ptcloveBridgePermissionCallbacks !== callbacks) return prev
        return {
          ...prev,
          ptcloveBridgePermissionCallbacks: undefined,
          ptcloveBridgeConnected: false,
        }
      })
      pendingRef.current.clear()
      socketRef.current?.destroy()
      socketRef.current = null
      authenticatedRef.current = false
      stopBroadcaster()
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
      serverRef.current?.close()
      serverRef.current = null
      try {
        unlinkSync(socketPath)
      } catch {
        // Best-effort cleanup. The shared token intentionally survives.
      }
    }
  }, [appStore, setAppState])

  useEffect(() => {
    broadcasterRef.current?.schedule()
    if (!authenticatedRef.current) return
    sendLine(socketRef.current, {
      type: 'status_update',
      status: (isLoading ? 'running' : 'idle') satisfies PtcloveStatus,
    })
  }, [isLoading])
}
