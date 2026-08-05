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
  composerSelectionOffsets,
  placeComposerSelection,
  readComposerText,
  renderComposerDom,
} from './composerDom.js'
import { pasteIdAtCaret } from './composerState.js'
import type { PasteEntry } from './composerState.js'

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
  onRemovePaste: (entry: PasteEntry) => void
  onValueChange: (next: string) => void
  placeholder: string
  /** Collapsed pastes for this session, oldest first. */
  pastes: PasteEntry[]
  /** A live session that cannot accept input right now (history, crashed). */
  readOnly: boolean
  ref?: React.Ref<ComposerInputHandle>
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
  value,
}: ComposerInputProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
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
          onRemove: () => {
            if (entry) onRemovePaste(entry)
          },
        })
      },
      pastesChanged,
    )
    // A rewrite replaced every node, so a caret that was inside the field is
    // gone. Put it back where it was; a programmatic edit that wants it
    // elsewhere sets it afterwards through the handle.
    if (rewritten && selection && document.activeElement === root) {
      placeComposerSelection(root, selection.start, selection.end)
    }
  }, [closePreviewSoon, onRemovePaste, openPreview, pastes, pastesSignature, value])

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
          className="pointer-events-none absolute left-0 top-1.5 text-base font-light leading-normal text-[#52525b]"
        >
          {placeholder}
        </div>
      ) : null}

      {/* `block` and the explicit min-height keep the empty field the same 36px
       * the textarea measured, so the send arrow does not float in dead space.
       * Content is built by the layout effect above, never by React. */}
      <div
        ref={rootRef}
        aria-disabled={disabled ? true : undefined}
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-placeholder={placeholder}
        aria-readonly={readOnly ? true : undefined}
        className="block max-h-[38vh] w-full min-h-6 overflow-y-auto whitespace-pre-wrap break-words py-1.5 text-base font-light leading-normal text-text-primary caret-accent outline-none"
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
