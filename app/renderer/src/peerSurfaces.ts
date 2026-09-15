/**
 * Peer surfaces — the per-tool presentation of a peer call.
 *
 * THE COLOUR ITSELF LIVES IN `theme.css` as `--peer` / `--color-peer`, not
 * here, so it gets the `/<alpha>` utilities the incoming bubble needs at 20%
 * and 10% and follows light appearance the way every other hue does. Use
 * `text-peer`, `border-peer/20`, `bg-peer/10`. The reasoning for the value is
 * on the token.
 *
 * ONE COLOUR FOR EVERY PEER (operator, 2026-09-05). There is no per-peer
 * palette and no name hash: the peer's NAME says which peer it is, and the
 * colour marks the PEER NAMESPACE. That is why the composer placeholder tints
 * this session's OWN name with it too — your session has a peer name as much as
 * any other does, and the colour says "this is the name peers address you by".
 * It replaces the six-tint proposal for these surfaces.
 *
 */

/** The peer hue as text: mark, word, and a peer's name wherever it appears. */
export const PEER_TONE_CLASS = 'text-peer'

/** The incoming peer bubble's surface: the USER bubble's own recipe
 * (`border-accent/20` over `bg-accent/10`, `UserBubble` in `TranscriptView.tsx`)
 * in the peer colour, so a peer message reads as the same kind of object in
 * another voice. */
export const PEER_BUBBLE_CLASS = 'border border-peer/20 bg-peer/10'

export type PeerToolPresentation = {
  /** Replaces the family mark. */
  mark: string
  /** Replaces the family word. */
  word: string
}

/**
 * The mark says what KIND of operation this is, borrowed from the family that
 * already owns that shape, and the peer colour says it is about a session
 * rather than a file (operator, 2026-09-05):
 *
 *   `≡` read   — the `read` family's mark, for a read of a peer's transcript
 *   `⌕` search — the `grep` family's mark, when the read carries a query
 *   `+` create — the `write` family's mark, for a spawn
 *   `⋯` list   — the roster
 *
 * KNOWN RISK, accepted with eyes open: a peer read and a file read differ by
 * HUE ALONE, and both can appear in one turn. The alternative was a fourteenth
 * family hue, and there is no room for one — every candidate measured under 21
 * degrees from an existing family.
 *
 * `SendToPeer` is deliberately absent. It is not drawn as a tool card at all:
 * an outgoing message is this session speaking, so it takes the speech-mark row
 * (`PeerSpeechRow`). Returning null here is what routes it there.
 *
 * The read/search split is keyed on `query`, which is the whole of what makes a
 * read a search since the tool returns turns (`app/sidecar/readPeerTool.ts`
 * input schema; `view` and `limit` were removed 2026-09-05). A whitespace-only
 * query is absent to the tool, so it is absent here too.
 */
export function peerToolPresentation(
  toolName: string,
  input: Record<string, unknown>,
): PeerToolPresentation | null {
  switch (toolName) {
    case 'ReadPeer': {
      const raw = input['query']
      const query = typeof raw === 'string' ? raw.trim() : ''
      return { mark: query.length > 0 ? '⌕' : '≡', word: 'Peer' }
    }
    case 'CreatePeer':
      return { mark: '+', word: 'Peer' }
    case 'ListPeers':
      return { mark: '⋯', word: 'Peer' }
    default:
      return null
  }
}

/**
 * How a peer call reads in the AGENT ACTIVITY line, which has no mark column to
 * carry the verb and so must carry it in words.
 *
 * `agentActivityOf` prefixes a child's raw `toolName` whenever the target
 * differs from it, which put `SendToPeer`, `ReadPeer` and `ListPeers` in front
 * of the user verbatim — the §7 raw-identifier defect the card marks were
 * written to remove. Returning a whole phrase here lets that caller skip the
 * prefix the way it already does for `mcp` and `bash`.
 */
export function peerActivityText(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const str = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }
  switch (toolName) {
    case 'SendToPeer': {
      const to = str('to')
      return to === null ? 'sending a message' : `messaging ${to}`
    }
    case 'ReadPeer': {
      const peer = str('peer')
      if (peer === null) return 'reading a peer'
      return str('query') === null ? `reading ${peer}` : `searching ${peer}`
    }
    case 'CreatePeer':
      return 'starting a session'
    case 'ListPeers':
      return input['all'] === true ? 'listing every peer' : 'listing open peers'
    default:
      return null
  }
}

/** Whether this call is the one drawn as speech rather than as a tool card. */
export function isPeerSpeechCall(toolName: string): boolean {
  return toolName === 'SendToPeer'
}
