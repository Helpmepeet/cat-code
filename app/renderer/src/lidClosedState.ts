import { createContext, useContext } from 'react'
import type { LidModeCommand, LidModeView } from '../../shared/lidClosed.js'
export type LidPresentation = {
  view: LidModeView
  command(value: LidModeCommand): void
  inspect(value: boolean): void
}
export const LidClosedContext = createContext<LidPresentation | null>(null)
export function useLidClosed(): LidPresentation | null { return useContext(LidClosedContext) }
export function isNormalLidEnding(reason?: string): boolean {
  return reason === 'stopped' || reason === 'work-finished' || reason === 'sleep-requested'
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
    case 'expired': return 'Lid-closed mode reached its time limit.'
    case 'sleep-requested': return 'Normal sleep restored. Sleep was requested.'
    case 'sleep-unconfirmed': return 'Normal sleep restored. Sleep could not be confirmed. Check your Mac.'
    default: return 'Lid-closed mode ended. Normal sleep restored.'
  }
}
