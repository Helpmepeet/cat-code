/**
 * Whether tool cards open by default — a RENDERER-LOCAL view preference.
 *
 * The prototype has exactly this control: `toolsExpandedByDefault`, a Settings
 * toggle labelled "Tools open by default" (`~/catcode_prototype/cat-app/
 * AppV2.jsx:19`) defaulting to false (`:43`), threaded down to every family card
 * (`Messages.jsx:2131` → `ToolCard` → `FrameEShell`). This app carried the
 * default but never the toggle, so a card could only be opened one at a time, by
 * hand, forever.
 *
 * NOT an engine setting. Nothing in `app/shared/settingsEditable.ts` decides how
 * a transcript row is drawn; this is a desktop rendering choice with no engine
 * meaning, so it persists exactly like the reasoning layout and the code theme:
 * versioned JSON in the renderer's own storage, best-effort.
 *
 * Card expansion stays a THREE-input decision, and this is only the weakest of
 * them: a user's own click on a card wins over everything (`resolveToolCardExpanded`),
 * and a failed or image-complete card still opens itself regardless of this
 * preference, because those two open for a reason the preference knows nothing
 * about.
 */

import { createContext } from 'react'
import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const TOOLS_EXPANDED_STORAGE_KEY = 'catcode.toolsExpanded.v1'

/** The prototype's own default (`AppV2.jsx:43`): closed. */
export const DEFAULT_TOOLS_EXPANDED = false

export type ToolsExpandedContextValue = {
  expanded: boolean
  setExpanded: (next: boolean) => void
}

export const ToolsExpandedContext = createContext<ToolsExpandedContextValue>({
  expanded: DEFAULT_TOOLS_EXPANDED,
  setExpanded: () => {},
})

export function readToolsExpandedFromStorage(
  storage: ViewPreferenceStorage | null,
): boolean | null {
  return readViewPreference(
    storage,
    TOOLS_EXPANDED_STORAGE_KEY,
    'expanded',
    value => (typeof value === 'boolean' ? value : null),
  )
}

export function writeToolsExpandedToStorage(
  storage: ViewPreferenceStorage | null,
  expanded: boolean,
): void {
  writeViewPreference(storage, TOOLS_EXPANDED_STORAGE_KEY, 'expanded', expanded)
}
