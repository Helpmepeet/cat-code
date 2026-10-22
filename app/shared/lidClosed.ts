// Host-owned controls. No renderer method forwards these to an engine.
// Contract: docs/design/2026-10-15-lid-closed-runtime-contract.md.
export type LidWorkRun = {
  id: string
  startedAt: number
  activeTurn: boolean
  status: 'running' | 'approval' | 'provider' | 'completed'
  children: { id: string; label: string; status: string }[]
}
export type LidWorkWindow = {
  identity: string
  roots: string[]
  active: boolean
  deadline: number
  lidClosed: boolean
  block: boolean
  suppressIdleSleep: boolean
}
export type LidWorkSnapshot = { generation: string; sequence: number; available: boolean; runs: LidWorkRun[] }
export type LidWorkControl = { type: 'lid.work'; requestId: string; window?: LidWorkWindow }
export type LidModePhase = 'off' | 'setup' | 'starting' | 'active' | 'restoring' | 'ended' | 'unavailable' | 'unresolved'
export type LidModeView = {
  phase: LidModePhase
  activeSessions: number
  activeSubagents: number
  waitingForApproval: boolean
  reason?: string
  error?: string
  installed: boolean
  sleepRequested: boolean
  recovering?: boolean
  repairRequired?: boolean
}
export type LidModeCommand = {
  action: 'start' | 'stop' | 'sleep' | 'retry' | 'dismiss' | 'cancel' | 'setup'
}
export type LidClosedBridge = {
  read(): Promise<LidModeView>
  command(command: LidModeCommand): Promise<LidModeView>
  subscribe(listener: (view: LidModeView) => void): () => void
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) }
export function isLidModeCommand(value: unknown): value is LidModeCommand {
  return record(value) && keys(value, ['action']) && typeof value.action === 'string' &&
    ['start','stop','sleep','retry','dismiss','cancel','setup'].includes(value.action)
}
export function isLidWorkControl(value: unknown): value is LidWorkControl {
  if (!record(value) || !keys(value, ['type','requestId','window']) || value.type !== 'lid.work' || !uuid(value.requestId)) return false
  if (value.window === undefined) return true
  const w = value.window
  return record(w) && keys(w, ['identity','roots','active','deadline','lidClosed','block','suppressIdleSleep']) && uuid(w.identity) &&
    Array.isArray(w.roots) && w.roots.length <= 256 && w.roots.every(uuid) && new Set(w.roots).size === w.roots.length &&
    number(w.deadline) && w.deadline <= Date.now() + 7_201_000 &&
    ['active','lidClosed','block','suppressIdleSleep'].every(key => typeof w[key] === 'boolean')
}
export function isLidWorkSnapshot(value: unknown): value is LidWorkSnapshot {
  if (!record(value) || !keys(value, ['generation','sequence','available','runs']) || !uuid(value.generation) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || typeof value.available !== 'boolean' ||
      !Array.isArray(value.runs) || value.runs.length > 256 || JSON.stringify(value).length > 49_152) return false
  const seen = new Set<string>()
  return value.runs.every(run => {
    if (!record(run) || !keys(run, ['id','startedAt','activeTurn','status','children']) || !uuid(run.id) || seen.has(run.id) ||
        !number(run.startedAt) || typeof run.activeTurn !== 'boolean' || typeof run.status !== 'string' || !['running','approval','provider','completed'].includes(run.status) ||
        !Array.isArray(run.children) || run.children.length > 256) return false
    seen.add(run.id)
    return run.children.every(child => record(child) && keys(child, ['id','label','status']) && text(child.id, 128) &&
      typeof child.label === 'string' && child.label.length <= 160 && typeof child.status === 'string' && ['pending','running','completed','failed','killed'].includes(child.status))
  })
}
