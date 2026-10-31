import { filePreviewKind, normalizeLocalhostPreviewUrl, type FilePreviewApplications } from '../shared/filePreview.js'
import type { OpenWorkspaceFileTarget } from '../shared/protocol.js'
import { resolveWorkspaceFile } from './openWorkspaceFile.js'
import type { SessionDescriptor } from '../shared/hostApi.js'
import { readPreferenceFile, writePreferenceFile } from './preferenceFile.js'

const LABELS: Record<OpenWorkspaceFileTarget, string> = {
  default: 'Default application', chrome: 'Google Chrome', safari: 'Safari',
  vscode: 'Visual Studio Code', zed: 'Zed', cursor: 'Cursor', finder: 'Reveal in Finder',
}
const TARGETS: Record<string, OpenWorkspaceFileTarget[]> = {
  html: ['default', 'chrome', 'safari', 'vscode', 'zed', 'cursor'],
  markdown: ['default', 'vscode', 'zed', 'cursor'],
  image: ['default', 'chrome', 'safari'],
  svg: ['default', 'chrome', 'safari', 'vscode', 'zed'],
  localhost: ['chrome', 'safari'],
}
const PREFERENCE_FILE = 'file-preview-applications.json'

export function createPreviewApplications(deps: {
  userData: string
  sessions: () => readonly SessionDescriptor[]
  installed: (target: OpenWorkspaceFileTarget, path: string) => Promise<boolean>
  open: (path: string, target: OpenWorkspaceFileTarget) => Promise<boolean | string>
  localAllowed?: (url: string) => string | null
}) {
  const choices = readPreferenceFile(deps.userData, PREFERENCE_FILE, raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const result: Record<string, OpenWorkspaceFileTarget> = {}
    for (const [kind, targets] of Object.entries(TARGETS)) {
      const target = (raw as Record<string, unknown>)[kind]
      if (typeof target === 'string' && targets.includes(target as OpenWorkspaceFileTarget)) result[kind] = target as OpenWorkspaceFileTarget
    }
    return result
  }) ?? {}
  let choiceSequence = 0
  const latestChoice = new Map<string, number>()
  function registerChoice(kind: string, sequence: number): void { latestChoice.set(kind, Math.max(sequence, latestChoice.get(kind) ?? 0)) }
  function localInput(input: unknown, choose: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const record = input as Record<string, unknown>
    const keys = choose ? ['appSessionId','path','target'] : ['appSessionId','path']
    if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record,key)) || typeof record.appSessionId !== 'string' || typeof record.path !== 'string') return null
    const url = (deps.localAllowed ?? normalizeLocalhostPreviewUrl)(record.path)
    if (!url || !deps.sessions().some(session => session.appSessionId === record.appSessionId && !session.moving)) return null
    return { url, target: record.target }
  }
  return {
    async list(input: unknown): Promise<FilePreviewApplications> {
      const fallback: FilePreviewApplications = { applications: [], selected: 'default' }
      const local = localInput(input, false)
      if (local) {
        const applications = (await Promise.all(TARGETS.localhost.map(async target => await deps.installed(target, local.url).catch(()=>false) ? {target,label:LABELS[target]} : null))).filter(item=>item!==null)
        const selected = applications.some(app=>app.target===choices.localhost) ? choices.localhost : applications[0]?.target ?? 'chrome'
        return {applications,selected}
      }
      const resolved = await resolveWorkspaceFile(input, deps.sessions())
      const kind = resolved && filePreviewKind(resolved.path)
      if (!resolved || !kind) return fallback
      const applications = (await Promise.all([...TARGETS[kind], 'finder' as const].map(async target =>
        await deps.installed(target, resolved.path).catch(() => false) ? { target, label: LABELS[target] } : null))).filter(item => item !== null)
      return { applications, selected: applications.some(app => app.target === choices[kind]) ? choices[kind] : 'default' }
    },
    async choose(input: unknown): Promise<boolean> {
      const sequence = ++choiceSequence
      const local = localInput(input, true)
      if (local) {
        registerChoice('localhost', sequence)
        if (local.target !== 'chrome' && local.target !== 'safari' || !await deps.installed(local.target,local.url).catch(()=>false)) return false
        try {
          const outcome = await deps.open(local.url,local.target)
          const ok = typeof outcome === 'boolean' ? outcome : outcome === ''
          if(ok && latestChoice.get('localhost') === sequence){choices.localhost=local.target;writePreferenceFile(deps.userData,PREFERENCE_FILE,choices)}
          return ok
        } catch {return false}
      }
      const resolved = await resolveWorkspaceFile(input, deps.sessions())
      const kind = resolved && filePreviewKind(resolved.path)
      if (!resolved || !kind || !resolved.target || (resolved.target !== 'finder' && !TARGETS[kind].includes(resolved.target))) return false
      if (resolved.target !== 'finder') registerChoice(kind, sequence)
      if (!await deps.installed(resolved.target, resolved.path).catch(() => false)) return false
      try {
        const outcome = await deps.open(resolved.path, resolved.target)
        const ok = typeof outcome === 'boolean' ? outcome : outcome === ''
        if (ok && resolved.target !== 'finder' && latestChoice.get(kind) === sequence) {
          choices[kind] = resolved.target
          writePreferenceFile(deps.userData, PREFERENCE_FILE, choices)
        }
        return ok
      } catch { return false }
    },
  }
}
