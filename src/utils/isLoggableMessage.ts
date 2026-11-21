import type { Message } from '../types/message.js'

/** Progress and silent hook successes never get transcript rows. All other
 * attachments are eligible, including queued input and meaningful hook output. */
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  if (m.type !== 'attachment') return true
  const attachment = m.attachment as {
    type?: string
    content?: string
    stdout?: string
    stderr?: string
  } | null
  return attachment?.type !== 'hook_success' || Boolean(
    attachment.content || attachment.stdout?.trim() || attachment.stderr?.trim(),
  )
}
