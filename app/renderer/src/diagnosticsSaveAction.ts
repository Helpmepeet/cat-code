import { getBridge } from './bridge.js'
import type { ToastFn } from './toastModel.js'

export async function requestDiagnosticsSave(toast: ToastFn): Promise<void> {
  try {
    const result: unknown = await getBridge().saveDiagnosticsBundle()
    if (result === 'cancelled') return
    if (result === 'saved') {
      toast('Diagnostics bundle saved.', { tone: 'success' })
      return
    }
  } catch {
    // Rejected IPC calls must have the same bounded feedback as write failures.
  }
  toast('Could not save the diagnostics bundle. Try again.', { tone: 'warn' })
}
