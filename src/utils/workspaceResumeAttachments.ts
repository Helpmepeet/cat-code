import type { Attachment } from './attachments.js'

// Resume filtering is a prompt/state view over archived attachment data. Keep
// the view attached to the original object so transcript logging and V1 resume
// proofs continue to see the exact persisted attachment.
const resumeAttachmentViews = new WeakMap<object, Attachment | null>()

export function markWorkspaceResumeAttachment(
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

/** `undefined` means the attachment was not marked by relocation recovery. */
export function getWorkspaceResumeAttachmentView(
  archived: Attachment,
): Attachment | null | undefined {
  return resumeAttachmentViews.get(archived)
}
