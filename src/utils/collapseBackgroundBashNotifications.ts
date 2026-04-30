import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../tasks/LocalShellTask/LocalShellTask.js'
import type {
  NormalizedUserMessage,
  RenderableMessage,
} from '../types/message.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import {
  formatTaskNotificationText,
  parseTaskNotificationDetails,
  toTaskNotificationOrigin,
} from './taskNotification.js'

function isCompletedBackgroundBash(
  msg: RenderableMessage,
): msg is NormalizedUserMessage {
  if (msg.type !== 'user') return false
  const content = msg.message.content[0]
  if (content?.type !== 'text') return false
  const details =
    msg.origin?.kind === 'task-notification'
      ? msg.origin
      : parseTaskNotificationDetails(content.text)
  if (!details) return false
  // Only collapse successful completions — failed/killed stay visible individually.
  if (details.status !== 'completed') return false
  // The prefix constant distinguishes bash-kind LocalShellTask completions from
  // agent/workflow/monitor notifications. Monitor-kind completions have their
  // own summary wording and deliberately don't collapse here.
  return details.summary?.startsWith(BACKGROUND_BASH_SUMMARY_PREFIX) ?? false
}

/**
 * Collapses consecutive completed-background-bash task-notifications into a
 * single synthetic "N background commands completed" notification. Failed/killed
 * tasks and agent/workflow notifications are left alone. Monitor stream
 * events (enqueueStreamEvent) have no <status> tag and never match.
 *
 * Pass-through in verbose mode so ctrl+O shows each completion.
 */
export function collapseBackgroundBashNotifications(
  messages: RenderableMessage[],
  verbose: boolean,
): RenderableMessage[] {
  if (!isFullscreenEnvEnabled()) return messages
  if (verbose) return messages

  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isCompletedBackgroundBash(msg)) {
      let count = 0
      while (i < messages.length && isCompletedBackgroundBash(messages[i]!)) {
        count++
        i++
      }
      if (count === 1) {
        result.push(msg)
      } else {
        // Synthesize a task-notification that UserAgentNotificationMessage
        // already knows how to render — no new renderer needed.
        const summary = `${count} background commands completed`
        result.push({
          ...msg,
          origin: toTaskNotificationOrigin({ summary, status: 'completed' }),
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: formatTaskNotificationText({ summary, status: 'completed' }),
              },
            ],
          },
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
