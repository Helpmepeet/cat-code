import type {
  EditableSettingPane,
  EditableSettingSpec,
} from '../../shared/settingsEditable.js'
import { EDITABLE_SETTINGS } from '../../shared/settingsEditable.js'

const HIDDEN_KEYS: ReadonlySet<string> = new Set([
  'includeCoAuthoredBy',
  'spinnerTipsEnabled',
  'terminalTitleFromRename',
])

export function settingsPaneSpecs(
  pane: EditableSettingPane,
): readonly EditableSettingSpec[] {
  return EDITABLE_SETTINGS.filter(
    spec => spec.pane === pane && !HIDDEN_KEYS.has(spec.key),
  )
}
