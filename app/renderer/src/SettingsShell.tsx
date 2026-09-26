/**
 * Stable settings navigation and local scope selection. Search and the category
 * rail share settingsScope/settingsSearch metadata. Durable settings and memory
 * read through the host inventory for the selected project.
 */

import { useContext, useEffect, useRef, useState } from 'react'
import type { SettingsInventoryReadResult } from '../../shared/hostApi.js'
import type {
  AgentConfigSnapshot,
  ExtensionsSnapshot,
  MemorySnapshot,
  RemoteSettingsResultFrame,
  RemoteSettingsSnapshot,
  RemoteVerbMessage,
  SettingsSnapshot,
  SettingsVerbMessage,
} from '../../shared/protocol.js'
import type { EditableSettingPane } from '../../shared/settingsEditable.js'
import {
  ACCENT_KEYS,
  ACCENT_LABELS,
  ACCENT_SWATCH_CLASS,
  AccentThemeContext,
  DEFAULT_ACCENT,
} from './accentTheme.js'
import {
  DEFAULT_GLASS_ENABLED,
  GlassModeContext,
} from './glassMode.js'
import {
  COLOR_SCHEME_KEYS,
  COLOR_SCHEME_LABELS,
  ColorSchemeContext,
  DEFAULT_COLOR_SCHEME,
  isColorSchemeKey,
} from './colorScheme.js'
import { AgentsPage } from './AgentsPage.js'
import { getBridge } from './bridge.js'
import {
  CODE_THEME_KEYS,
  CODE_THEME_LABELS,
  CodeThemeContext,
  DEFAULT_CODE_THEME,
  isCodeThemeKey,
} from './codeTheme.js'
import { CodeThemePreview } from './CodeThemePreview.js'
import { ToolCardStylePreview } from './ToolCardStylePreview.js'
import { ProseArrivalPreview } from './ProseArrivalPreview.js'
import { MemoryPage } from './MemoryPage.js'
import {
  isReasoningLayoutMode,
  ReasoningLayoutContext,
  REASONING_LAYOUT_MODES,
  REASONING_LAYOUT_LABELS,
} from './reasoningLayout.js'
import {
  DEFAULT_TOOLS_EXPANDED,
  ToolsExpandedContext,
} from './toolsExpanded.js'
import {
  DEFAULT_PROSE_ARRIVAL,
  PROSE_ARRIVALS,
  PROSE_ARRIVAL_LABELS,
  ProseArrivalContext,
  isProseArrival,
} from './proseArrival.js'
import {
  DEFAULT_TOOL_CARD_STYLE,
  TOOL_CARD_STYLES,
  TOOL_CARD_STYLE_LABELS,
  ToolCardStyleContext,
  isToolCardStyle,
} from './toolCardStyle.js'
import { RemoteSettingsPage } from './RemoteSettingsPage.js'
import { SelectControl, SettingsPane, ToggleSwitch } from './SettingsEditors.js'
import type { SettingWriteInput } from './SettingsEditors.js'
import type { SettingsProjectBinding } from './settingsProjectBinding.js'
import {
  SETTINGS_UNKNOWN_VALUE,
  settingsUnreadNote,
  settingsWereRead,
} from './settingsReadState.js'
import {
  SETTINGS_PROJECT_LAYER_DESC,
  SETTINGS_PROJECT_LAYER_LABEL,
  SETTINGS_PROJECT_LAYERS,
  SETTINGS_SCOPE_LABEL,
  SETTINGS_NAVIGATION_GROUPS,
  selectSettingsCategory,
  selectPermissionDefaultModeRow,
  selectSettingsProjects,
  selectSettingsWriteLayer,
  settingsRowNote,
  type SettingsCategoryId,
  type SettingsProjectEngine,
  type SettingsProjectLayer,
  type SettingsProjectOption,
  type SettingsScopeKind,
} from './settingsScope.js'
import { settingsPaneSpecs } from './settingsEditorModel.js'
import { selectSettingsSearchResults } from './settingsSearch.js'
import {
  HooksPanel,
  McpPanel,
  PluginsPanel,
  SkillsPanel,
} from './SettingsExtensions.js'
import { Field, LockIcon, PaneSection, SourceBadge } from './SettingsField.js'
import {
  selectLayerOrigin,
  selectManagedFields,
} from './settingsState.js'

let rememberedCategory: SettingsCategoryId | null = null

export function SettingsShell({
  cwd,
  remoteSnapshot,
  remoteLastResult,
  onRemoteVerb,
  projectBinding,
  projects,
  initialScope = 'user',
  initialCategory,
  onOpenLogs,
  onSaveDiagnostics,
}: {
  /** The focused session's cwd. Used ONLY as project IDENTITY — which project
   * the picker can offer first. It never chooses the scope (Law 2). */
  cwd?: string | null
  remoteSnapshot?: RemoteSettingsSnapshot | null
  remoteLastResult?: RemoteSettingsResultFrame | null
  onRemoteVerb?: (verb: RemoteVerbMessage) => void
  /** Names the focused session's project (`settingsProjectBinding.ts`), so the
   * picker's "current" entry gets the roster-disambiguated label instead of a
   * bare basename. Optional: without it the cwd's last segment is used. */
  projectBinding?: SettingsProjectBinding
  /** Every known project the picker may offer (the merged workspace roster). */
  projects?: readonly SettingsProjectOption[]
  /** Initial scope remains available for direct page entry and SSR checks. */
  initialScope?: SettingsScopeKind
  initialCategory?: string
  onOpenLogs?: () => void
  onSaveDiagnostics?: () => void

}) {
  const [category, setCategory] = useState<SettingsCategoryId>(() => {
    if (initialScope === 'app') return 'appearance'
    if (initialScope === 'enforced') return 'policy'
    const initial = initialCategory ?? rememberedCategory ?? 'general'
    const requested = initial === 'interface' || initial === 'notifications'
      ? 'appearance'
      : initial
    const valid = SETTINGS_NAVIGATION_GROUPS.some(group =>
      group.items.some(entry => entry.id === requested),
    )
    return valid ? requested as SettingsCategoryId : 'general'
  })
  const [preferredEngineScope, setPreferredEngineScope] =
    useState<'user' | 'project'>(initialScope === 'project' ? 'project' : 'user')
  const [query, setQuery] = useState('')
  const [selectedResult, setSelectedResult] = useState(0)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [projectLayer, setProjectLayer] =
    useState<SettingsProjectLayer>('projectSettings')
  const [projectCwd, setProjectCwd] = useState<string | null>(null)
  const [pickedProjects, setPickedProjects] = useState<SettingsProjectOption[]>([])
  const [projectPickError, setProjectPickError] = useState<string | null>(null)
  const [inventoryUserOnly, setInventoryUserOnly] = useState(false)
  const [inventoryRead, setInventoryRead] = useState<{
    cwd: string | null
    result: SettingsInventoryReadResult | null
  } | null>(null)
  const [writeStatus, setWriteStatus] = useState<{
    kind: 'saving' | 'saved' | 'failed'
    message: string
  } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const inventoryReadToken = useRef(0)
  const writeActionToken = useRef(0)

  const sessionOpen = typeof cwd === 'string' && cwd.trim().length > 0
  const activeCwd =
    cwd && cwd.trim().length > 0
      ? cwd
      : projectBinding?.bound
        ? projectBinding.cwd
        : null
  const known = [
    ...(projects ?? (projectBinding?.bound
      ? [{ cwd: projectBinding.cwd, name: projectBinding.name }]
      : [])),
    ...pickedProjects,
  ]
  const projectChoices = selectSettingsProjects(known, activeCwd)
  const selectedProject =
    projectChoices.find(choice => choice.cwd === projectCwd) ??
    projectChoices[0] ??
    null
  const engineCategory =
    category === 'general' || category === 'model' ||
    category === 'permissions' || category === 'privacy' ||
    category === 'memory'
  const inventoryCategory =
    category === 'agents' || category === 'skills' ||
    category === 'plugins' || category === 'mcp' || category === 'hooks'
  const inventoryCwd = engineCategory || category === 'policy'
    ? preferredEngineScope === 'project' ? selectedProject?.cwd ?? null : null
    : inventoryCategory && !inventoryUserOnly ? selectedProject?.cwd ?? null : null
  const inventoryCwdRef = useRef(inventoryCwd)
  inventoryCwdRef.current = inventoryCwd
  const currentInventory = inventoryRead?.cwd === inventoryCwd ? inventoryRead.result : null
  const inventoryLoading = currentInventory === null
  const inventoryError = currentInventory?.ok === false ? currentInventory.error.message : null
  const inventory = currentInventory?.ok === true ? currentInventory.inventory : null

  const chooseProject = (): void => {
    setProjectPickError(null)
    void getBridge().pickSettingsProject().then(project => {
      if (!project) return
      setPickedProjects(current => [
        ...current.filter(choice => choice.cwd !== project.cwd),
        project,
      ])
      setProjectCwd(project.cwd)
      setInventoryUserOnly(false)
    }, () => {
      setProjectPickError('Project could not be opened.')
    })
  }

  useEffect(() => {
    let cancelled = false
    const token = ++inventoryReadToken.current
    setInventoryRead({ cwd: inventoryCwd, result: null })
    void Promise.resolve().then(() => getBridge().readSettingsInventory(inventoryCwd)).then(
      result => {
        if (!cancelled && token === inventoryReadToken.current) {
          setInventoryRead({ cwd: inventoryCwd, result })
        }
      },
      () => {
        if (!cancelled && token === inventoryReadToken.current) setInventoryRead({
          cwd: inventoryCwd,
          result: {
            ok: false,
            error: {
              code: 'unavailable',
              message: 'Configuration could not be read.',
            },
          },
        })
      },
    )
    return () => { cancelled = true }
  }, [inventoryCwd])
  const engine: SettingsProjectEngine =
    preferredEngineScope === 'project' && !selectedProject ? 'absent' : 'live'
  const writeLayer = selectSettingsWriteLayer(preferredEngineScope, projectLayer)

  useEffect(() => {
    ++writeActionToken.current
    setWriteStatus(null)
  }, [category, inventoryCwd, writeLayer])

  const searching = query.trim().length > 0
  const results = searching
    ? selectSettingsSearchResults(query, preferredEngineScope)
    : []
  const currentCategory = selectSettingsCategory(category)

  const handleSettingWrite = (input: SettingWriteInput): void => {
    const targetCwd = input.source === 'userSettings' ? null : selectedProject?.cwd ?? null
    if (input.source !== 'userSettings' && !targetCwd) {
      setWriteStatus({ kind: 'failed', message: 'Choose a project before saving.' })
      return
    }
    const verb: SettingsVerbMessage = {
      type: 'settings.setValue',
      requestId: crypto.randomUUID(),
      source: input.source,
      key: input.key,
      value: input.value,
    }
    const actionToken = ++writeActionToken.current
    setWriteStatus({ kind: 'saving', message: 'Saving…' })
    void (async () => {
      let failure: string | null = null
      try {
        const result = await getBridge().writeDurableSetting(targetCwd, verb)
        if (!result.ok) failure = result.error.message
      } catch {
        failure = 'Setting could not be saved.'
      }
      try {
        const refreshed = await getBridge().readSettingsInventory(targetCwd)
        if (inventoryCwdRef.current === targetCwd && actionToken === writeActionToken.current) {
          ++inventoryReadToken.current
          setInventoryRead({ cwd: targetCwd, result: refreshed })
        }
        if (!refreshed.ok && !failure) failure = refreshed.error.message
      } catch {
        if (!failure) {
          failure = 'Setting was saved, but could not be reloaded.'
        }
      }
      if (actionToken === writeActionToken.current && inventoryCwdRef.current === targetCwd) {
        setWriteStatus(failure
          ? { kind: 'failed', message: failure }
          : { kind: 'saved', message: 'Saved' })
      }
    })()
  }

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (event.key === 'Escape' && searching) {
        setQuery('')
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [searching])

  useEffect(() => {
    if (focusKey === null || searching) return
    const target = Array.from(
      pageRef.current?.querySelectorAll<HTMLElement>('[data-setting-key]') ?? [],
    ).find(node => node.dataset.settingKey === focusKey)
    const controlArea = target?.querySelector<HTMLElement>('[data-setting-control]')
    const control =
      controlArea?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]:not(:disabled)') ??
      controlArea?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')
    const destination = control ?? target ?? pageRef.current?.querySelector<HTMLElement>('[data-settings-heading]')
    destination?.focus({ preventScroll: true })
    destination?.scrollIntoView?.({ block: 'center', behavior: 'instant' })
    setFocusKey(null)
  }, [category, focusKey, preferredEngineScope, searching])

  const openResult = (result: (typeof results)[number]) => {
    setCategory(result.category)
    rememberedCategory = result.category
    if ((result.scope === 'user' || result.scope === 'project') &&
      (result.category === 'general' || result.category === 'model' ||
        result.category === 'permissions' || result.category === 'privacy' ||
        result.category === 'memory')) {
      setPreferredEngineScope(result.scope)
    }
    setQuery('')
    setFocusKey(result.key ?? '')
  }

  return (
    <div
      aria-label="Settings"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg text-text-primary md:flex-row"
      data-window-ground
    >
      <aside className="shrink-0 border-b border-shell-seam bg-shell-chrome px-4 py-4 md:w-[220px] md:overflow-y-auto md:border-b-0 md:border-r md:px-4 md:py-6" data-window-chrome>
        <h1 className="mb-3 px-2 text-[20px] font-semibold tracking-tight md:mb-6">Settings</h1>
        <nav aria-label="Settings categories" className="flex gap-2 overflow-x-auto md:block md:overflow-visible">
          {SETTINGS_NAVIGATION_GROUPS.map((group, index) => (
            <div
              aria-label={group.heading ?? undefined}
              className="flex shrink-0 gap-1 md:mb-5 md:block"
              key={group.heading ?? `group-${index}`}
              role="group"
            >
              {group.heading ? (
                <div className="hidden px-2 pb-1.5 text-[12px] font-medium text-text-subtle md:block">
                  {group.heading}
                </div>
              ) : null}
              {group.items.map(entry => (
                <button
                  aria-current={entry.id === category && !searching ? 'page' : undefined}
                  className={`flex h-[34px] shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors md:mb-0.5 md:w-full ${
                    entry.id === category && !searching
                      ? 'bg-accent/10 font-semibold text-accent-soft'
                      : 'text-text-muted hover:bg-shell-hover hover:text-text-primary'
                  }`}
                  key={entry.id}
                  onClick={() => {
                    setCategory(entry.id)
                    rememberedCategory = entry.id
                    setQuery('')
                    setFocusKey(null)
                  }}
                  type="button"
                >
                  <span className="truncate">{entry.label}</span>
                  {entry.locked ? <LockIcon className="ml-auto h-3 w-3" /> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5 md:px-8 md:py-7 xl:px-12">
        <div className="max-w-[760px]" ref={pageRef}>
          <div className="mb-7 flex h-[38px] items-center gap-2 rounded-md border border-shell-seam bg-surface-raised px-3 focus-within:border-accent">
            <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-text-subtle" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" />
            </svg>
            <input
              aria-label="Search all settings"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-subtle"
              onChange={event => {
                setQuery(event.target.value)
                setSelectedResult(0)
              }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' && results.length > 0) {
                  event.preventDefault()
                  setSelectedResult(index => Math.min(index + 1, results.length - 1))
                } else if (event.key === 'ArrowUp' && results.length > 0) {
                  event.preventDefault()
                  setSelectedResult(index => Math.max(index - 1, 0))
                } else if (event.key === 'Enter' && results[selectedResult]) {
                  event.preventDefault()
                  openResult(results[selectedResult])
                }
              }}
              placeholder="Search all settings"
              ref={searchRef}
              type="search"
              value={query}
            />
            {searching ? (
              <button aria-label="Clear search" className="text-[12px] text-text-subtle hover:text-text-primary" onClick={() => { setQuery(''); searchRef.current?.focus() }} type="button">Clear</button>
            ) : <kbd className="text-[11px] text-text-subtle">⌘ K</kbd>}
          </div>

          {searching ? (
            <section aria-label="Search results">
              <h2 className="text-[24px] font-semibold tracking-tight" data-settings-heading tabIndex={-1}>Search results</h2>
              <p className="mb-2 mt-1 text-[13px] text-text-subtle" role="status">
                {results.length === 0 ? 'No matching settings' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
              </p>
              {results.length === 0 ? (
                <p className="border-b border-shell-seam py-5 text-[13px] text-text-muted">
                  Try a setting name such as code theme, retention, or model.
                </p>
              ) : null}
              {results.map((result, index) => (
                <button
                  className={`block w-full border-b border-shell-seam px-1 py-4 text-left hover:bg-shell-hover ${index === selectedResult ? 'bg-shell-hover' : ''}`}
                  key={result.id}
                  onClick={() => openResult(result)}
                  onMouseEnter={() => setSelectedResult(index)}
                  type="button"
                >
                  <span className="block text-[11px] text-text-subtle">{selectSettingsCategory(result.category).label} · {result.scopeLabel}</span>
                  <span className="mt-1 block text-[14px] font-medium text-text-primary">{result.label}</span>
                  <span className="mt-0.5 block text-[13px] text-text-subtle">{result.description}</span>
                </button>
              ))}
            </section>
          ) : (
            <>
              <header className="mb-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[25px] font-semibold tracking-tight" data-settings-heading tabIndex={-1}>
                    {currentCategory.label}
                  </h2>
                  {engineCategory ? (
                    <div aria-label="Settings scope" className="flex gap-1.5" role="group">
                      {(['user', 'project'] as const).map(kind => (
                        <button
                          aria-pressed={preferredEngineScope === kind}
                          className={`rounded-md border px-2.5 py-1 text-[12px] ${preferredEngineScope === kind ? 'border-accent/40 bg-accent/10 font-semibold text-accent-soft' : 'border-shell-seam text-text-muted hover:bg-shell-hover'}`}
                          key={kind}
                          onClick={() => setPreferredEngineScope(kind)}
                          type="button"
                        >
                          {kind === 'project' && selectedProject ? `${SETTINGS_SCOPE_LABEL.project}: ${selectedProject.name}` : SETTINGS_SCOPE_LABEL[kind]}
                        </button>
                      ))}
                    </div>
                  ) : category === 'appearance' || category === 'diagnostics' ? (
                    <span className="text-[12px] text-text-subtle">This app</span>
                  ) : category === 'remote' ? (
                    <span className="text-[12px] text-text-subtle">This session</span>
                  ) : inventoryCategory ? (
                    <span className="text-[12px] text-text-subtle">{selectedProject && !inventoryUserOnly ? selectedProject.name : 'User configuration'}</span>
                  ) : category === 'policy' ? (
                    <span className="flex items-center gap-1 text-[12px] text-text-subtle"><LockIcon className="h-3 w-3" /> Enforced</span>
                  ) : null}
                </div>
                <p className="mt-1 text-[13px] leading-5 text-text-muted">{currentCategory.desc}</p>
                {writeStatus && engineCategory ? (
                  <p
                    className={`mt-2 text-[12px] ${writeStatus.kind === 'failed' ? 'text-tone-warn' : 'text-text-subtle'}`}
                    role={writeStatus.kind === 'failed' ? 'alert' : 'status'}
                  >
                    {writeStatus.message}
                  </p>
                ) : null}
                {engineCategory && preferredEngineScope === 'project' ? (
                  <ProjectScopeControls
                    choices={projectChoices}
                    layer={projectLayer}
                    onChooseProject={chooseProject}
                    onSelectLayer={setProjectLayer}
                    onSelectProject={setProjectCwd}
                    selected={selectedProject}
                  />
                ) : null}
                {inventoryCategory ? (
                  <div className="mt-2.5">
                    <SelectControl
                      label="Configuration for"
                      onChange={value => {
                        setInventoryUserOnly(value === '')
                        if (value) setProjectCwd(value)
                      }}
                      optionLabels={{
                        '': 'User configuration',
                        ...Object.fromEntries(projectChoices.map(choice => [choice.cwd, choice.name])),
                      }}
                      options={['', ...projectChoices.map(choice => choice.cwd)]}
                      value={inventoryCwd ?? ''}
                    />
                    <button
                      className="ml-2 rounded-md border border-shell-seam px-2.5 py-1 text-[12px] text-text-muted hover:bg-shell-hover"
                      onClick={chooseProject}
                      type="button"
                    >
                      Choose project…
                    </button>
                  </div>
                ) : null}
                {projectPickError && (engineCategory || inventoryCategory) ? (
                  <p className="mt-2 text-[12px] text-tone-warn" role="alert">{projectPickError}</p>
                ) : null}
              </header>
              <ScopeBody
                agentsSnapshot={inventory?.agents ?? null}
                category={category}
                engine={engine}
                extensionsSnapshot={inventory?.extensions ?? null}
                inventoryError={inventoryError}
                inventoryLoading={inventoryLoading}
                layer={writeLayer}
                memorySnapshot={inventory?.memory ?? null}
                onOpenLogs={onOpenLogs}
                onRemoteVerb={onRemoteVerb ?? (() => {})}
                onSaveDiagnostics={onSaveDiagnostics}
                onSettingWrite={handleSettingWrite}
                remoteLastResult={remoteLastResult ?? null}
                remoteSnapshot={remoteSnapshot ?? null}
                selectedProject={selectedProject}
                sessionOpen={sessionOpen}
                snapshot={inventory?.settings ?? null}
              />
            </>
          )}
        </div>
      </main>
    </div>
  )
}

/** The project picker and its explicit write layer. */
function ProjectScopeControls({
  choices,
  selected,
  onChooseProject,
  onSelectProject,
  layer,
  onSelectLayer,
}: {
  choices: readonly { cwd: string; name: string; current: boolean }[]
  selected: { cwd: string; name: string; current: boolean } | null
  onChooseProject: () => void
  onSelectProject: (cwd: string) => void
  layer: SettingsProjectLayer
  onSelectLayer: (layer: SettingsProjectLayer) => void
}) {
  if (!selected) {
    return (
      <div className="mt-2.5 flex items-center gap-3">
        <p className="text-[12px] leading-relaxed text-text-subtle">Choose a project to read and edit its settings files.</p>
        <button className="rounded-md border border-shell-seam px-2.5 py-1 text-[12px] text-text-muted hover:bg-shell-hover" onClick={onChooseProject} type="button">Choose project…</button>
      </div>
    )
  }
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SelectControl
          label="Project"
          onChange={onSelectProject}
          optionLabels={Object.fromEntries(
            choices.map(choice => [
              choice.cwd,
              choice.current ? `${choice.name} (current)` : choice.name,
            ]),
          )}
          options={choices.map(choice => choice.cwd)}
          value={selected.cwd}
        />
        <button className="rounded-md border border-shell-seam px-2.5 py-1 text-[12px] text-text-muted hover:bg-shell-hover" onClick={onChooseProject} type="button">Choose project…</button>
        <span className="truncate font-mono text-[11px] text-text-subtle">
          {selected.cwd}
        </span>
      </div>
      <div
        aria-label="Where project edits are saved"
        className="flex flex-wrap items-center gap-1.5"
        role="group"
      >
        {SETTINGS_PROJECT_LAYERS.map(candidate => {
          const on = candidate === layer
          return (
            <button
              aria-pressed={on}
              className={`rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors ${
                on
                  ? 'border-accent/40 bg-accent/10 font-semibold text-accent-soft'
                  : 'border-shell-seam text-text-muted hover:bg-shell-hover'
              }`}
              key={candidate}
              onClick={() => onSelectLayer(candidate)}
              type="button"
            >
              {SETTINGS_PROJECT_LAYER_LABEL[candidate]}
            </button>
          )
        })}
        <span className="text-[11px] text-text-subtle">
          {SETTINGS_PROJECT_LAYER_DESC[layer]}
        </span>
      </div>
    </div>
  )
}

function ScopeBody({
  category,
  layer,
  engine,
  selectedProject,
  snapshot,
  agentsSnapshot,
  extensionsSnapshot,
  inventoryError,
  inventoryLoading,
  memorySnapshot,
  remoteSnapshot,
  remoteLastResult,
  onRemoteVerb,
  onSettingWrite,
  onOpenLogs,
  onSaveDiagnostics,
  sessionOpen,
}: {
  category: SettingsCategoryId
  layer: ReturnType<typeof selectSettingsWriteLayer>
  engine: SettingsProjectEngine
  selectedProject: { cwd: string; name: string; current: boolean } | null
  sessionOpen: boolean
  snapshot: SettingsSnapshot | null
  agentsSnapshot: AgentConfigSnapshot | null
  extensionsSnapshot: ExtensionsSnapshot | null
  inventoryError: string | null
  inventoryLoading: boolean
  memorySnapshot: MemorySnapshot | null
  remoteSnapshot: RemoteSettingsSnapshot | null
  remoteLastResult: RemoteSettingsResultFrame | null
  onRemoteVerb: (verb: RemoteVerbMessage) => void
  onSettingWrite: (input: SettingWriteInput) => void
  onOpenLogs?: () => void
  onSaveDiagnostics?: () => void
}) {
  const writeLayer = layer ?? 'userSettings'
  const engineCategory =
    category === 'general' || category === 'model' ||
    category === 'permissions' || category === 'privacy' ||
    category === 'memory'
  const inventoryCategory =
    category === 'agents' || category === 'skills' ||
    category === 'plugins' || category === 'mcp' || category === 'hooks'
  if ((inventoryCategory || engineCategory || category === 'policy') && inventoryLoading) {
    return <p className="text-[13px] leading-5 text-text-muted">Loading configuration…</p>
  }
  if ((inventoryCategory || engineCategory || category === 'policy') && inventoryError) {
    return <p role="alert" className="text-[13px] leading-5 text-tone-warn">{inventoryError}</p>
  }
  if (engineCategory && engine === 'absent') {
    return <p className="text-[13px] leading-5 text-text-muted">Choose a project to read and edit its settings.</p>
  }
  if (engineCategory && !snapshot) {
    return <p className="text-[13px] leading-5 text-text-muted">Settings are unavailable for this scope.</p>
  }
  const settingsPane = (
    pane: EditableSettingPane,
    keys?: readonly string[],
    title?: string,
    showTarget = true,
  ) => (
    <SettingsPane
      engine={engine}
      keys={keys}
      layer={writeLayer}
      noEngineNote="Choose a project to read and edit its settings."
      onWrite={onSettingWrite}
      pane={pane}
      sessionOpen={sessionOpen}
      showTarget={showTarget}
      snapshot={snapshot}
      title={title}
    />
  )

  switch (category) {
    case 'general':
      return (
        <>
          {settingsPane('general', undefined, 'Behavior')}
          {settingsPane('model', ['promptSuggestionEnabled'], 'Suggestions', false)}
          {settingsPane('theme', undefined, 'Output', false)}
        </>
      )
    case 'model':
      return settingsPane(
        'model',
        settingsPaneSpecs('model').filter(spec => spec.key !== 'promptSuggestionEnabled').map(spec => spec.key),
      )
    case 'permissions':
      return (
        <PermissionsPane
          engine={engine}
          layer={writeLayer}
          sessionOpen={sessionOpen}
          snapshot={snapshot}
        />
      )
    case 'privacy':
      return settingsPane('privacy')
    case 'memory':
      return (
        <>
          {settingsPane('memory')}
          <MemoryPage snapshot={memorySnapshot} />
        </>
      )
    case 'appearance':
      return <AppScopeBody />
    case 'agents':
      return <AgentsPage snapshot={agentsSnapshot} />
    case 'skills':
      return <SkillsPanel snapshot={extensionsSnapshot} />
    case 'plugins':
      return <PluginsPanel snapshot={extensionsSnapshot} />
    case 'mcp':
      return <McpPanel snapshot={extensionsSnapshot} />
    case 'hooks':
      return <HooksPanel snapshot={extensionsSnapshot} />
    case 'remote':
      return (
        <RemoteSettingsPage
          lastResult={remoteLastResult}
          onVerb={onRemoteVerb}
          snapshot={remoteSnapshot}
        />
      )
    case 'diagnostics':
      return (
        <PaneSection title="Diagnostics">
          <p className="mb-4 text-[13px] leading-5 text-text-muted">Open application logs or save a diagnostics bundle.</p>
          <div className="flex flex-wrap gap-2">
            {onOpenLogs ? <button className="rounded-md border border-shell-seam px-3 py-2 text-[13px] text-text-primary hover:bg-shell-hover" data-setting-key="openLogs" onClick={onOpenLogs} type="button">Open logs folder</button> : null}
            {onSaveDiagnostics ? <button className="rounded-md border border-shell-seam px-3 py-2 text-[13px] text-text-primary hover:bg-shell-hover" data-setting-key="saveDiagnostics" onClick={onSaveDiagnostics} type="button">Save diagnostics bundle</button> : null}
          </div>
        </PaneSection>
      )
    case 'policy':
      return <ManagedPanel sessionOpen={sessionOpen} snapshot={snapshot} />
  }
}

/**
 * The durable half of Permissions.
 *
 * The live half — the running session's mode, its engine-resolved allow/deny/ask
 * rules, managed-rules-only enforcement, the classifier state, this-session
 * extra directories — is per-session state, and it is precisely the thing the
 * operator objected to seeing under a Settings heading. It already renders on
 * the session inspector (`MetadataInspector.tsx` §Permissions, the same
 * `PermissionRulesEditor`), so it is not shown twice here.
 *
 * `permissions.defaultMode` stays READ-ONLY: making it writable means adding a
 * permission-family key to the sidecar's write allowlist, which is a
 * security-baseline change needing an explicit PERMISSION-BOUNDARY review
 * (spec §7.1). Rules stay read-only for a harder reason — the renderer never
 * authors permission rules at all (SECURITY-MINIMUM T6b).
 */
function PermissionsPane({
  snapshot,
  layer,
  engine,
  sessionOpen,
}: {
  snapshot: SettingsSnapshot | null
  layer: NonNullable<ReturnType<typeof selectSettingsWriteLayer>>
  engine: SettingsProjectEngine
  sessionOpen: boolean
}) {
  // Scope-relative, like every other row on the page: a project's default must
  // not render under My defaults as if the user file held it.
  const row = selectPermissionDefaultModeRow({
    snapshot,
    layer,
    engine,
    sessionOpen,
  })
  const origin = selectLayerOrigin(snapshot, layer)
  const value =
    row.read.kind === 'set'
      ? String(row.read.value)
      : row.read.kind === 'unset'
        ? 'not set'
        : SETTINGS_UNKNOWN_VALUE
  const badgeSource =
    row.read.kind === 'set'
      ? row.read.source
      : row.read.kind === 'unreadable'
        ? (row.read.by ?? undefined)
        : undefined
  const note = settingsRowNote(row)
  return (
    <>
      <PaneSection title="Default mode">
        <Field
          desc="The mode a session starts in. Change it from the CLI."
          editable={false}
          label="Default permission mode"
          settingKey="permissions.defaultMode"
          managed={row.annotation.kind === 'enforced'}
          origin={badgeSource ? selectLayerOrigin(snapshot, badgeSource) : null}
          source={badgeSource}
        >
          <span
            aria-label={`Default permission mode: ${value}`}
            className="rounded border border-shell-seam bg-surface-raised px-2 py-1 font-mono text-[12.5px] text-text-primary"
          >
            {value}
          </span>
        </Field>
        {/* Only an `unset-here` row may say the files hold nothing: that
          * annotation is reached only from a snapshot that WAS read and that
          * resolves the key nowhere. */}
        {row.annotation.kind === 'unset-here' ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
            <code className="font-mono">permissions.defaultMode</code> is not set
            in any settings file, so the engine chooses each session's opening
            mode.
          </p>
        ) : note ? (
          <p className="mt-2 text-[11.5px] leading-relaxed text-text-subtle">
            {note}
          </p>
        ) : null}
      </PaneSection>
      <PaneSection title="Rules">
        <p className="text-[12.5px] leading-relaxed text-text-subtle">
          Allow, deny and ask rules live under{' '}
          <code className="font-mono">permissions</code> in
          {origin ? (
            <>
              {' '}
              <span className="font-mono text-[11px]">{origin}</span>
            </>
          ) : (
            <> the settings file this scope writes</>
          )}
          . Edit them there, or from the CLI. A running session&rsquo;s rules can
          differ, and are shown on its session inspector.
        </p>
      </PaneSection>
    </>
  )
}

/** Renderer-owned appearance and transcript preferences. */
function AppScopeBody() {
  return (
    <>
      <AppearanceSection />
      <TranscriptDisplaySection />
    </>
  )
}

/** App palette controls use a radiogroup so each swatch has a named choice. */
function AppearanceSection() {
  const { accent, setAccent } = useContext(AccentThemeContext)
  const { glass, setGlass } = useContext(GlassModeContext)
  const { scheme, appearance, setScheme } = useContext(ColorSchemeContext)
  return (
    <PaneSection title="Appearance">
      <Field
        desc={
          // §7 "say only what is surprising": the two forced choices describe
          // themselves, so only "Match system" gets a second sentence, and only
          // because the label alone does not say which way it currently lands.
          scheme === 'system'
            ? `Light or dark for the whole window, the frosted blur included. Your system is ${appearance} right now.`
            : 'Light or dark for the whole window, the frosted blur included.'
        }
        label="Appearance"
        settingKey="scheme"
        modified={scheme !== DEFAULT_COLOR_SCHEME}
        onReset={() => setScheme(DEFAULT_COLOR_SCHEME)}
      >
        <SelectControl
          label="Appearance"
          onChange={next => {
            if (isColorSchemeKey(next)) setScheme(next)
          }}
          optionLabels={COLOR_SCHEME_LABELS}
          options={COLOR_SCHEME_KEYS}
          value={scheme}
        />
      </Field>
      <Field
        desc="Let the desktop show through the window as a blur, instead of a solid background. macOS only."
        label="Frosted window"
        settingKey="glass"
        modified={glass !== DEFAULT_GLASS_ENABLED}
        onReset={() => setGlass(DEFAULT_GLASS_ENABLED)}
      >
        <ToggleSwitch label="Frosted window" onChange={setGlass} value={glass} />
      </Field>
      <Field
        desc="Used for active states, the live indicator, and toggles."
        label="Accent color"
        settingKey="accent"
        modified={accent !== DEFAULT_ACCENT}
        onReset={() => setAccent(DEFAULT_ACCENT)}
      >
        <div aria-label="Accent color" className="flex gap-[7px]" role="radiogroup">
          {ACCENT_KEYS.map(key => (
            <button
              aria-checked={accent === key}
              aria-label={ACCENT_LABELS[key]}
              className={`h-[22px] w-[22px] rounded-full ${ACCENT_SWATCH_CLASS[key]} ${
                accent === key
                  ? 'ring-2 ring-text-primary'
                  : 'ring-1 ring-white/15'
              }`}
              key={key}
              onClick={() => setAccent(key)}
              role="radio"
              title={ACCENT_LABELS[key]}
              type="button"
            />
          ))}
        </div>
      </Field>
    </PaneSection>
  )
}

const CODE_THEME_DESC =
  'Color theme for fenced code blocks in the transcript.'

/**
 * The APP-LOCAL editors: how each tool call is drawn (`toolCardStyle.ts`),
 * whether tool cards start open (`toolsExpanded.ts`), how the transcript
 * renders reasoning summaries (`reasoningLayout.ts`), and which palette colors
 * its code blocks (`codeTheme.ts`). None carries a `SourceBadge` because none
 * has a settings layer — they are renderer view preferences in the renderer's
 * own storage, not `SettingsSchema` keys the sidecar writes.
 *
 * The code theme lives here because it is a renderer preference. The engine's
 * syntax-highlighting option applies to the terminal, not the desktop transcript.
 */
function TranscriptDisplaySection() {
  const [arrivalPreviewOpen, setArrivalPreviewOpen] = useState(false)
  const [toolPreviewOpen, setToolPreviewOpen] = useState(false)
  const [codePreviewOpen, setCodePreviewOpen] = useState(false)
  const { mode, setMode } = useContext(ReasoningLayoutContext)
  const { theme, setTheme } = useContext(CodeThemeContext)
  const { expanded: toolsExpanded, setExpanded: setToolsExpanded } =
    useContext(ToolsExpandedContext)
  const { style: toolCardStyle, setStyle: setToolCardStyle } =
    useContext(ToolCardStyleContext)
  const { arrival, setArrival } = useContext(ProseArrivalContext)
  return (
    <PaneSection title="Transcript">
      <Field
        desc="How a reply appears as it arrives. Every option shows text the moment it is delivered."
        label="Text arrival"
        settingKey="arrival"
        modified={arrival !== DEFAULT_PROSE_ARRIVAL}
        onReset={() => setArrival(DEFAULT_PROSE_ARRIVAL)}
      >
        <SelectControl
          label="Text arrival"
          onChange={next => {
            if (isProseArrival(next)) setArrival(next)
          }}
          optionLabels={PROSE_ARRIVAL_LABELS}
          options={PROSE_ARRIVALS}
          value={arrival}
        />
      </Field>
      <details className="border-b border-shell-seam py-2.5 text-[12px] text-text-muted" onToggle={event => setArrivalPreviewOpen(event.currentTarget.open)}>
        <summary className="w-fit cursor-pointer">Preview text arrival</summary>
        {arrivalPreviewOpen ? <div className="max-w-[520px] pt-3"><ProseArrivalPreview /></div> : null}
      </details>
      <Field
        desc="How each tool call is drawn in the transcript."
        label="Tool calls"
        settingKey="toolCardStyle"
        modified={toolCardStyle !== DEFAULT_TOOL_CARD_STYLE}
        onReset={() => setToolCardStyle(DEFAULT_TOOL_CARD_STYLE)}
      >
        <SelectControl
          label="Tool calls"
          onChange={next => {
            if (isToolCardStyle(next)) setToolCardStyle(next)
          }}
          optionLabels={TOOL_CARD_STYLE_LABELS}
          options={TOOL_CARD_STYLES}
          value={toolCardStyle}
        />
      </Field>
      <details className="border-b border-shell-seam py-2.5 text-[12px] text-text-muted" onToggle={event => setToolPreviewOpen(event.currentTarget.open)}>
        <summary className="w-fit cursor-pointer">Preview tool calls</summary>
        {toolPreviewOpen ? <div className="max-w-[520px] pt-3"><ToolCardStylePreview /></div> : null}
      </details>
      <Field
        desc="Open every tool card as it arrives, instead of showing a preview you click to expand."
        label="Tools open by default"
        settingKey="toolsExpanded"
        modified={toolsExpanded !== DEFAULT_TOOLS_EXPANDED}
        onReset={() => setToolsExpanded(DEFAULT_TOOLS_EXPANDED)}
      >
        <ToggleSwitch
          label="Tools open by default"
          onChange={setToolsExpanded}
          value={toolsExpanded}
        />
      </Field>
      <Field
        desc="How reasoning summaries are laid out."
        label="Reasoning layout"
        settingKey="reasoningLayout"
      >
        <SelectControl
          label="Reasoning layout"
          onChange={next => {
            if (isReasoningLayoutMode(next)) setMode(next)
          }}
          optionLabels={REASONING_LAYOUT_LABELS}
          options={REASONING_LAYOUT_MODES}
          value={mode}
        />
      </Field>
      <Field
        desc={CODE_THEME_DESC}
        label="Code theme"
        settingKey="codeTheme"
        modified={theme !== DEFAULT_CODE_THEME}
        onReset={() => setTheme(DEFAULT_CODE_THEME)}
      >
        <SelectControl
          label="Code theme"
          onChange={next => {
            if (isCodeThemeKey(next)) setTheme(next)
          }}
          optionLabels={CODE_THEME_LABELS}
          options={CODE_THEME_KEYS}
          value={theme}
        />
      </Field>
      <details className="border-b border-shell-seam py-2.5 text-[12px] text-text-muted" onToggle={event => setCodePreviewOpen(event.currentTarget.open)}>
        <summary className="w-fit cursor-pointer">Preview code theme</summary>
        {codePreviewOpen ? <div className="max-w-[520px] pt-3"><CodeThemePreview /></div> : null}
      </details>
    </PaneSection>
  )
}

/** The Enforced scope: the machine's read-only policy floor. */
function ManagedPanel({
  snapshot,
  sessionOpen,
}: {
  snapshot: SettingsSnapshot | null
  sessionOpen: boolean
}) {
  const managed = selectManagedFields(snapshot)
  const policyOrigin = snapshot?.policyOrigin ?? null
  const layerOrigin = selectLayerOrigin(snapshot, 'policySettings')
  return (
    <>
      <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-source-policy/25 bg-source-policy/5 px-4 py-3">
        <span className="mt-px shrink-0 text-source-policy">
          <LockIcon className="h-[15px] w-[15px]" />
        </span>
        <div>
          <div className="text-[13px] font-semibold text-source-policy">
            Managed by your organization
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">
            These settings are enforced by policy and cannot be changed locally.
            They always override user, project, and local configuration.
          </p>
          {policyOrigin ? (
            <code className="mt-1.5 inline-block font-mono text-[11px] text-text-subtle">
              policy source: {policyOrigin}
              {layerOrigin ? ` · ${layerOrigin}` : ''}
            </code>
          ) : null}
        </div>
      </div>
      <PaneSection title="Enforced settings">
        {/* "Nothing is enforced" is a claim about org policy, and this is the
         * pane an operator checks to find that out. It may only be made from a
         * snapshot that was actually read — see `settingsReadState.ts`. */}
        {!settingsWereRead(snapshot) ? (
          <p className="text-[12.5px] text-text-subtle">
            {settingsUnreadNote(sessionOpen)} Whether your organization enforces
            any settings is{' '}
            <span className="font-mono">{SETTINGS_UNKNOWN_VALUE}</span> until
            then.
          </p>
        ) : managed.length === 0 ? (
          <p className="text-[12.5px] text-text-subtle">
            No managed settings on this machine.
          </p>
        ) : (
          managed.map(field => (
            <Field key={field.key} label={field.key} managed origin={layerOrigin}>
              <span className="font-mono text-[12.5px] text-text-muted">
                enforced
              </span>
            </Field>
          ))
        )}
      </PaneSection>
      {settingsWereRead(snapshot) && managed.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-text-subtle">
          <span>Policy beats every other layer:</span>
          <SourceBadge origin={layerOrigin} source="policySettings" />
        </div>
      ) : null}
    </>
  )
}
