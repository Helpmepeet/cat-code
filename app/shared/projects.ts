export type DesktopProject = { id: string; name: string; cwd: string; createdAt: number }
export type ProjectFolder = { cwd: string; name: string; trustRoot: string }
export type CreateProjectInput = { draftId: string; name: string; trustFolder: boolean }
export type PickProjectResult = { kind: 'selected'; folder: ProjectFolder } | { kind: 'cancelled' } | { kind: 'error'; error: string }
export type ProjectFolderResult = PickProjectResult
export type CreateProjectResult = { ok: true; project: DesktopProject } | { ok: false; error: string }

export function isProjectDraftId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
export function isProjectName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 160
}
export function isCreateProjectInput(value: unknown): value is CreateProjectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'draftId,name,trustFolder' && isProjectDraftId(row.draftId) && isProjectName(row.name) && typeof row.trustFolder === 'boolean'
}
