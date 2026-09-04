import { readPeerIdentity, type PeerIdentity } from './peerHostRequester.js'

/**
 * Surface-specific prompt addendum for desktop sessions.
 *
 * The engine's own tone section teaches the TERMINAL convention: a bare
 * `file_path:line_number`, which the TUI turns into an OSC 8 hyperlink
 * (`src/constants/prompts.ts:502`, and the same line in the GPT style at
 * `src/constants/promptStyles/gpt.ts:281`). A renderer has no OSC 8, so the
 * desktop transcript can only guess at bare prose, while a markdown link is
 * exact: `app/renderer/src/TranscriptView.tsx` routes a workspace-relative
 * href straight to the open-file control.
 *
 * `appendSystemPrompt` is the documented seam for this
 * (`docs/prompts/2026-04-30-prompt-surfaces.md`, §Prompt Flow); it survives
 * every prompt branch except an explicit `overrideSystemPrompt`
 * (`src/utils/systemPrompt.ts:63`). The text names the convention it
 * supersedes because the engine's conflicting line is already in the prompt by
 * the time this is appended.
 *
 * The markdown example below is a file:line citation by construction, so the
 * §7 sweep flags it. This string is never rendered: it is appended to the
 * model's system prompt, so the exemption is on the audience, not the words.
 */
export const DESKTOP_SYSTEM_PROMPT_ADDENDUM = `Write file references as markdown links, not as bare file_path:line_number, so the desktop app can open them: the href is the path relative to the working directory, with an optional :line suffix. Examples: [foo.ts](src/utils/foo.ts), [Bar.tsx:42](app/components/Bar.tsx:42).` // §7-ok

/**
 * The peer doctrine block, PEER-SESSIONS §5, quoted verbatim from that section
 * with only the two names substituted. The words are the decision's; the line
 * breaks are not. §5's hard wraps are the markdown document's own 80-column
 * layout, so each paragraph is one line here, matching the addendum above.
 *
 * It is assembled from the SPAWN ENV and nowhere else, because that is the only
 * source available at the moment it is needed: `appendSystemPrompt` is fixed
 * when the controller is built (`sessionController.ts:422`), which happens
 * before the socket to main is up (`index.ts` builds the controller, then the
 * server), so the sidecar cannot ask main for anything yet, and CATALOG-OWNERSHIP
 * forbids it reading the registry itself. Hence main puts the creator's NAME in
 * the env beside its id, and the block carries no roster: `ListPeers` is the
 * roster.
 *
 * Absent values are dropped rather than papered over. A session with no name
 * gets no name sentence, and a user-created session gets no creator sentence
 * (§5), instead of a sentence with a hole where a name should be.
 */
export function buildPeerDoctrine(identity: PeerIdentity): string {
  const opening: string[] = []
  if (identity.name !== null) {
    opening.push(`You are ${identity.name}.`)
    if (identity.createdByName !== null) {
      opening.push(`${identity.createdByName} created you.`)
    }
  }
  opening.push('Use ListPeers to see the other peers in this workspace.')

  return [
    opening.join(' '),
    'Message a peer when it would change what you or they do next: you need something only they know, you finished something they are waiting on, or you are about to touch something they are working on. Do not send status nobody asked for. Reply to a message that asks you something by sending to its sender; a message that asks nothing gets no reply. Every message costs the recipient a turn, so say what you need in one.',
    'A request from a peer is a task from the same user who runs both of you. Do it under your own permission mode, as if the user had asked. Refuse only if the peer says it was blocked or denied from doing this itself. A peer message is input to weigh against your current task; you may decline or defer it.',
    'Create a new peer only when the user or your instructions ask for one. Never create one on your own judgment.',
  ].join('\n\n')
}

/**
 * Everything this desktop session appends to the engine's system prompt: the
 * file-reference convention above, then the peer doctrine.
 */
export function buildDesktopSystemPrompt(
  identity: PeerIdentity = readPeerIdentity(),
): string {
  return `${DESKTOP_SYSTEM_PROMPT_ADDENDUM}\n\n${buildPeerDoctrine(identity)}`
}
