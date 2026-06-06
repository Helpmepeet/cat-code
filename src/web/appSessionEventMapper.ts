import { randomUUID } from 'crypto'
import type { AppSessionEvent } from '../app-runtime/sessionEvents.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { AppBrowserEvent } from './appSessionProtocol.js'

export type AppSessionEventMapperOptions = {
  createId?: () => string
}

export function createAppSessionEventMapper({
  createId = randomUUID,
}: AppSessionEventMapperOptions = {}) {
  let activeAssistantMessageId: string | undefined

  function getActiveAssistantMessageId() {
    if (!activeAssistantMessageId) {
      activeAssistantMessageId = createId()
    }
    return activeAssistantMessageId
  }

  return {
    map(event: AppSessionEvent): AppBrowserEvent[] {
      if (event.type === 'goal.snapshot') {
        return [{ type: 'goal.snapshot', snapshot: event.snapshot }]
      }

      if (event.type === 'permission.requested') {
        return [{ type: 'permission.requested', request: event.request }]
      }

      if (event.type === 'permission.resolved') {
        return [
          {
            type: 'permission.resolved',
            requestId: event.request.requestId,
            response: event.response,
          },
        ]
      }

      if (event.type === 'abort.status') {
        return [{ type: 'abort.status', abort: event.abort }]
      }

      if (event.message.type === 'stream_event') {
        return mapStreamEvent(event.message, getActiveAssistantMessageId)
      }

      const mapped = mapSdkMessage(event.message, activeAssistantMessageId)
      if (event.message.type === 'assistant') {
        activeAssistantMessageId = undefined
      }
      return mapped
    },
  }
}

function mapSdkMessage(
  message: SDKMessage,
  activeAssistantMessageId: string | undefined,
): AppBrowserEvent[] {
  if (message.type === 'assistant') {
    const text = extractTextFromContent(message.message?.content)
    if (!text) return []
    const id = activeAssistantMessageId ?? message.uuid ?? message.message?.id

    return [
      {
        type: activeAssistantMessageId ? 'message.replace' : 'message.append',
        message: {
          id: id ?? randomUUID(),
          role: 'assistant',
          content: text,
          sdkType: message.type,
        },
      },
    ]
  }

  if (message.type === 'user') {
    const text = extractUserText(message.message?.content)
    if (!text || message.isSynthetic) return []

    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? `user-${Date.now()}`,
          role: 'user',
          content: text,
          sdkType: message.type,
        },
      },
    ]
  }

  if (message.type === 'system') {
    const content =
      typeof message.user_message === 'string'
        ? message.user_message
        : typeof message.content === 'string'
          ? message.content
          : typeof message.summary === 'string'
            ? message.summary
            : undefined
    if (!content) return []

    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? `system-${message.subtype ?? 'message'}`,
          role: 'system',
          content,
          sdkType: message.type,
          sdkSubtype: message.subtype,
        },
      },
    ]
  }

  if (message.type === 'result') {
    if (!message.is_error) return []
    const content =
      typeof message.result === 'string' && message.result.length > 0
        ? message.result
        : Array.isArray(message.errors)
          ? message.errors.join('\n')
          : 'The turn ended with an error.'

    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? 'result-error',
          role: 'system',
          content,
          sdkType: message.type,
          sdkSubtype: message.subtype,
        },
      },
    ]
  }

  if (message.type === 'assistant_error') {
    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? message.request_id ?? 'assistant-error',
          role: 'system',
          content: message.message ?? message.error ?? 'Assistant error',
          sdkType: message.type,
        },
      },
    ]
  }

  return []
}

function mapStreamEvent(
  message: SDKMessage & { type: 'stream_event' },
  getActiveAssistantMessageId: () => string,
): AppBrowserEvent[] {
  const event = message.event
  if (
    event &&
    typeof event === 'object' &&
    'type' in event &&
    event.type === 'message_start'
  ) {
    getActiveAssistantMessageId()
    return []
  }

  const delta = extractTextDelta(message.event)
  if (!delta) return []

  return [
    {
      type: 'message.delta',
      id: getActiveAssistantMessageId(),
      delta,
    },
  ]
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text
      }
      return ''
    })
    .join('')
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  return extractTextFromContent(content)
}

function extractTextDelta(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  if (!('type' in event) || event.type !== 'content_block_delta') return ''
  if (!('delta' in event)) return ''

  const delta = event.delta
  if (!delta || typeof delta !== 'object') return ''
  if (!('type' in delta) || delta.type !== 'text_delta') return ''
  if (!('text' in delta) || typeof delta.text !== 'string') return ''
  return delta.text
}
