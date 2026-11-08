import { createContext } from 'react'

export const ComputerPaneContext = createContext<{
  openStep: (id: string) => void
  selectedStepId: string | null
} | null>(null)
