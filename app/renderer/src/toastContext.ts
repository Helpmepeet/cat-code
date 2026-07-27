import { createContext, useContext } from 'react'
import type { ToastFn } from './toastModel.js'

export const ToastContext = createContext<ToastFn | null>(null)

export function useToast(): ToastFn {
  const fn = useContext(ToastContext)
  return fn ?? noopToast
}

function noopToast(): void {
  if (import.meta.env?.DEV) {
    console.warn('useToast() called outside a <ToastHost>, so the toast was dropped.')
  }
}
