import { createContext, useContext } from 'react'
import { LID_PRESETS, type LidModeCommand, type LidModeView, type LidTarget } from '../../shared/lidClosed.js'
export type LidPresentation = {
  view: LidModeView
  command(value: LidModeCommand): void
  inspect(value: boolean): void
  select(target: LidTarget): void
  flush(): void
}
export const LidClosedContext = createContext<LidPresentation | null>(null)
export function useLidClosed(): LidPresentation | null { return useContext(LidClosedContext) }
export function isNormalLidEnding(reason?: string): boolean {
  return reason === 'stopped' || reason === 'work-finished' || reason === 'sleep-requested' || reason === 'expired'
}
export const LID_SELECTION_DELAY_MS = 1000
export function lidTarget(view: LidModeView): LidTarget {
  return ['active', 'starting', 'setup'].includes(view.phase)
    ? view.mode === 'work' ? 'work' : LID_PRESETS.find(value => value === view.allowance) ?? 'off'
    : 'off'
}
export function nextLidTarget(view: LidModeView, direction: 'click' | 'up' | 'down'): LidTarget {
  const order: LidTarget[] = ['off', ...(view.workAvailable ? ['work' as const] : []), ...LID_PRESETS]
  const current = lidTarget(view)
  // An active work run remains a valid predecessor even as its last task finishes.
  if (current === 'work' && !view.workAvailable) return direction === 'down' ? 'off' : 15
  const index = Math.max(0, order.indexOf(current))
  return order[direction === 'click' ? (index + 1) % order.length
    : direction === 'up' ? Math.min(index + 1, order.length - 1) : Math.max(0, index - 1)]!
}
export function lidPreview(view: LidModeView, target: LidTarget): LidModeView {
  const base = { ...view, reason: undefined, error: undefined }
  if (target === 'off') return { ...base, phase: 'off', mode: null, allowance: 0, remainingSeconds: 0 }
  if (typeof target === 'number' && view.phase === 'active' && view.mode === 'timed') {
    const elapsed = view.allowance * 60 - view.remainingSeconds
    return { ...base, allowance: target, remainingSeconds: Math.max(0, target * 60 - elapsed) }
  }
  return { ...base, phase: 'starting', mode: target === 'work' ? 'work' : 'timed',
    allowance: typeof target === 'number' ? target : 0, remainingSeconds: typeof target === 'number' ? target * 60 : 0 }
}
export function lidFill(minutes: number): number {
  const ticks = [0, ...LID_PRESETS]
  const value = Math.max(0, Math.min(120, minutes))
  for (let index = 1; index < ticks.length; index++) {
    if (value <= ticks[index]!) return (index - 1 + (value - ticks[index - 1]!) / (ticks[index]! - ticks[index - 1]!)) / LID_PRESETS.length
  }
  return 1
}
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
export function lidReason(reason?: string): string {
  switch (reason) {
    case 'thermal': return 'Lid-closed mode ended because your Mac got too hot.'
    case 'battery-reserve': return 'Lid-closed mode ended to preserve battery.'
    case 'supervision-lost': case 'monitoring-unavailable': return 'Lid-closed mode ended because safety monitoring was lost.'
    case 'override-conflict': return 'Lid-closed mode ended because the sleep setting changed.'
    case 'work-finished': return 'All work finished. Normal sleep restored.'
    case 'no-work': return 'No work is running.'
    case 'expired': return 'Timer finished. Normal sleep restored.'
    case 'sleep-requested': return 'Normal sleep restored. Sleep was requested.'
    case 'sleep-unconfirmed': return 'Normal sleep restored. Sleep could not be confirmed. Check your Mac.'
    default: return 'Lid-closed mode ended. Normal sleep restored.'
  }
}
