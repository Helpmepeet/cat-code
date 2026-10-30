import { createContext, useContext } from 'react'
import type { requestOpenFile } from './filePaneState.js'
export const FilePaneContext = createContext<typeof requestOpenFile | null>(null)
export function useFilePaneOpener(): typeof requestOpenFile | null { return useContext(FilePaneContext) }
