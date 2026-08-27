/**
 * P4-1 shared primitive — `ToastHost` (Surfaces.jsx:836-885).
 *
 * Transient confirmations that stack bottom-right and auto-expire. The
 * prototype installed a global `window.toast`; the real version is a React
 * provider + `useToast()` hook — a genuine API the W4 domains call, with no
 * global side-channel. `ToastHost` wraps the app: it provides the `toast()`
 * function through context AND renders the viewport.
 *
 *   <ToastHost><App /></ToastHost>          // wire once at the root
 *   const toast = useToast()                 // in any domain
 *   toast('Session branched', { tone: 'success' })
 *
 * The queue/dismiss/expiry is a pure reducer (`toastReducer`) so it is
 * unit-testable without timers or a DOM; the provider only wires the timers.
 *
 * Security: `message` is caller-supplied display text and renders as a text
 * node (React escapes it) — never HTML.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { ToastContext } from './toastContext.js'
import {
  DEFAULT_TOAST_DURATION,
  toastReducer,
  type Toast,
  type ToastFn,
  type ToastTone,
} from './toastModel.js'
import { toneClasses, type Tone } from './tone.js'

let toastCounter = 0

export function ToastHost({ children }: { children?: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, EMPTY_TOASTS)
  // Live expiry timers, cleared on dismiss/unmount so a torn-down host leaves
  // no dangling setTimeout.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    dispatch({ type: 'dismiss', id })
  }, [])

  const toast = useCallback<ToastFn>(
    (message, options) => {
      const id = `toast-${Date.now()}-${(toastCounter += 1)}`
      const duration = options?.duration ?? DEFAULT_TOAST_DURATION
      dispatch({
        type: 'add',
        toast: { id, message, tone: options?.tone ?? 'default', duration },
      })
      if (duration > 0 && typeof setTimeout === 'function') {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }
    },
    [dismiss],
  )

  // Reconcile timers with the live queue: a toast evicted by the newest-wins cap
  // (toastReducer) never went through `dismiss`, so its expiry timer would
  // otherwise linger and fire a tick late. Clearing every timer whose toast is
  // no longer live promptly reaps it (and covers any other removal path).
  useEffect(() => {
    const live = new Set(toasts.map(t => t.id))
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer)
        timers.current.delete(id)
      }
    }
  }, [toasts])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

const EMPTY_TOASTS: Toast[] = []

const TOAST_TONE: Record<ToastTone, Tone> = {
  default: 'default',
  success: 'good',
  danger: 'danger',
  warn: 'warn',
  info: 'info',
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed right-[18px] bottom-[18px] z-[200] flex flex-col items-end gap-1.5"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map(toast => {
        const t = toneClasses(TOAST_TONE[toast.tone])
        return (
          <button
            key={toast.id}
            type="button"
            onClick={() => onDismiss(toast.id)}
            className={
              'animate-toast-in pointer-events-auto flex items-center gap-2.5 rounded-lg border bg-surface-raised px-[13px] py-2 text-left text-[12.5px] font-medium text-text-primary shadow-[var(--elev-toast)] ' +
              t.softBorder
            }
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} />
            {toast.message}
          </button>
        )
      })}
    </div>
  )
}
