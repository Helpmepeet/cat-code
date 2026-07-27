export type ToastTone = 'default' | 'success' | 'danger' | 'warn' | 'info'

export type ToastOptions = {
  tone?: ToastTone
  duration?: number
}

export type Toast = {
  id: string
  message: string
  tone: ToastTone
  duration: number
}

export type ToastFn = (message: string, options?: ToastOptions) => void

export const DEFAULT_TOAST_DURATION = 3200
export const MAX_TOASTS = 5

export type ToastAction =
  | { type: 'add'; toast: Toast }
  | { type: 'dismiss'; id: string }

export function toastReducer(state: Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case 'add': {
      const next = [...state, action.toast]
      return next.length > MAX_TOASTS
        ? next.slice(next.length - MAX_TOASTS)
        : next
    }
    case 'dismiss':
      return state.some(t => t.id === action.id)
        ? state.filter(t => t.id !== action.id)
        : state
    default:
      return state
  }
}
