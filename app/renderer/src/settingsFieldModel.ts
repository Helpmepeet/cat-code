import type { SettingSourceId } from '../../shared/protocol.js'

export const SOURCE_LABEL: Record<SettingSourceId, string> = {
  userSettings: 'User',
  projectSettings: 'Project',
  localSettings: 'Local',
  flagSettings: 'Flag',
  policySettings: 'Managed',
}
