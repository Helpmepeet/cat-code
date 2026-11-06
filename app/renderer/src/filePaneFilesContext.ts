import { createContext } from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { TranscriptState } from './transcriptProjector.js'

export type FilePaneTranscript = {
  transcript: TranscriptState
  cwd: string | null
  contextTransitions?: SessionDescriptor['contextTransitions']
}
export const FilePaneFilesContext = createContext<FilePaneTranscript | null>(null)
