import * as React from 'react'
import { CHANNEL_ARROW } from '../../constants/figures.js'
import { CROSS_SESSION_MESSAGE_TAG } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import type { MessageOrigin } from '../../types/message.js'

/**
 * What a peer row needs to draw itself, once provenance has been read off the
 * message. `name` is null only when the message reached us with no usable
 * sender, which is a degraded row rather than an ordinary one.
 */
export type PeerDisplay = {
  name: string | null
  body: string
  creationPrompt: boolean
}

/**
 * A delivered peer message reaches the engine wrapped as
 * `<cross-session-message from="…">`. That envelope is MODEL-facing: it is the
 * marker telling the recipient the text came from another session, and
 * neutralizing the tag inside the body is a security property. None of that is
 * display, because the row names the sender itself, so it is stripped here at
 * the display boundary only and what the model receives is untouched.
 *
 * Anchored at both ends: only a body that IS the envelope is unwrapped, so a
 * peer message quoting the tag renders verbatim rather than half-parsed.
 */
const CROSS_SESSION_ENVELOPE = new RegExp(
  `^<${CROSS_SESSION_MESSAGE_TAG} from="([^"]*)">\\n?([\\s\\S]*?)\\n?</${CROSS_SESSION_MESSAGE_TAG}>$`,
)

/**
 * Peer provenance, from the typed origin first and the envelope second.
 *
 * The envelope fallback exists for transcripts that carry the wrapper and no
 * origin. Origin wins where both are present: it is the engine's own record of
 * who sent the message, while the envelope is text that reached us from
 * another process.
 */
export function getPeerDisplay(
  text: string,
  origin: MessageOrigin | undefined,
): PeerDisplay | null {
  const peerOrigin = origin?.kind === 'peer' ? origin : null
  const envelope = text.includes(`<${CROSS_SESSION_MESSAGE_TAG}`)
    ? CROSS_SESSION_ENVELOPE.exec(text)
    : null
  if (!peerOrigin && !envelope) return null

  const name = (peerOrigin?.name || envelope?.[1] || '').trim()
  return {
    name: name === '' ? null : name,
    body: envelope ? (envelope[2] ?? '') : text,
    creationPrompt: peerOrigin?.creationPrompt === true,
  }
}

type Props = {
  addMargin: boolean
  peer: PeerDisplay
}

/**
 * The terminal's peer row, and the one an exported transcript carries.
 *
 * The row's one accent sits on the sender rather than on the glyph: a peer is
 * the only sender the user named themselves, so the name is the part that has
 * to read as a sender rather than as the message's first line. A row that
 * arrived with no usable name keeps the glyph but stays muted, because a
 * degraded row should read quieter than a correctly attributed one.
 */
export function UserPeerMessage({ addMargin, peer }: Props): React.ReactNode {
  const heading = peer.name
    ? peer.creationPrompt
      ? `${peer.name} created this session`
      : peer.name
    : 'Peer message'

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text dimColor>{CHANNEL_ARROW}</Text>{' '}
        {peer.name ? (
          <Text bold>{heading}</Text>
        ) : (
          <Text dimColor>{heading}</Text>
        )}
      </Text>
      {peer.body !== '' && (
        <Box paddingLeft={2}>
          <Text>{peer.body}</Text>
        </Box>
      )}
    </Box>
  )
}
