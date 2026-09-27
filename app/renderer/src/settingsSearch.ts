import { settingsPaneSpecs } from './settingsEditorModel.js'
import {
  SETTINGS_NAVIGATION_GROUPS,
  SETTINGS_SCOPE_LABEL,
  selectSettingsCategoryScope,
  type SettingsCategoryId,
  type SettingsScopeKind,
} from './settingsScope.js'

export type SettingsSearchResult = {
  readonly id: string
  /** Rendered rows use this as their data-setting-key focus target. */
  readonly key: string | null
  readonly category: SettingsCategoryId
  readonly scope: SettingsScopeKind
  readonly label: string
  readonly description: string
  readonly scopeLabel: string
  readonly kind: 'setting' | 'category'
}

type SearchEntry = {
  readonly category: SettingsCategoryId
  readonly key: string | null
  readonly label: string
  readonly description: string
  readonly aliases?: string
}

const engineEntries: SearchEntry[] = [
  ...settingsPaneSpecs('general').map(spec => ({
    category: 'general' as const,
    key: spec.key,
    label: spec.label,
    description: spec.description,
  })),
  ...settingsPaneSpecs('model').map(spec => ({
    category: spec.key === 'promptSuggestionEnabled' ? 'general' as const : 'model' as const,
    key: spec.key,
    label: spec.label,
    description: spec.description,
  })),
  ...settingsPaneSpecs('privacy').map(spec => ({
    category: 'privacy' as const,
    key: spec.key,
    label: spec.label,
    description: spec.description,
    aliases: spec.key === 'cleanupPeriodDays' ? 'retention history' : undefined,
  })),
  ...settingsPaneSpecs('memory').map(spec => ({
    category: 'memory' as const,
    key: spec.key,
    label: spec.label,
    description: spec.description,
  })),
  ...settingsPaneSpecs('theme').map(spec => ({
    category: 'general' as const,
    key: spec.key,
    label: spec.label,
    description: spec.description,
  })),
  {
    category: 'permissions',
    key: 'permissions.defaultMode',
    label: 'Default permission mode',
    description: 'The mode a new session starts in. Change it from the CLI.',
    aliases: 'saved permission',
  },
]

const appEntries: readonly SearchEntry[] = [
  { category: 'appearance', key: 'scheme', label: 'Appearance', description: 'Light or dark for the whole window.', aliases: 'color scheme theme' },
  { category: 'appearance', key: 'glass', label: 'Frosted window', description: 'Show the desktop through the window as a blur on macOS.' },
  { category: 'appearance', key: 'accent', label: 'Accent color', description: 'Color for active navigation, selections, and switches.' },
  { category: 'appearance', key: 'arrival', label: 'Text arrival', description: 'How a reply appears as it arrives.' },
  { category: 'appearance', key: 'toolCardStyle', label: 'Tool calls', description: 'How each tool call is drawn in the transcript.' },
  { category: 'appearance', key: 'toolsExpanded', label: 'Tools open by default', description: 'Open every tool card as it arrives.' },
  { category: 'appearance', key: 'reasoningLayout', label: 'Reasoning layout', description: 'How reasoning summaries are laid out.' },
  { category: 'appearance', key: 'codeTheme', label: 'Code theme', description: 'Color theme for code blocks in the transcript.', aliases: 'syntax colors' },
  { category: 'remote', key: 'remoteBridge', label: 'Remote Control bridge', description: 'Set the Remote Control flag for this session.', aliases: 'start bridge stop bridge' },
  { category: 'remote', key: 'remoteDirectConnect', label: 'Connect a remote session', description: 'Connect to a cat-code server over WebSocket.', aliases: 'direct connection server URL' },
  { category: 'diagnostics', key: 'openLogs', label: 'Open logs folder', description: 'Open application logs.' },
  { category: 'diagnostics', key: 'saveDiagnostics', label: 'Save diagnostics bundle', description: 'Save an app diagnostics bundle.' },
]

/** Inventories have no fixed setting rows; their destination is the useful hit. */
const categoryOnly: ReadonlySet<SettingsCategoryId> = new Set([
  'agents', 'skills', 'plugins', 'mcp', 'hooks', 'policy',
])
const inventoryCategories: ReadonlySet<SettingsCategoryId> = new Set([
  'agents', 'skills', 'plugins', 'mcp', 'hooks',
])

const entriesByCategory = new Map<SettingsCategoryId, SearchEntry[]>()
for (const entry of [...engineEntries, ...appEntries]) {
  const entries = entriesByCategory.get(entry.category) ?? []
  entries.push(entry)
  entriesByCategory.set(entry.category, entries)
}

function normalized(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Find actual settings across the whole navigation, independent of the page open. */
export function selectSettingsSearchResults(
  query: string,
  preferredEngineScope: 'user' | 'project',
): SettingsSearchResult[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const phrase = terms.join(' ')

  return SETTINGS_NAVIGATION_GROUPS.flatMap(group => group.items).flatMap((item): SettingsSearchResult[] => {
    const scope = selectSettingsCategoryScope(item.id, preferredEngineScope)
    const scopeLabel = item.id === 'remote'
      ? 'This session'
      : inventoryCategories.has(item.id)
        ? 'All sources'
        : SETTINGS_SCOPE_LABEL[scope]
    const entries = entriesByCategory.get(item.id) ?? []
    if (categoryOnly.has(item.id)) {
      const haystack = normalized(`${item.label} ${item.desc}`)
      return terms.every(term => haystack.includes(term))
        ? [{
            id: `category:${item.id}`,
            key: null,
            category: item.id,
            scope,
            label: item.label,
            description: item.desc,
            scopeLabel,
            kind: 'category' as const,
          }]
        : []
    }
    return entries.filter(entry => {
      const settingText = normalized(
        `${entry.label} ${entry.description} ${entry.aliases ?? ''}`,
      )
      return terms.every(term => settingText.includes(term)) ||
        normalized(item.label).includes(phrase)
    }).map(entry => ({
      id: `setting:${item.id}:${entry.key}`,
      key: entry.key,
      category: item.id,
      scope,
      label: entry.label,
      description: entry.description,
      scopeLabel,
      kind: 'setting' as const,
    }))
  })
}
