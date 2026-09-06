import { describe, expect, test } from 'bun:test'

import {
  PEER_BUBBLE_CLASS,
  PEER_TONE_CLASS,
  isPeerSpeechCall,
  peerToolPresentation,
} from './peerSurfaces.js'

describe('peerToolPresentation', () => {
  /**
   * The read/search split is the only one the marks make, and it is keyed on
   * `query` because that is the whole of what makes a read a search since the
   * tool returns turns (`app/sidecar/readPeerTool.ts` input schema; `view` and
   * `limit` were removed 2026-09-05). Keying it off anything else is the
   * regression this catches — a label read off a removed field silently drew
   * every search as a plain read once before.
   */
  test('a read carrying a query takes the search mark, and one without does not', () => {
    expect(peerToolPresentation('ReadPeer', { peer: 'Bear' })?.mark).toBe('≡')
    expect(
      peerToolPresentation('ReadPeer', { peer: 'Bear', query: 'schema' })?.mark,
    ).toBe('⌕')
  })

  test('a whitespace query is absent to the tool, so it is absent here too', () => {
    // `readPeerTool` trims before deciding, so a header that did not would
    // claim a search the tool never ran.
    expect(
      peerToolPresentation('ReadPeer', { peer: 'Bear', query: '   ' })?.mark,
    ).toBe('≡')
    expect(peerToolPresentation('ReadPeer', { peer: 'Bear', query: 42 })?.mark).toBe(
      '≡',
    )
  })

  test('create and list take their own marks, and every peer call takes one word', () => {
    expect(peerToolPresentation('CreatePeer', {})?.mark).toBe('+')
    expect(peerToolPresentation('ListPeers', {})?.mark).toBe('⋯')
    for (const name of ['ReadPeer', 'CreatePeer', 'ListPeers']) {
      expect(peerToolPresentation(name, {})?.word).toBe('Peer')
    }
  })

  /**
   * A send is drawn as speech, not as a card. Returning null here is what routes
   * it there, so a presentation appearing for `SendToPeer` would silently put
   * the message back in a truncated one-line slot.
   */
  test('a send has no card presentation, because it is not drawn as a card', () => {
    expect(peerToolPresentation('SendToPeer', { to: 'Bear', text: 'hi' })).toBeNull()
    expect(isPeerSpeechCall('SendToPeer')).toBe(true)
    for (const name of ['ReadPeer', 'CreatePeer', 'ListPeers', 'Bash']) {
      expect(isPeerSpeechCall(name)).toBe(false)
    }
  })

  test('a tool that is not a peer tool is left to its own family', () => {
    expect(peerToolPresentation('Bash', { command: 'ls' })).toBeNull()
    expect(peerToolPresentation('', {})).toBeNull()
  })
})

/**
 * The dynamic-class trap: Tailwind resolves classes from literal source text,
 * so a composed name emits no rule and the colour silently does not apply.
 * These are whole literals, and they must stay that way.
 */
describe('the peer colour is applied by whole literal class names', () => {
  test('the tone and bubble classes are literal utilities over the peer token', () => {
    expect(PEER_TONE_CLASS).toBe('text-peer')
    expect(PEER_BUBBLE_CLASS).toBe('border border-peer/20 bg-peer/10')
    // A raw hex in an arbitrary value is the shape that would bypass the token
    // and hard-code one appearance. (A template literal cannot be caught here:
    // it is evaluated before the constant is read, so it is pinned by the exact
    // equality above instead.)
    for (const value of [PEER_TONE_CLASS, PEER_BUBBLE_CLASS]) {
      expect(value).not.toContain('[#')
    }
  })

  /**
   * The bubble is the USER bubble's own recipe in another hue: `border-accent/20`
   * over `bg-accent/10` (`UserBubble`, `TranscriptView.tsx`). Drifting off those
   * alphas is what made an earlier draft read as heavy and wrong.
   */
  test('the bubble carries the user bubble alphas, not louder ones', () => {
    expect(PEER_BUBBLE_CLASS).toContain('/20')
    expect(PEER_BUBBLE_CLASS).toContain('/10')
  })
})
