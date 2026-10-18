import { createContext, useContext } from 'react'
import { LID_PRESETS, type LidModeCommand, type LidModeView } from '../../shared/lidClosed.js'
export type LidPresentation = {
  view: LidModeView
  command(value: LidModeCommand): void
  inspect(value: boolean): void
}
export const LidClosedContext = createContext<LidPresentation | null>(null)
export function useLidClosed(): LidPresentation | null { return useContext(LidClosedContext) }
export function lidFill(minutes: number): number {
  const ticks = [0, ...LID_PRESETS]
  const value = Math.max(0, Math.min(120, minutes))
  for (let i = 1; i < ticks.length; i++) if (value <= ticks[i]!) return ((i - 1) + (value - ticks[i - 1]!) / (ticks[i]! - ticks[i - 1]!)) / LID_PRESETS.length
  return 1
}
export function lidReason(reason?: string): string {
  switch (reason) {
    case 'thermal': return 'Lid-closed mode ended because your Mac got too hot.'
    case 'battery-reserve': return 'Lid-closed mode ended to preserve battery.'
    case 'supervision-lost': case 'monitoring-unavailable': return 'Lid-closed mode ended because safety monitoring was lost.'
    case 'override-conflict': return 'Lid-closed mode ended because the sleep setting changed.'
    case 'expired': return 'Lid-closed mode reached its time limit.'
    case 'sleep-requested': return 'Normal sleep restored. Sleep was requested.'
    case 'sleep-unconfirmed': return 'Normal sleep restored. Sleep could not be confirmed. Check your Mac.'
    default: return 'Lid-closed mode ended. Normal sleep restored.'
  }
}
