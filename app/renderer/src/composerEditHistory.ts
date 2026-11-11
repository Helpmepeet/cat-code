import type { ComposerSelection } from './composerDom.js'
import type { PasteEntry } from './composerState.js'

export type ComposerEditSnapshot = {
  text: string
  selection: ComposerSelection
  pastes: PasteEntry[]
}

type Edit = { before: ComposerEditSnapshot; after: ComposerEditSnapshot }
const MAX_EDITS = 100
const GROUP_DELAY_MS = 1_000
const GROUPABLE = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward'])

/** The editable DOM is a projection, not an undo store: pill rendering and
 * controlled rewrites can detach nodes retained by Chromium's native history. */
export class ComposerEditHistory {
  current: ComposerEditSnapshot
  private undoEdits: Edit[] = []
  private redoEdits: Edit[] = []
  private group: { kind: string; time: number } | null = null

  constructor(snapshot: ComposerEditSnapshot) {
    this.current = snapshot
  }

  reset(snapshot: ComposerEditSnapshot): void {
    this.current = snapshot
    this.undoEdits = []
    this.redoEdits = []
    this.group = null
  }

  record(before: ComposerEditSnapshot, after: ComposerEditSnapshot, kind = '', time = Date.now()): void {
    if (before.text === after.text) return
    const previous = this.undoEdits.at(-1)
    const merge = GROUPABLE.has(kind) && this.group?.kind === kind
      && time - this.group.time < GROUP_DELAY_MS
      && previous?.after.text === before.text
      && previous.after.selection.start === before.selection.start
      && previous.after.selection.end === before.selection.end
      && before.selection.start === before.selection.end
    if (merge && previous) previous.after = after
    else {
      this.undoEdits.push({ before, after })
      if (this.undoEdits.length > MAX_EDITS) this.undoEdits.shift()
    }
    this.current = after
    this.redoEdits = []
    this.group = GROUPABLE.has(kind) ? { kind, time } : null
  }

  /** Programmatic caret placement happens after the controlled value commits. */
  select(selection: ComposerSelection): void {
    this.current = { ...this.current, selection }
    const last = this.undoEdits.at(-1)
    if (last?.after.text === this.current.text) last.after = this.current
  }

  breakGroup(): void {
    this.group = null
  }

  undo(): ComposerEditSnapshot | null {
    this.group = null
    const edit = this.undoEdits.pop()
    if (!edit) return null
    this.redoEdits.push(edit)
    this.current = edit.before
    return this.current
  }

  redo(): ComposerEditSnapshot | null {
    this.group = null
    const edit = this.redoEdits.pop()
    if (!edit) return null
    this.undoEdits.push(edit)
    this.current = edit.after
    return this.current
  }
}
