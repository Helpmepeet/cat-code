import { filePreviewKind, type FilePreviewApplications } from '../shared/filePreview.js'
import type { OpenWorkspaceFileTarget } from '../shared/protocol.js'
import { resolveWorkspaceFile, type WorkspaceFileOptions } from './openWorkspaceFile.js'
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
}
const PREFERENCE_FILE = 'file-preview-applications.json'

export function createPreviewApplications(deps: {
  userData: string
  sessions: () => readonly SessionDescriptor[]
  options?: WorkspaceFileOptions
  installed: (target: OpenWorkspaceFileTarget, path: string) => Promise<boolean>
  open: (path: string, target: OpenWorkspaceFileTarget) => Promise<boolean | string>
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
  return {
    async list(input: unknown): Promise<FilePreviewApplications> {
      const fallback: FilePreviewApplications = { applications: [], selected: 'default' }
      const resolved = await resolveWorkspaceFile(input, deps.sessions(), deps.options)
      const kind = resolved && filePreviewKind(resolved.path)
      if (!resolved || !kind) return fallback
      const applications = (await Promise.all([...TARGETS[kind], 'finder' as const].map(async target =>
        await deps.installed(target, resolved.path).catch(() => false) ? { target, label: LABELS[target] } : null))).filter(item => item !== null)
      return { applications, selected: applications.some(app => app.target === choices[kind]) ? choices[kind] : 'default' }
    },
    async choose(input: unknown): Promise<boolean> {
      const resolved = await resolveWorkspaceFile(input, deps.sessions(), deps.options)
      const kind = resolved && filePreviewKind(resolved.path)
      if (!resolved || !kind || !resolved.target || (resolved.target !== 'finder' && !TARGETS[kind].includes(resolved.target))) return false
      if (!await deps.installed(resolved.target, resolved.path).catch(() => false)) return false
      try {
        const outcome = await deps.open(resolved.path, resolved.target)
        const ok = typeof outcome === 'boolean' ? outcome : outcome === ''
        if (ok && resolved.target !== 'finder') {
          choices[kind] = resolved.target
          writePreferenceFile(deps.userData, PREFERENCE_FILE, choices)
        }
        return ok
      } catch { return false }
    },
  }
}
