/**
 * The composer field: a contentEditable div that renders each collapsed paste as
 * an inline pill where its `[Pasted text #N]` token sits, plus the hover/caret
 * preview popover for that pill (prototype `Chat.jsx:1383-1409`).
 *
 * It behaves as a textarea to everything above it. The draft is still a plain
 * controlled string, and `ComposerInputHandle` exposes the same
 * `selectionStart` / `selectionEnd` / `setSelectionRange` / `focus` surface the
 * pane's key handlers used when this was a `<textarea>`, so at-caret paste,
 * whole-token Backspace, and edge-gated history recall are unchanged.
 *
 * The div is rendered with NO React children: its content is built imperatively
 * from the draft (`renderComposerDom`) in a layout effect, so React never
 * reconciles against the DOM the browser mutates while typing.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  buildPastePill,
  composerOffsetFromPoint,
  composerOffsetOf,
  composerSelectionOffsets,
  placeComposerSelection,
  readComposerText,
  renderComposerDom,
} from './composerDom.js'
import { pasteIdAtCaret } from './composerState.js'
import type { PasteEntry } from './composerState.js'
import type { ComposerTypeaheadA11y } from './composerTypeaheadA11y.js'

/** The textarea-shaped surface the pane's handlers drive the field through. */
export type ComposerInputHandle = {
  readonly element: HTMLDivElement | null
  readonly selectionStart: number
  readonly selectionEnd: number
  setSelectionRange: (start: number, end: number) => void
  focus: () => void
}

type ComposerInputProps = {
  ariaLabel: string
  /** No session bound yet: the field shows nothing and takes no input. */
  disabled: boolean
  onCompositionEnd: () => void
  onCompositionStart: () => void
  onFocus: () => void
  onPointerDown: () => void
  /** `at` is the live start offset of the occurrence the user clicked. */
  onRemovePaste: (entry: PasteEntry, at: number) => void
  onValueChange: (next: string) => void
  placeholder: string
  /** Collapsed pastes for this session, oldest first. */
  pastes: PasteEntry[]
  /** A live session that cannot accept input right now (history, crashed). */
  readOnly: boolean
  ref?: React.Ref<ComposerInputHandle>
  /** The one typeahead whose listbox the focused editor currently controls. */
  typeahead?: ComposerTypeaheadA11y | null
  value: string
}

/** Grace period so the cursor can travel from a pill into its popover. */
const PREVIEW_CLOSE_MS = 160

export function ComposerInput({
  ariaLabel,
  disabled,
  onCompositionEnd,
  onCompositionStart,
  onFocus,
  onPointerDown,
  onRemovePaste,
  onValueChange,
  placeholder,
  pastes,
  readOnly,
  ref,
  typeahead = null,
  value,
}: ComposerInputProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  // A pill's DOM listeners are attached once, when the field is rebuilt, and
  // ordinary typing deliberately does NOT rebuild it — that is the whole reason
  // the nodes survive keystrokes. So a listener that closed over the props of
  // the render that built it would keep acting on a draft frozen at that
  // moment: removing a pill would write back text from before everything the
  // user typed afterwards. These refs are what the listeners read instead, and
  // they are refreshed on every render.
  const onRemovePasteRef = useRef(onRemovePaste)
  onRemovePasteRef.current = onRemovePaste
  const pastesRef = useRef(pastes)
  pastesRef.current = pastes
  const onValueChangeRef = useRef(onValueChange)
  onValueChangeRef.current = onValueChange
  // Last known caret, so a handler that runs when the selection has already
  // moved out of the field (a pill's own click) still has a sane offset.
  const caretRef = useRef(0)
  const [previewId, setPreviewId] = useState<number | null>(null)
  // Whether the open preview came from the caret or from the pointer, so caret
  // movement never closes a preview the pointer is holding open.
  const previewSourceRef = useRef<'caret' | 'hover' | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editable = !disabled && !readOnly

  const openPreview = useCallback(
    (id: number, source: 'caret' | 'hover'): void => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
      previewSourceRef.current = source
      setPreviewId(id)
    },
    [],
  )
  const closePreviewSoon = useCallback((): void => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      previewSourceRef.current = null
      setPreviewId(null)
    }, PREVIEW_CLOSE_MS)
  }, [])
  useEffect(
    () => () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    },
    [],
  )

  useImperativeHandle(
    ref,
    (): ComposerInputHandle => ({
      get element() {
        return rootRef.current
      },
      get selectionStart() {
        const root = rootRef.current
        const offsets = root ? composerSelectionOffsets(root) : null
        return offsets ? Math.min(offsets.start, offsets.end) : caretRef.current
      },
      get selectionEnd() {
        const root = rootRef.current
        const offsets = root ? composerSelectionOffsets(root) : null
        return offsets ? Math.max(offsets.start, offsets.end) : caretRef.current
      },
      setSelectionRange(start, end) {
        const root = rootRef.current
        if (!root) return
        caretRef.current = end
        placeComposerSelection(root, start, end)
      },
      focus() {
        rootRef.current?.focus()
      },
    }),
    [],
  )

  // Rebuild the field from the draft whenever the two have drifted — a
  // programmatic rewrite, a session swap, a submit that cleared it — and
  // whenever a pill's own content changed under an unchanged draft string.
  //
  // Compared by VALUE, not identity: `pastes` is rebuilt by a selector on every
  // render, so an identity check would force a rebuild on every render and tear
  // the caret out of the field mid-keystroke.
  const pastesSignature = pastes
    .map(entry => `${entry.id}:${entry.content.length}`)
    .join(',')
  const renderedPastesRef = useRef<string | null>(null)
  // Where the caret belongs after an edit this component itself made (a drop).
  // The pane owns the same idea for the edits IT makes, through the handle.
  const pendingCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    // An IME is mid-composition: its provisional text is not the draft yet, and
    // replacing the nodes under it would cancel the composition.
    if (isComposingRef.current) return
    const pastesChanged = renderedPastesRef.current !== pastesSignature
    renderedPastesRef.current = pastesSignature
    const selection = composerSelectionOffsets(root)
    const rewritten = renderComposerDom(
      root,
      value,
      segment => {
        const entry = pastes.find(item => item.id === segment.id)
        return buildPastePill({
          token: segment.token,
          id: segment.id,
          numLines: segment.numLines,
          charCount: entry ? entry.content.length : null,
          onPreviewOpen: () => openPreview(segment.id, 'hover'),
          onPreviewClose: closePreviewSoon,
          onRemove: node => {
            const live = rootRef.current
            const current = pastesRef.current.find(item => item.id === segment.id)
            if (!live || !current) return
            // Which occurrence this pill IS, read from the live DOM. Typing
            // before it moves it, so a position captured at build time would
            // point at the wrong text by the time the button is clicked.
            const parent = node.parentNode
            const at = parent
              ? composerOffsetOf(
                  live,
                  parent,
                  Array.prototype.indexOf.call(parent.childNodes, node),
                )
              : 0
            onRemovePasteRef.current(current, at)
          },
        })
      },
      pastesChanged,
      id => pastes.some(entry => entry.id === id),
    )
    // A rewrite replaced every node, so a caret that was inside the field is
    // gone. Put it back where it was; a programmatic edit that wants it
    // elsewhere sets it afterwards through the handle.
    const pendingCaret = pendingCaretRef.current
    pendingCaretRef.current = null
    if (!rewritten || document.activeElement !== root) return
    if (pendingCaret !== null) placeComposerSelection(root, pendingCaret, pendingCaret)
    else if (selection) placeComposerSelection(root, selection.start, selection.end)
  }, [closePreviewSoon, openPreview, pastes, pastesSignature, value])

  // Park the caret on a pill and its preview opens, the same as hovering it.
  const syncCaretPreview = (): void => {
    const root = rootRef.current
    if (!root) return
    const offsets = composerSelectionOffsets(root)
    if (!offsets) return
    caretRef.current = offsets.end
    if (offsets.start !== offsets.end) return
    const hit = pasteIdAtCaret(value, offsets.end)
    if (hit !== null) openPreview(hit, 'caret')
    else if (previewSourceRef.current === 'caret') {
      previewSourceRef.current = null
      setPreviewId(null)
    }
  }

  const handleInput = (): void => {
    const root = rootRef.current
    if (!root || isComposingRef.current) return
    onValueChange(readComposerText(root))
  }

  /**
   * A contentEditable accepts a rich drop natively, which would put links,
   * images, and styled nodes into a field whose draft is a plain string. The
   * serializer would then read only their text, and the rebuild is skipped
   * while serialized text matches the draft, so the foreign DOM would sit there
   * visible and unaccounted for. Same rule as paste: take the plain text, place
   * it ourselves, let nothing else in.
   */
  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (!editable) return
    const root = rootRef.current
    if (!root) return
    const text = event.dataTransfer.getData('text')
    if (!text) return
    const at =
      composerOffsetFromPoint(root, event.clientX, event.clientY) ??
      caretRef.current
    const bounded = Math.max(0, Math.min(value.length, at))
    pendingCaretRef.current = bounded + text.length
    root.focus()
    onValueChangeRef.current(
      value.slice(0, bounded) + text + value.slice(bounded),
    )
  }

  const preview = previewId === null
    ? null
    : (pastes.find(entry => entry.id === previewId) ?? null)

  return (
    <>
      {/* Full-text preview, anchored above the composer (Chat.jsx:1386). Kept
       * open while the pointer is over it so its body stays readable and
       * selectable. */}
      {preview ? (
        <div
          className="absolute bottom-[calc(100%+6px)] left-2 z-40 max-h-[40vh] w-[min(560px,80vw)] overflow-auto rounded-[10px] border border-white/[0.12] bg-surface-raised p-3 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
          onMouseEnter={() => openPreview(preview.id, 'hover')}
          onMouseLeave={closePreviewSoon}
          role="tooltip"
        >
          <div className="mb-2 font-mono text-[11px] text-text-subtle">
            {`Pasted #${preview.id} · ${preview.numLines + 1} lines · ${preview.content.length} chars`}
          </div>
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-[1.55] text-text-primary">
            {preview.content}
          </pre>
        </div>
      ) : null}

      {/* The placeholder is a sibling overlay, since a contentEditable has no
       * `placeholder` of its own (Chat.jsx:1398). The field carries the same
       * text as `aria-placeholder`, which is what actually reaches assistive
       * tech; this copy is the visible one and is hidden from it. */}
      {value.length === 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 top-1.5 text-[15px] font-medium leading-normal text-text-faint"
        >
          {placeholder}
        </div>
      ) : null}

      {/* `block` and the explicit min-height keep the empty field the same 36px
       * the textarea measured, so the send arrow does not float in dead space.
       * Content is built by the layout effect above, never by React.
       *
       * 15px, not the prototype's 16 (`Chat.jsx:1407`). That 16 was drawn at
       * `fontWeight: 300`, and this field went to `font-medium` on a live tuner
       * (f9f9f0f) for legibility on the near-black dock — 500 carries far more
       * visual mass at the same size, and the size was never re-examined after.
       * The result was the only 16px body text in an app whose transcript reads
       * at 14, which is what made it look oversized (operator, 2026-08-09). One
       * step above the transcript keeps the field reading as the active surface;
       * matching 14 exactly would let it recede into its own dock. Keep this in
       * sync with the placeholder overlay above, which must measure identically
       * or the text jumps as you start typing. */}
      <div
        ref={rootRef}
        aria-disabled={disabled ? true : undefined}
        aria-activedescendant={typeahead?.activeOptionId}
        aria-label={ariaLabel}
        aria-controls={typeahead?.listboxId}
        aria-expanded={typeahead !== null}
        aria-multiline="true"
        aria-placeholder={placeholder}
        aria-readonly={readOnly ? true : undefined}
        className="block max-h-[38vh] w-full min-h-6 overflow-y-auto whitespace-pre-wrap break-words py-1.5 text-[15px] font-medium leading-normal text-text-primary caret-accent outline-none"
        contentEditable={editable}
        onBlur={syncCaretPreview}
        onCompositionEnd={() => {
          isComposingRef.current = false
          onCompositionEnd()
          handleInput()
        }}
        onCompositionStart={() => {
          isComposingRef.current = true
          onCompositionStart()
        }}
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
        onFocus={() => {
          onFocus()
          syncCaretPreview()
        }}
        onInput={handleInput}
        onKeyUp={syncCaretPreview}
        onMouseUp={syncCaretPreview}
        onPointerDown={onPointerDown}
        role="textbox"
        spellCheck={false}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
      />
    </>
  )
}
