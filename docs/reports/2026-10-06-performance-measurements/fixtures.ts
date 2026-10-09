/**
 * Deterministic synthetic inputs shared by the probes. Nothing here reads user
 * state; every string and identifier is generated from fixed seeds.
 */
import { PROTOCOL_VERSION, type ServerFrame } from '../../../app/shared/protocol.js'

export const SESSION_ID = '00000000-0000-4000-8000-000000000001'
export const ENGINE_SESSION_ID = '00000000-0000-4000-8000-0000000000e1'

/** Stable UUID-shaped id from a counter, so caches and dedup keys are reproducible. */
export function fixtureUuid(namespace: number, index: number): string {
  const hex = index.toString(16).padStart(12, '0')
  return `${namespace.toString(16).padStart(8, '0')}-0000-4000-8000-${hex}`
}

const WORDS = [
  'renderer', 'session', 'stream', 'parser', 'window', 'cache', 'transcript', 'delivery',
  'frame', 'message', 'layout', 'budget', 'restore', 'worker', 'highlight', 'paragraph',
]

function words(count: number, offset: number): string {
  return Array.from({ length: count }, (_, i) => WORDS[(offset + i) % WORDS.length]).join(' ')
}

/**
 * Settled content resembling the report's 33,600-character prefix: headings,
 * bold text and links, separated by blank lines.
 */
export function settledPrefix(targetCharacters = 33_600): string {
  let out = ''
  for (let i = 0; out.length < targetCharacters; i++) {
    out += `## Section ${i}\n\nThe **${words(2, i)}** keeps a [${words(1, i + 3)} link](https://example.com/${i}) next to ${words(9, i + 5)}.\n\n`
  }
  return out
}

/** Active-paragraph shapes from the report, as an initial tail and a per-update suffix. */
export const APPEND_SHAPES = {
  'word-append': { initial: 'Streaming', suffix: ' word' },
  'chunk-ending-in-space': { initial: 'Streaming', suffix: 'word ' },
  'multi-sentence-paragraph': { initial: 'First sentence here. Second', suffix: ' word' },
  'soft-line-break': { initial: 'First line\nsecond', suffix: ' word' },
  'thai-combining-marks': { initial: 'ภาษาไทย', suffix: ' ข้อความ' },
} as const

export function typescriptBlock(characters: number): string {
  const lines: string[] = []
  let length = 0
  for (let i = 0; length < characters; i++) {
    const line = `export function handler${i}(input: { id: number; label: string }): string { return \`\${input.id}:\${input.label}\` }`
    lines.push(line)
    length += line.length + 1
  }
  return lines.join('\n').slice(0, characters)
}

/**
 * A long assistant reply in ordinary working shape: headings, multi-sentence
 * paragraphs, lists, inline code and one fenced block. Used for whole-reply
 * streaming and for the tab-return parse.
 */
export function realisticReply(targetCharacters: number): string {
  const blocks: string[] = []
  let length = 0
  for (let i = 0; length < targetCharacters; i++) {
    const block = i % 6 === 0
      ? `### Step ${i / 6 + 1}\n\nThe ${words(6, i)} was checked first. Then the ${words(8, i + 2)} moved into \`${WORDS[i % WORDS.length]}.ts\`, which keeps the ${words(5, i + 4)} intact.`
      : i % 6 === 2
        ? `- The ${words(5, i)} stays bounded.\n- A ${words(4, i + 1)} is reused.\n- Each ${words(6, i + 3)} is measured separately.`
        : i % 6 === 4 && i % 12 === 4
          ? `\`\`\`ts\n${typescriptBlock(1_200)}\n\`\`\``
          : `This paragraph explains how the ${words(10, i)} behaves. It also covers the ${words(7, i + 1)}, with **one** emphasized point and a second sentence about ${words(5, i + 2)}.`
    blocks.push(block)
    length += block.length + 2
  }
  return blocks.join('\n\n').slice(0, targetCharacters)
}

/** Token-like pieces: each starts with its leading whitespace, as provider deltas usually do. */
export function streamPieces(text: string, wordsPerPiece: number): string[] {
  const tokens = text.match(/\s*\S+/g) ?? []
  const pieces: string[] = []
  for (let i = 0; i < tokens.length; i += wordsPerPiece) pieces.push(tokens.slice(i, i + wordsPerPiece).join(''))
  const joined = pieces.join('')
  if (joined.length < text.length) pieces.push(text.slice(joined.length))
  return pieces
}

export function readyFrame(sessionId = SESSION_ID): ServerFrame {
  return {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: ENGINE_SESSION_ID,
    payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    },
  } as unknown as ServerFrame
}

/** Alternating user/assistant finished messages with unique uuids and text of the given length. */
export function messageFrames(
  count: number,
  textCharacters: number,
  options: { sessionId?: string; replay?: boolean; namespace?: number } = {},
): ServerFrame[] {
  const sessionId = options.sessionId ?? SESSION_ID
  const namespace = options.namespace ?? 1
  return Array.from({ length: count }, (_, i) => {
    const uuid = fixtureUuid(namespace, i)
    const text = `${i} ${words(Math.ceil(textCharacters / 8), i)}`.slice(0, textCharacters)
    const message = i % 2 === 0
      ? { type: 'user', uuid, parent_tool_use_id: null, session_id: ENGINE_SESSION_ID, message: { role: 'user', content: [{ type: 'text', text }] } }
      : { type: 'assistant', uuid, parent_tool_use_id: null, session_id: ENGINE_SESSION_ID, message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } }
    return {
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
      ...(options.replay ? { replay: true } : {}),
      event: { type: 'message', message },
    } as unknown as ServerFrame
  })
}

/** A streamed partial as the sidecar forwards it; its text never reaches the transcript cache. */
export function streamEventFrame(sessionId = SESSION_ID): ServerFrame {
  return {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
    event: { type: 'message', message: { type: 'stream_event', event: { type: 'content_block_delta' } } },
  } as unknown as ServerFrame
}
