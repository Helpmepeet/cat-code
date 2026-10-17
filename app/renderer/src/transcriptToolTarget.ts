import type { NestedToolUseRow as ToolUseNestedRow } from './transcriptProjector.js'

/**
 * How much of a peer argument the one-line slot is allowed to carry.
 *
 * The slot itself is a single truncated line, so CSS already cuts anything too
 * wide for the window. This cap is about the string, not the pixels: a create
 * prompt and a read query are bounded by nothing in their schemas, so a whole
 * essay would otherwise be collapsed onto one line and handed to the DOM for
 * every card on screen. It no longer sees a peer MESSAGE: a send is drawn as
 * speech and shows its text in full.
 */
const PEER_TARGET_MAX_CHARS = 160

/**
 * One line of a peer argument, whitespace collapsed so a multi-line body reads
 * as a sentence rather than as its first word. The marker is added ONLY when
 * this cut something, so a short message is never made to look abridged.
 */
export function peerTargetFragment(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > PEER_TARGET_MAX_CHARS
    ? `${oneLine.slice(0, PEER_TARGET_MAX_CHARS)}…`
    : oneLine
}

/**
 * A peer call's target, split so the NAME can read as a name.
 *
 * The verb is no longer in here: it moved to the mark (`peerToolPresentation`),
 * so repeating it would print the same thing twice in two registers, which is
 * what the `• TOOL message Basalt: …` fallback did. Every value comes from
 * `row.input`, which is what THIS session sent, so no text from another session
 * reaches the header on any of these paths.
 */
export type PeerTargetParts = {
  /** The peer this call is about, when the call names one before it runs. */
  name: string | null
  /** The one argument worth a header slot. */
  detail: string | null
  /** A search query is mono the way `grep`'s pattern is; prose is not. */
  detailMono: boolean
}

export function derivePeerTargetParts(
  toolName: string,
  str: (key: string) => string | null,
  input: Record<string, unknown>,
): PeerTargetParts | null {
  switch (toolName) {
    // `SEND_TO_PEER_TOOL_NAME`/`READ_PEER_TOOL_NAME`/`CREATE_PEER_TOOL_NAME`
    // (`app/sidecar/sendToPeerTool.ts:48`, `readPeerTool.ts:71`,
    // `createPeerTool.ts:36`); the argument keys are those files' own schemas.
    case 'SendToPeer': {
      // Only reached if the speech row is somehow bypassed; a send is drawn as
      // speech, not as a card (`PeerSpeechRow`).
      const to = str('to')
      return to === null ? null : { name: to, detail: null, detailMono: false }
    }
    case 'ReadPeer': {
      // A call missing its required field still projects before the tool
      // validates it. Returning null here would hand the slot back to the
      // family fallback, which is `row.toolName` — the raw identifier this
      // whole treatment exists to keep off the screen.
      const peer = str('peer') ?? 'a peer'
      if (peer === null) return null
      // A query is the whole of what makes a read a search since the tool
      // returns turns (`readPeerTool.ts` input schema; `view` and `limit` were
      // removed 2026-09-05). A whitespace-only query is absent to the tool, so
      // it is absent here too.
      const query = str('query')?.trim() || null
      return {
        name: peer,
        // Capped like every other peer argument: `query` is bounded by nothing
        // in the tool's schema (`readPeerTool.ts` `z.string().optional()`), and
        // this value also reaches the agent activity line through `deriveTarget`.
        detail: query === null ? null : peerTargetFragment(query),
        detailMono: query !== null,
      }
    }
    case 'CreatePeer': {
      // No name to show: the peer is named by main and the name comes back in
      // the result, so at this point the instruction is all there is.
      const prompt = str('prompt')
      return {
        name: null,
        detail: prompt === null ? 'a new session' : peerTargetFragment(prompt),
        detailMono: false,
      }
    }
    case 'ListPeers':
      // The one optional flag widens the roster to closed rows
      // (`listPeersTool.ts:44`), which is the only thing the call can vary.
      return {
        name: null,
        detail: input['all'] === true ? 'every peer' : 'open peers',
        detailMono: false,
      }
    case 'Announce': {
      // `doing` is the notice's one required line (`announceTool.ts` schema);
      // a call missing it still projects before the tool validates it.
      const doing = str('doing')
      return {
        name: null,
        detail: doing === null ? 'scope notice' : peerTargetFragment(doing),
        detailMono: false,
      }
    }
    default:
      return null
  }
}

/** The same parts as one line, for `target` and anything reading it as text. */
function peerTargetText(parts: PeerTargetParts): string {
  if (parts.name === null) return parts.detail ?? ''
  return parts.detail === null ? parts.name : `${parts.name} · ${parts.detail}`
}

/** Family-specific one-line target framing derived from the REAL tool input. */
export function deriveTarget(
  row: ToolUseNestedRow,
  cwd: string | null = null,
): string {
  const input = row.input
  const str = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const peerParts = derivePeerTargetParts(row.toolName, str, input)
  if (peerParts !== null) return peerTargetText(peerParts)
  switch (row.toolFamily) {
    case 'bash':
      return str('command') ?? row.toolName
    case 'read':
    case 'write':
    case 'edit': {
      const filePath = toolCardFilePath(row)
      return filePath === null ? row.toolName : displayFilePath(filePath, cwd)
    }
    case 'grep':
      return str('pattern') ?? str('path') ?? row.toolName
    case 'web':
      return str('url') ?? str('query') ?? row.toolName
    case 'notebook':
      return str('notebook_path') ?? str('path') ?? row.toolName
    case 'mcp':
      return mcpServerTool(row.toolName)
    case 'skill':
      return str('command') ?? str('skill') ?? row.toolName
    case 'imagegen':
      return str('prompt') ?? row.toolName
    case 'agent':
      // The Agent card's one-line target is the task, from the REAL tool input
      // (`Agent`/`Task` carry `description`/`prompt` — messageActions.tsx:107-114).
      return str('description') ?? str('prompt') ?? row.toolName
    case 'agent-control': {
      // The verb plus WHO it acted on, from each tool's real recipient key:
      // `agentId` (`ResumeAgentTool.tsx:25`) and `to` (`SendMessageTool.ts:91`).
      const recipient = str('agentId') ?? str('to')
      if (recipient === null) return row.toolName
      return row.toolName === 'ResumeAgent'
        ? `resume ${recipient}`
        : `message ${recipient}`
    }
    default:
      return row.toolName
  }
}

export function toolCardFilePath(row: ToolUseNestedRow): string | null {
  if (
    row.toolFamily !== 'read' &&
    row.toolFamily !== 'write' &&
    row.toolFamily !== 'edit'
  ) {
    return null
  }
  const filePath = row.input['file_path']
  if (typeof filePath === 'string' && filePath.length > 0) return filePath
  return row.toolFamily === 'edit' ? row.result?.diff?.filePath ?? null : null
}

export function displayFilePath(filePath: string, cwd: string | null): string {
  if (cwd === null || cwd.length === 0) return filePath
  const trimmedCwd = cwd.replace(/[/\\]+$/, '')
  const separator = trimmedCwd.includes('\\') ? '\\' : '/'
  const prefix = `${trimmedCwd}${separator}`
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

/** `mcp__server__tool` → `server › tool` (the prototype's MCP framing). */
function mcpServerTool(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName
  const [, server, ...rest] = toolName.split('__')
  if (!server) return toolName
  return rest.length > 0 ? `${server} › ${rest.join('__')}` : server
}
