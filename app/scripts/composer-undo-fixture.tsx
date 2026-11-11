import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SessionPane } from '../renderer/src/SessionPane.js'
import { idleSessionPaneProps } from '../renderer/src/sessionPaneTestProps.js'
import * as composer from '../renderer/src/composerState.js'
import { composerSelectionOffsets, placeComposerSelection } from '../renderer/src/composerDom.js'
import type { PasteEntry, PasteState } from '../renderer/src/composerState.js'
import './composer-undo-fixture.css'

let draft = ''
let entries: PasteEntry[] = []
let original: Node | null = null
const trustedKeys: Array<{ key: string; trusted: boolean }> = []
document.addEventListener('keydown', event => trustedKeys.push({ key: event.key, trusted: event.isTrusted }), true)
const field = () => document.querySelector<HTMLDivElement>('[contenteditable="true"]')!
let control: { reset(value: string): void; bind(id: string): void }
function Fixture() {
  const [sessionId, setSessionId] = useState('session-1')
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const [pastes, setPastes] = useState<PasteState>({})
  const [historyNav, setHistoryNav] = useState(composer.EMPTY_HISTORY_NAV)
  const [revision, setRevision] = useState(0)
  const prompt = prompts[sessionId] ?? ''
  draft = prompt
  entries = composer.selectSessionPasteList(pastes, sessionId)
  const write = (value: string, reason: composer.DraftWriteReason = 'edit', restored?: PasteEntry[]) => {
    setPrompts(previous => ({ ...previous, [sessionId]: value }))
    setPastes(previous => {
      return composer.reducePasteStateForDraftWrite(
        restored ? composer.reduceSessionPastesRestored(previous, sessionId, restored) : previous,
        sessionId, value, reason,
      )
    })
  }
  control = { reset: value => { setRevision(value => value + 1); setPastes({}); setPrompts({ [sessionId]: value }); setHistoryNav(composer.EMPTY_HISTORY_NAV) }, bind: setSessionId }
  return <SessionPane key={revision} {...idleSessionPaneProps()} activeSessionId={sessionId} prompt={prompt} pastes={entries}
    history={['previous local prompt']} historyNav={historyNav} onHistoryNavChange={setHistoryNav}
    mentionItems={[{ label: 'explore' }]}
    setPrompt={write}
    onPaste={(text, start, end) => {
      const result = composer.reducePasteAdded(pastes, sessionId, text)
      setPastes(result.state)
      setPrompts(previous => ({ ...previous, [sessionId]: prompt.slice(0, start) + result.token + prompt.slice(end) }))
    }}
    onRemovePaste={(entry, at) => {
      const token = composer.formatPasteRef(entry.id, entry.numLines)
      write(prompt.slice(0, at) + prompt.slice(at + token.length), 'edit')
    }}
    submit={() => { write(''); setPastes(previous => composer.reduceSessionPastesCleared(previous, sessionId)) }} />
}
flushSync(() => createRoot(document.getElementById('fixture')!).render(<Fixture />))
Object.assign(window, { composerUndoRegression: {
  reset(value = '') { flushSync(() => control.reset(value)); field().focus(); placeComposerSelection(field(), value.length, value.length) },
  bind(id: string) { flushSync(() => control.bind(id)); field().focus() },
  select(start: number, end = start) { field().focus(); placeComposerSelection(field(), start, end) },
  removePill() { field().querySelector<HTMLButtonElement>('button[aria-label^="Remove pasted text"]')!.click() },
  otherEditor() {
    const other = document.createElement('textarea')
    other.id = 'other-editor'
    document.body.append(other)
    other.focus()
  },
  otherValue() { return document.querySelector<HTMLTextAreaElement>('#other-editor')?.value },
  capture() { original = field().firstChild },
  paste(text: string) {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    data.setData('text/html', '<b>FOREIGN HTML</b><img src="https://invalid.example/image">')
    field().dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  },
  exec(command: string) { return document.execCommand(command) },
  composition(type: 'compositionstart' | 'compositionend') { field().dispatchEvent(new CompositionEvent(type, { bubbles: true })) },
  snapshot() { return { draft, entries, selection: composerSelectionOffsets(field()), originalConnected: original?.isConnected ?? false, html: field().innerHTML, whiteSpace: getComputedStyle(field()).whiteSpace, trustedKeys } },
} })
