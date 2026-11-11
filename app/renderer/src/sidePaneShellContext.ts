import { createContext } from 'react'

/** A shell-level slot lets the pane reach the title bar without escaping scroll clips. */
export const SidePaneShellContext = createContext<HTMLElement | null>(null)
