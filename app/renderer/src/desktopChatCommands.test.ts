import { describe, expect, test } from 'bun:test'
import {
  canExecuteDesktopNewChat,
  isDesktopNewChatCommand,
  mergeDesktopSlashCatalog,
  nextPlanToggleMode,
  parseDesktopRailCommand,
  selectDesktopRailCommands,
} from './desktopChatCommands.js'
import type { RunControlsSnapshot } from '../../shared/protocol.js'

function runControls(over: {
  modelValues?: (string | null)[]
  effort?: Partial<RunControlsSnapshot['effort']>
  fast?: Partial<RunControlsSnapshot['fast']>
} = {}): RunControlsSnapshot {
  return {
    model: {
      current: 'gpt-5.6-sol', currentLabel: 'GPT-5.6 Sol', contextWindow: 372_000, selected: null,
      provider: 'openai', providerSwitchLocked: false,
      options: (over.modelValues ?? [null, 'gpt-5.6-sol']).map(value => ({
        value, label: value ?? 'Default', provider: 'openai' as const, effortOptions: [],
      })),
    },
    effort: { current: 'high', selected: 'high', supported: true, options: ['low', 'high'], ...over.effort },
    fast: { active: false, supportedByModel: true, available: true, unavailableReason: null, ...over.fast },
    autoCompact: { enabled: true, threshold: 1, warningThreshold: 1 },
  }
}

describe('desktop rail commands', () => {
  const everything = {
    runControls: runControls(),
    canSetModel: true,
    canSetEffort: true,
    canSetFast: true,
    hasPermissionContext: true,
    canSwitchAccount: true,
    hasContextUsage: true,
  }

  test('recognizes only a whole-draft rail command', () => {
    expect(parseDesktopRailCommand(' /model\n')).toBe('model')
    expect(parseDesktopRailCommand('/mode ')).toBe('mode')
    expect(parseDesktopRailCommand('/model opus')).toBeNull()
    expect(parseDesktopRailCommand('/models')).toBeNull()
    expect(parseDesktopRailCommand('set /fast')).toBeNull()
  })

  test('offers each command only while its card or toggle can act', () => {
    expect(selectDesktopRailCommands(everything)).toEqual(
      ['model', 'effort', 'fast', 'mode', 'plan', 'account', 'context'],
    )
    expect(selectDesktopRailCommands({ ...everything, runControls: null }))
      .toEqual(['plan', 'account', 'context'])
    // The provider default names no model, so it alone is not a picker.
    expect(selectDesktopRailCommands({ ...everything, runControls: runControls({ modelValues: [null] }) }))
      .not.toContain('model')
    expect(selectDesktopRailCommands({ ...everything, runControls: runControls({ effort: { supported: false } }) }))
      .not.toContain('effort')
    expect(selectDesktopRailCommands({ ...everything, runControls: runControls({ fast: { supportedByModel: false } }) }))
      .not.toContain('fast')
    // Unavailable fast can still be turned off, the same as its switch.
    expect(selectDesktopRailCommands({ ...everything, runControls: runControls({ fast: { available: false } }) }))
      .not.toContain('fast')
    expect(selectDesktopRailCommands({ ...everything, runControls: runControls({ fast: { available: false, active: true } }) }))
      .toContain('fast')
    expect(selectDesktopRailCommands({ ...everything, hasPermissionContext: false }))
      .toEqual(['model', 'effort', 'fast', 'account', 'context'])
  })

  test('plan toggles back to the mode recorded on entry', () => {
    expect(nextPlanToggleMode({ mode: 'default' })).toBe('plan')
    expect(nextPlanToggleMode({ mode: 'plan', prePlanMode: 'acceptEdits' })).toBe('acceptEdits')
    expect(nextPlanToggleMode({ mode: 'plan' })).toBe('default')
    expect(nextPlanToggleMode({ mode: 'plan', prePlanMode: 'plan' })).toBe('default')
    expect(nextPlanToggleMode({ mode: 'plan', prePlanMode: 'unknown-mode' })).toBe('default')
  })

  test('adds available rail commands, including the desktop context over the hidden engine one', () => {
    const catalog = mergeDesktopSlashCatalog(
      [{ name: 'context', description: 'Engine context' }, { name: 'compact', description: 'Compact' }],
      [],
      ['model', 'context'],
    )
    expect(catalog).toEqual([
      { name: 'compact', description: 'Compact' },
      { name: 'clear', description: 'Start a new chat.' },
      { name: 'new', description: 'Start a new chat.' },
      { name: 'model', description: 'Change the model.' },
      { name: 'context', description: 'Show context usage.' },
    ])
  })
})

describe('desktop chat commands', () => {
  test('recognizes only a standalone clear or new draft', () => {
    expect(isDesktopNewChatCommand(' /clear\n')).toBe(true)
    expect(isDesktopNewChatCommand('/new')).toBe(true)
    expect(isDesktopNewChatCommand('/clear foo')).toBe(false)
    expect(isDesktopNewChatCommand('explain /clear')).toBe(false)
    expect(isDesktopNewChatCommand('/CLEAR')).toBe(false)
  })

  test('admits local chat creation independently of engine readiness', () => {
    const ready = {
      hasOrigin: true,
      hasQueuedPrompt: false,
      hasProjectRoute: false,
      workspaceBusy: false,
      preparingAttachment: false,
      managedFolderUnavailable: false,
      creationPending: false,
    }
    expect(canExecuteDesktopNewChat(ready)).toBe(true)
    expect(canExecuteDesktopNewChat({ ...ready, hasOrigin: false })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, hasQueuedPrompt: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, hasProjectRoute: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, workspaceBusy: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, preparingAttachment: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, managedFolderUnavailable: true })).toBe(false)
    expect(canExecuteDesktopNewChat({ ...ready, creationPending: true })).toBe(false)
  })

  test('adds desktop commands to rich and names-only catalogs without losing metadata', () => {
    const catalog = mergeDesktopSlashCatalog(
      [
        { name: 'help', description: 'Help text', argumentHint: '<topic>' },
        { name: 'clear', description: 'Engine description', argumentHint: '<old>' },
        { name: 'help', description: 'duplicate' },
      ],
      ['new', 'compact'],
    )
    expect(catalog).toEqual([
      { name: 'help', description: 'Help text', argumentHint: '<topic>' },
      { name: 'clear', description: 'Start a new chat.' },
      { name: 'new', description: 'Start a new chat.' },
    ])

    expect(mergeDesktopSlashCatalog([], ['help', 'compact'])).toEqual([
      { name: 'help', description: '' },
      { name: 'compact', description: '' },
      { name: 'clear', description: 'Start a new chat.' },
      { name: 'new', description: 'Start a new chat.' },
    ])
  })

  test.each(['rich', 'names-only'])('omits unused commands from the %s menu', source => {
    const removed = [
      'release-notes',
      'heapdump',
      'install-agents',
      'rename-account',
      'security-review',
      'context',
      'cost',
      'lorem-ipsum',
      'skillify',
      'remember',
      'update-config',
      'verify',
      'stuck',
      'review',
      'pr-comments',
      'cache-stats',
      'touch-all',
      'batch',
      'insights',
      'understand-anything:understand',
      'understand-anything:understand-diff',
      'understand-anything:understand-domain',
      'understand-anything:understand-dashboard',
      'understand-anything:understand-knowledge',
      'understand-anything:understand-explain',
      'understand-anything:understand-figma',
      'understand-anything:understand-onboard',
      'understand-anything:understand-chat',
    ]
    const kept = [
      'compact',
      'review-impl',
      'accounts',
      'simplify',
      'init',
      'frontend-design:frontend-design',
    ]
    const names = [...removed, ...kept]
    const rich = names.map(name => ({ name, description: `${name} description` }))
    const catalog = source === 'rich'
      ? mergeDesktopSlashCatalog(rich, names)
      : mergeDesktopSlashCatalog([], names)

    expect(catalog.map(entry => entry.name)).toEqual([...kept, 'clear', 'new'])
    expect(names).toEqual([...removed, ...kept])
    expect(rich.map(entry => entry.name)).toEqual(names)
  })
})
