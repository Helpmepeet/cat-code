import type { Attachment } from './attachments.js'
import { getCwd } from './cwd.js'
import type { Message } from '../types/message.js'
import { isAbsolute, relative } from 'path'
import { assertSessionNotMoving, readSessionRelocation } from './sessionRelocationState.js'

// Resume filtering is a prompt/state view over archived attachment data. Keep
// the view attached to the original object so transcript logging and V1 resume
// proofs continue to see the exact persisted attachment.
const resumeAttachmentViews = new WeakMap<object, Attachment | null>()

function markWorkspaceResumeAttachment(
  archived: Attachment,
  projected: Attachment | null,
): void {
  if (projected?.type === 'invoked_skills') {
    resumeAttachmentViews.set(
      archived,
      Object.freeze({
        ...projected,
        skills: Object.freeze(
          projected.skills.map(skill => Object.freeze({ ...skill })),
        ),
      }) as unknown as Attachment,
    )
    return
  }
  resumeAttachmentViews.set(
    archived,
    projected === null ? null : Object.freeze({ ...projected }),
  )
}

/** Mark historical skill attachments using the session's verified move record. */
export function markWorkspaceResumeAttachments(
  messages: readonly Message[],
  sessionId: string,
): void {
  assertSessionNotMoving(sessionId)
  const relocation = readSessionRelocation(sessionId)
  if (!relocation) return
  if (getCwd() !== relocation.target.cwd) {
    throw new Error('Open this conversation from its current folder')
  }

  const wasInside = (root: string, path: string): boolean => {
    if (!isAbsolute(path)) return false
    const rel = relative(root, path)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
  }
  const formerRoots = new Set([
    relocation.original.cwd,
    relocation.source.cwd,
    ...(relocation.transitions ?? []).flatMap(transition => [transition.source.cwd, transition.target.cwd]),
  ])
  formerRoots.delete(relocation.target.cwd)
  const belongsToFormerProject = (path: string): boolean => {
    if (wasInside(relocation.target.cwd, path)) return false
    return [...formerRoots].some(root => wasInside(root, path))
  }

  for (const message of messages) {
    if (message.type !== 'attachment') continue
    const attachment = message.attachment as Attachment
    if (attachment.type === 'skill_listing') {
      markWorkspaceResumeAttachment(attachment, null)
    } else if (attachment.type === 'invoked_skills' && Array.isArray(attachment.skills)) {
      markWorkspaceResumeAttachment(attachment, {
        ...attachment,
        skills: attachment.skills.filter(skill => !belongsToFormerProject(skill.path)),
      })
    }
  }
}

/** `undefined` means the attachment was not marked by relocation recovery. */
export function getWorkspaceResumeAttachmentView(
  archived: Attachment,
): Attachment | null | undefined {
  return resumeAttachmentViews.get(archived)
}

/** Materialize a prompt view into rows when persisting a new fork. */
export function materializeWorkspaceResumeAttachments<T extends Message>(
  messages: readonly T[],
): T[] {
  const materialized: T[] = []
  for (const message of messages) {
    if (message.type !== 'attachment') {
      materialized.push(message)
      continue
    }
    const archivedAttachment = message.attachment as Attachment
    const view = getWorkspaceResumeAttachmentView(archivedAttachment)
    if (view === undefined) {
      materialized.push(message)
    } else if (view !== null) {
      materialized.push({ ...message, attachment: view } as T)
    }
  }
  return materialized
}
