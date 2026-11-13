import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { classifyWindowDrop, type DropFeedback } from './windowDropModel.js'
import './windowDrop.css'

export function WindowDrop({ enabled, editable, root, onDrop }: {
  enabled: boolean
  editable: boolean
  root: React.RefObject<HTMLDivElement | null>
  onDrop: (event: DragEvent) => void
}) {
  const [feedback, setFeedback] = useState<DropFeedback | null>(null)
  const current = useRef<DropFeedback | null>(null)
  const drop = useRef(onDrop)
  drop.current = onDrop
  useEffect(() => {
    if (!enabled) return
    const update = (next: DropFeedback | null) => {
      if (current.current?.title === next?.title && current.current?.detail === next?.detail) return
      current.current = next
      setFeedback(next)
    }
    const clear = () => update(null)
    const over = (event: DragEvent) => {
      const transfer = event.dataTransfer
      if (!transfer) return
      const next = classifyWindowDrop(Array.from(transfer.items), Array.from(transfer.types))
      if (!next) { clear(); return }
      event.preventDefault()
      transfer.dropEffect = editable && next.allowed ? 'copy' : 'none'
      update(editable ? next : null)
    }
    const release = (event: DragEvent) => {
      clear()
      const transfer = event.dataTransfer
      if (!transfer) return
      const next = classifyWindowDrop(Array.from(transfer.items), Array.from(transfer.types))
      if (!next) return
      event.preventDefault()
      event.stopPropagation()
      if (editable && next.allowed) drop.current(event)
    }
    const leave = (event: DragEvent) => { if (!event.relatedTarget) clear() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear() }
    window.addEventListener('dragenter', over)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', release, true)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragend', clear)
    window.addEventListener('blur', clear)
    window.addEventListener('keydown', key)
    return () => {
      clear()
      window.removeEventListener('dragenter', over)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', release, true)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('blur', clear)
      window.removeEventListener('keydown', key)
    }
  }, [enabled, editable])
  const panel = root.current?.closest('.session-pane')
  return enabled && editable && feedback && panel ? createPortal(
    <div className={`window-drop-veil${feedback.allowed ? '' : ' window-drop-no'}`}>
      <div className="window-drop-box">
        <div className="window-drop-title">{feedback.title}</div>
        <div className="window-drop-detail">{feedback.detail}</div>
      </div>
    </div>, panel,
  ) : null
}
