import type { SDKMessage } from '@cat-code/engine/sdk'
import type { SubmitOptions } from '../../shared/protocol.js'
import { isRecord } from '../../shared/narrow.js'
import type { TranscriptRow } from './transcriptProjector.js'

/** Select displayed, completed prose, never a partial stream or hidden frame. */
export function selectObservedProposal(messages: readonly SDKMessage[], rows: readonly TranscriptRow[]): SubmitOptions['observedProposal'] {
  if (rows.some(row => row.kind === 'assistant-text' && row.parentToolUseId === null && row.isStreaming)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      if (!isRecord(message.event) ||
        !['message_stop', 'message_delta', 'content_block_stop'].includes(String(message.event.type))) return null
    }
    if (message.type === 'user') {
      const content = isRecord(message.message) ? message.message.content : undefined
      if (!Array.isArray(content) || content.length === 0 ||
        !content.every(block => isRecord(block) && block.type === 'tool_result')) return null
    }
    if (message.type !== 'assistant' || message.parent_tool_use_id) continue
    if (typeof message.uuid !== 'string' || !isRecord(message.message) ||
      !Array.isArray(message.message.content)) return null
    const content = message.message.content
    if (content.some(block => !isRecord(block) || (block.type === 'text' && typeof block.text !== 'string'))) return null
    const prose = content
      .filter((block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n')
    if (!prose.trim()) continue
    const displayed = rows.filter(row => row.kind === 'assistant-text' && row.frameId === message.uuid)
    if (displayed.length === 0 || displayed.map(row => row.kind === 'assistant-text' ? row.content : '').join('\n') !== prose) return null
    // Focused mode can fold commentary even when its canonical row exists.
    // Without a visible-row receipt, do not claim that prose was the referent.
    if (displayed.some(row => row.kind === 'assistant-text' && row.phase === 'commentary')) return null
    if (messages.filter(other => other.type === 'assistant' && other.uuid === message.uuid).length !== 1) return null
    const tail = prose.slice(-2000)
    const first = tail.charCodeAt(0)
    return { messageUuid: message.uuid, text: first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail }
  }
  return null
}
