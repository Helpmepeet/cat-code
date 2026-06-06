import { resolve } from 'path'

export type PtcloveRisk = 'low' | 'medium' | 'high'
export type PtcloveStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'

export type PtcloveApprovalSurface = 'off' | 'high' | 'medium' | 'all'

export type PtcloveInbound =
  | { type: 'hello'; token: string }
  | {
      type: 'approval_decision'
      session_id: string
      id: string
      decision: 'approve' | 'reject'
      edited_prompt?: string
      note?: string
    }
  | { type: 'prompt_submit'; session_id: string; text: string }
  | { type: 'abort_turn'; session_id: string }
  | { type: 'queue_clear'; session_id: string }
  | { type: 'focus_session'; session_id: string }
  | { type: 'open_in_terminal'; session_id: string }
  | { type: 'session_resync'; session_id: string }

export type PtcloveOutbound =
  | {
      type: 'session_hello'
      session_id: string
      project_name: string
      project_label: string
      cwd: string
      started_at: string
      pid: number
      outbound_only: boolean
    }
  | {
      type: 'session_state'
      session_id: string
      status: PtcloveStatus
      status_text: string
      busy_since?: string
      cwd: string
      current_tool: {
        name: string
        summary: string
        target_path?: string
      } | null
      spinner_tip?: string
      model?: string | null
      queue_depth: number
    }
  | {
      type: 'session_activity'
      session_id: string
      kind: string
      summary: string
      target_path?: string
      exit_code?: number
      at: string
      lines_added?: number
      lines_removed?: number
    }
  | {
      type: 'session_todos'
      session_id: string
      todos: Array<{ id: string; text: string; status: string }>
    }
  | { type: 'session_thread_goal'; session_id: string; goal: string | null }
  | {
      type: 'session_result'
      session_id: string
      kind: 'completed' | 'failed' | 'cancelled'
      summary: string
      duration_ms: number
      files_touched: string[]
      tests?: { passed: number; failed: number }
    }
  | { type: 'heartbeat'; session_id: string; at: string }
  | {
      type: 'approval_request'
      session_id: string
      id: string
      title: string
      body: string
      command?: string
      prompt?: string
      cwd: string
      risk: PtcloveRisk
      tool_name: string
      tool_use_id: string
      blocked_path?: string
    }
  | { type: 'approval_cancelled'; session_id: string; id: string }
  | {
      type: 'approval_resolved'
      session_id: string
      id: string
      response: unknown
    }
  | { type: 'status_update'; status: PtcloveStatus }

type RiskContext = {
  cwd: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasSessionID(value: Record<string, unknown>): value is { session_id: string } {
  return typeof value.session_id === 'string' && value.session_id.length > 0
}

export function isPtcloveInbound(value: unknown): value is PtcloveInbound {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'hello') return typeof value.token === 'string'
  if (!hasSessionID(value)) return false

  switch (value.type) {
    case 'approval_decision':
      return (
        typeof value.id === 'string' &&
        (value.decision === 'approve' || value.decision === 'reject')
      )
    case 'prompt_submit':
      return typeof value.text === 'string'
    case 'abort_turn':
    case 'queue_clear':
    case 'focus_session':
    case 'open_in_terminal':
    case 'session_resync':
      return true
    default:
      return false
  }
}

export function approvalSurfaceMode(): PtcloveApprovalSurface {
  const value = (
    process.env.CAT_CODE_PTCLOVE_APPROVALS ??
    process.env.PTCLOVE_CAT_CODE_APPROVALS ??
    'all'
  ).toLowerCase()

  if (value === 'off' || value === 'none' || value === '0') return 'off'
  if (value === 'high') return 'high'
  if (value === 'medium' || value === 'med') return 'medium'
  return 'all'
}

export function shouldSurfacePtcloveApproval(risk: PtcloveRisk): boolean {
  switch (approvalSurfaceMode()) {
    case 'off':
      return false
    case 'all':
      return true
    case 'medium':
      return risk === 'medium' || risk === 'high'
    case 'high':
      return risk === 'high'
  }
}

export function riskForPtcloveApproval(
  toolName: string,
  input: Record<string, unknown>,
  context: RiskContext,
): PtcloveRisk {
  if (toolName === 'Edit' || toolName === 'Write') {
    const target = stringField(input, 'file_path') ?? stringField(input, 'path')
    if (target && isHighRiskPath(target, context.cwd)) return 'high'
    return 'medium'
  }

  if (toolName !== 'Bash') return 'low'

  const command = stringField(input, 'command') ?? ''
  if (isHighRiskCommand(command)) return 'high'
  if (isReadOnlyCommand(command)) return 'low'
  if (isRecoverableProjectMutation(command)) return 'medium'
  return 'low'
}

function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isHighRiskPath(path: string, cwd: string): boolean {
  const absolute = resolve(cwd, path)
  const cwdAbsolute = resolve(cwd)
  if (
    absolute.startsWith('/etc/') ||
    absolute === '/etc' ||
    absolute.startsWith('/usr/') ||
    absolute === '/usr' ||
    absolute.startsWith('/System/') ||
    absolute === '/System' ||
    absolute.startsWith('/Library/') ||
    absolute === '/Library' ||
    absolute.includes('/Library/Keychains/') ||
    absolute.includes('/.ssh/')
  ) {
    return true
  }
  return absolute !== cwdAbsolute && !absolute.startsWith(`${cwdAbsolute}/`)
}

function isHighRiskCommand(command: string): boolean {
  const normalized = command.trim()
  return (
    /\bsudo\b/.test(normalized) ||
    /\brm\s+-(?=[^\s;|&]*r)(?=[^\s;|&]*f)[^\s;|&]*/i.test(normalized) ||
    /\bdd\b/.test(normalized) ||
    /\bmkfs(?:\.\w+)?\b/.test(normalized) ||
    /\bchmod\s+-R\b/.test(normalized) ||
    /\bchown\s+-R\b/.test(normalized) ||
    /\bgit\s+push\b[^\n;|&]*(?:--force|-f)\b/.test(normalized) ||
    /\bgit\s+reset\s+--hard\b/.test(normalized) ||
    /\bgit\s+clean\b(?=[^\n;|&]*-[^\s;|&]*f)(?=[^\n;|&]*-[^\s;|&]*d)(?=[^\n;|&]*-[^\s;|&]*x)/i.test(normalized) ||
    /\bnpm\s+publish\b/.test(normalized) ||
    /\bgh\s+pr\s+merge\b/.test(normalized) ||
    /\bgh\s+release\s+create\b/.test(normalized)
  )
}

function isReadOnlyCommand(command: string): boolean {
  return /^\s*(?:ls|cat|rg|find|git\s+status|git\s+log|git\s+diff)\b/.test(
    command,
  )
}

function isRecoverableProjectMutation(command: string): boolean {
  return (
    /\bgit\s+(?:commit|push|merge|rebase)\b/.test(command) ||
    /\b(?:npm|bun)\s+install\b/.test(command) ||
    /\bswift\s+(?:build|package)\b/.test(command)
  )
}

export function truncateBridgeText(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`
}
