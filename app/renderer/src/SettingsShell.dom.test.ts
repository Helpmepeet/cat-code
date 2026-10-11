import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { SettingsShell } from './SettingsShell.js'
import type { SettingsInventoryReadResult, SettingsWriteReadResult } from '../../shared/hostApi.js'
import type { MemorySnapshot, SettingsSnapshot, SettingsVerbMessage } from '../../shared/protocol.js'

let harness: DomTestHarness
let previousBridge: typeof window.catcode | undefined
let readInventory: (cwd: string | null) => Promise<SettingsInventoryReadResult>
let writeSetting: (cwd: string | null, verb: SettingsVerbMessage) => Promise<SettingsWriteReadResult>
let pickProject: () => Promise<{ cwd: string; name: string } | null>

const durableSettings: SettingsSnapshot = {
  layers: [], resolved: [], policyOrigin: null, editableValues: [], availableOptions: [],
}
const durableMemory: MemorySnapshot = {
  autoMemoryEnabled: true,
  autoMemoryDir: '/memory',
  autoMemoryEntrypoint: '/memory/MEMORY.md',
  instructionFiles: [], autoMemories: [], agentMemories: [], notes: [],
}

function durableInventory(cwd: string | null): SettingsInventoryReadResult {
  return {
    ok: true,
    inventory: {
      cwd: cwd ?? '/user',
      extensions: { mcp: [], plugins: [], skills: [], hooks: [] },
      agents: { definitions: [], failedFiles: [], availableMcpServers: [] },
      settings: durableSettings,
      memory: durableMemory,
    },
  }
}

function booleanInventory(
  cwd: string | null,
  values: Readonly<Record<string, boolean>>,
): SettingsInventoryReadResult {
  const result = durableInventory(cwd)
  if (result.ok) result.inventory.settings = {
    ...durableSettings,
    layers: [{ source: 'userSettings', origin: '/user/settings.json', keys: Object.keys(values) }],
    resolved: Object.keys(values).map(key => ({ key, source: 'userSettings', editable: true, managed: false })),
    editableValues: Object.entries(values).map(([key, value]) => ({ key, source: 'userSettings', value })),
  }
  return result
}

beforeAll(async () => {
  harness = await createDomTestHarness()
  previousBridge = window.catcode
  readInventory = async cwd => ({
    ok: true,
    inventory: {
      cwd: cwd ?? '/user',
      extensions: { mcp: [], plugins: [], skills: [], hooks: [] },
      agents: { definitions: [], failedFiles: [], availableMcpServers: [] },
      settings: null,
      memory: null,
    },
  })
  writeSetting = async () => ({ ok: true, message: 'Saved' })
  pickProject = async () => null
  window.catcode = {
    readSettingsInventory: cwd => readInventory(cwd),
    writeDurableSetting: (cwd, verb) => writeSetting(cwd, verb),
    pickSettingsProject: () => pickProject(),
  } as typeof window.catcode
})

afterEach(async () => {
  await harness.unmountAll()
  readInventory = async cwd => durableInventory(cwd)
  writeSetting = async () => ({ ok: true, message: 'Saved' })
  pickProject = async () => null
})

afterAll(async () => {
  if (previousBridge) window.catcode = previousBridge
  else delete (window as unknown as Record<string, unknown>).catcode
  await harness.teardown()
})

async function typeInput(input: HTMLInputElement, query: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a search result opens Appearance and focuses the Code theme control', async () => {
  const tree = await harness.mount(createElement(SettingsShell, { initialCategory: 'general' }))
  try {
    expect(tree.container.querySelector('.animate-land')).toBeNull()
    const search = tree.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search all settings"]',
    )
    expect(search).not.toBeNull()
    await typeInput(search!, 'code theme')

    const result = tree.container.querySelector<HTMLButtonElement>(
      'section[aria-label="Search results"] button',
    )
    expect(result?.textContent).toContain('Code theme')
    await act(async () => result!.click())

    const select = tree.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Code theme"]',
    )
    expect(select).not.toBeNull()
    expect(harness.document.activeElement).toBe(select)
    const landingRows = tree.container.querySelectorAll<HTMLElement>('[data-setting-key].animate-land')
    expect(landingRows).toHaveLength(1)
    expect(landingRows[0]?.dataset.settingKey).toBe('codeTheme')
    landingRows[0]?.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(tree.container.querySelector('.animate-land')).toBeNull()
  } finally {
    const general = Array.from(tree.container.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Settings categories"] button',
    )).find(button => button.textContent === 'General')
    if (general) await act(async () => general.click())
  }
})

test('Skills loads for a chosen project without an open session and follows project selection', async () => {
  const requested: Array<string | null> = []
  readInventory = async cwd => {
    requested.push(cwd)
    return {
      ok: true,
      inventory: {
        cwd: cwd ?? '/user',
        extensions: {
          mcp: [], plugins: [], hooks: [],
          skills: [{
            name: cwd === '/repo-b' ? 'beta-skill' : 'alpha-skill',
            source: 'userSettings',
            description: 'A configured skill',
            context: 'inline',
            disableModelInvocation: false,
            userInvocable: true,
          }],
        },
        agents: { definitions: [], failedFiles: [], availableMcpServers: [] },
        settings: null,
        memory: null,
      },
    }
  }
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'skills',
    projects: [
      { cwd: '/repo-a', name: 'Repo A' },
      { cwd: '/repo-b', name: 'Repo B' },
    ],
  }))
  expect(requested).toEqual(['/repo-a'])
  expect(tree.container.textContent).toContain('/alpha-skill')
  expect(tree.container.textContent).not.toContain('Open a session')

  const selector = tree.container.querySelector<HTMLSelectElement>('select[aria-label="Configuration for"]')
  expect(selector).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(selector, '/repo-b')
    selector!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(requested).toEqual(['/repo-a', '/repo-b'])
  expect(tree.container.textContent).toContain('/beta-skill')
  expect(tree.container.textContent).not.toContain('/alpha-skill')
})

test('General and Memory read durable configuration without a chat', async () => {
  readInventory = async cwd => durableInventory(cwd)
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'general',
  }))
  expect(tree.container.textContent).toContain('Respect .gitignore')
  const toggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )
  expect(toggle?.disabled).toBe(false)
  expect(tree.container.textContent).not.toContain('Open a session')

  const memory = Array.from(tree.container.querySelectorAll<HTMLButtonElement>(
    'nav[aria-label="Settings categories"] button',
  )).find(button => button.textContent === 'Memory')
  await act(async () => memory!.click())
  expect(tree.container.textContent).toContain('Memory sources')
  expect(tree.container.textContent).toContain('Auto memory is enabled for this configuration.')
})

test('project edits name the selected project and chosen settings layer', async () => {
  const reads: Array<string | null> = []
  const writes: Array<{ cwd: string | null; verb: SettingsVerbMessage }> = []
  readInventory = async cwd => {
    reads.push(cwd)
    return durableInventory(cwd)
  }
  writeSetting = async (cwd, verb) => {
    writes.push({ cwd, verb })
    return { ok: true, message: 'Saved' }
  }
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'general',
    initialScope: 'project',
    projects: [
      { cwd: '/repo-a', name: 'Repo A' },
      { cwd: '/repo-b', name: 'Repo B' },
    ],
  }))
  const project = tree.container.querySelector<HTMLSelectElement>('select[aria-label="Project"]')
  expect(project).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(project, '/repo-b')
    project!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(reads).toEqual(['/repo-a', '/repo-b'])
  const justMe = Array.from(tree.container.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Where project edits are saved"] button',
  )).find(button => button.textContent === 'Just me')
  await act(async () => justMe!.click())
  const toggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )
  expect(toggle?.disabled).toBe(false)
  await act(async () => toggle!.click())
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    cwd: '/repo-b',
    verb: {
      type: 'settings.setValue', source: 'localSettings', key: 'respectGitignore', value: false,
    },
  })
  expect(reads).toEqual(['/repo-a', '/repo-b', '/repo-b'])
  expect(tree.container.textContent).toContain('Saved')
})

test('a failed acknowledgement still rereads the saved file', async () => {
  let reads = 0
  readInventory = async cwd => {
    reads += 1
    const result = durableInventory(cwd)
    if (result.ok && reads > 1) {
      result.inventory.settings = {
        ...durableSettings,
        layers: [{ source: 'userSettings', origin: '/user/settings.json', keys: ['respectGitignore'] }],
        resolved: [{ key: 'respectGitignore', source: 'userSettings', editable: true, managed: false }],
        editableValues: [{ key: 'respectGitignore', source: 'userSettings', value: false }],
      }
    }
    return result
  }
  writeSetting = async () => ({
    ok: false,
    error: { code: 'unavailable', message: 'Save acknowledgement unavailable.' },
  })
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'general',
  }))
  const toggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )
  await act(async () => toggle!.click())
  expect(reads).toBe(2)
  expect(tree.container.querySelector('[role="alert"]')?.textContent)
    .toContain('Save acknowledgement unavailable.')
  expect(tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )?.getAttribute('aria-checked')).toBe('false')
})

test('Permissions and Policies use the durable inventory without a chat', async () => {
  readInventory = async cwd => {
    const result = durableInventory(cwd)
    if (result.ok) {
      result.inventory.settings = {
        ...durableSettings,
        layers: [
          { source: 'userSettings', origin: '/user/settings.json', keys: ['permissions.defaultMode'] },
          { source: 'policySettings', origin: '/managed/settings.json', keys: ['telemetry'] },
        ],
        resolved: [{ key: 'telemetry', source: 'policySettings', editable: false, managed: true }],
        policyOrigin: 'file',
        permissionDefaultMode: { value: 'acceptEdits', source: 'userSettings' },
      }
    }
    return result
  }
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'permissions',
  }))
  expect(tree.container.textContent).toContain('Default permission mode')
  expect(tree.container.textContent).toContain('acceptEdits')
  expect(tree.container.querySelector('button[role="switch"]')).toBeNull()
  expect(tree.container.textContent).not.toContain('Open a session')

  const policies = Array.from(tree.container.querySelectorAll<HTMLButtonElement>(
    'nav[aria-label="Settings categories"] button',
  )).find(button => button.textContent?.includes('Policies'))
  await act(async () => policies!.click())
  expect(tree.container.textContent).toContain('telemetry')
  expect(tree.container.textContent).toContain('Managed by your organization')
})

test('a new project can be picked and edited without opening a chat', async () => {
  const reads: Array<string | null> = []
  const writes: Array<string | null> = []
  readInventory = async cwd => {
    reads.push(cwd)
    return durableInventory(cwd)
  }
  pickProject = async () => ({ cwd: '/new-project', name: 'New project' })
  writeSetting = async cwd => {
    writes.push(cwd)
    return { ok: true, message: 'Saved' }
  }
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'general',
    initialScope: 'project',
  }))
  const choose = Array.from(tree.container.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent === 'Choose project…')
  expect(choose).not.toBeNull()
  await act(async () => choose!.click())
  expect(reads).toContain('/new-project')
  expect(tree.container.textContent).toContain('Project: New project')
  const toggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )
  expect(toggle?.disabled).toBe(false)
  await act(async () => toggle!.click())
  expect(writes).toEqual(['/new-project'])
})

test('an older write completion cannot replace a newer result', async () => {
  let reads = 0
  readInventory = async cwd => {
    reads += 1
    const result = durableInventory(cwd)
    // The acknowledged value stays durable on every subsequent read.
    if (result.ok && reads >= 2) {
      result.inventory.settings = {
        ...durableSettings,
        layers: [{ source: 'userSettings', origin: '/user/settings.json', keys: ['respectGitignore'] }],
        resolved: [{ key: 'respectGitignore', source: 'userSettings', editable: true, managed: false }],
        editableValues: [{ key: 'respectGitignore', source: 'userSettings', value: false }],
      }
    }
    return result
  }
  const pending: Array<(result: SettingsWriteReadResult) => void> = []
  writeSetting = async () => new Promise<SettingsWriteReadResult>(resolve => pending.push(resolve))
  const tree = await harness.mount(createElement(SettingsShell, {
    cwd: null,
    initialCategory: 'general',
  }))
  const toggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )
  const otherToggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Git workflow instructions"]',
  )
  await act(async () => { toggle!.click(); otherToggle!.click() })
  expect(pending).toHaveLength(2)
  await act(async () => pending[1]!({ ok: true, message: 'Saved' }))
  await act(async () => pending[0]!({
    ok: false,
    error: { code: 'unavailable', message: 'Old write failed.' },
  }))
  expect(reads).toBe(3)
  expect(tree.container.textContent).toContain('Saved')
  expect(tree.container.textContent).not.toContain('Old write failed.')
  expect(tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )?.getAttribute('aria-checked')).toBe('false')
})

test('independent successful settings writes render both values when commits finish in reverse order', async () => {
  const values = { respectGitignore: true, includeGitInstructions: true }
  const commits = new Map<string, () => void>()
  readInventory = async cwd => booleanInventory(cwd, values)
  writeSetting = (_cwd, verb) => new Promise(resolve => {
    if (typeof verb.value !== 'boolean') throw new Error('Expected a boolean setting write')
    const value = verb.value
    commits.set(verb.key, () => {
      Object.assign(values, { [verb.key]: value })
      resolve({ ok: true, message: 'Saved' })
    })
  })
  const tree = await harness.mount(createElement(SettingsShell, { initialCategory: 'general' }))
  const a = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )!
  const b = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Git workflow instructions"]',
  )!
  await act(async () => { a.click(); b.click() })
  expect(commits.size).toBe(2)
  await act(async () => commits.get('includeGitInstructions')!())
  expect(b.getAttribute('aria-checked')).toBe('false')
  expect(a.disabled).toBe(true)
  await act(async () => commits.get('respectGitignore')!())
  expect(a.getAttribute('aria-checked')).toBe('false')
  expect(b.getAttribute('aria-checked')).toBe('false')
  expect(a.disabled).toBe(false)
  expect(b.disabled).toBe(false)
  expect(tree.container.textContent).toContain('Saved')
})

test('a delayed earlier inventory read cannot replace a newer post-commit read', async () => {
  const values = { respectGitignore: true, includeGitInstructions: true }
  const commits = new Map<string, () => void>()
  const readCompletions: Array<() => void> = []
  let reads = 0
  readInventory = cwd => {
    const snapshot = booleanInventory(cwd, values)
    return ++reads === 1 ? Promise.resolve(snapshot) : new Promise(resolve => {
      readCompletions.push(() => resolve(snapshot))
    })
  }
  writeSetting = (_cwd, verb) => new Promise(resolve => {
    if (typeof verb.value !== 'boolean') throw new Error('Expected a boolean setting write')
    const value = verb.value
    commits.set(verb.key, () => {
      Object.assign(values, { [verb.key]: value })
      resolve({ ok: true, message: 'Saved' })
    })
  })
  const tree = await harness.mount(createElement(SettingsShell, { initialCategory: 'general' }))
  const a = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )!
  const b = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Git workflow instructions"]',
  )!
  await act(async () => { a.click(); b.click() })
  await act(async () => commits.get('respectGitignore')!())
  await act(async () => commits.get('includeGitInstructions')!())
  expect(readCompletions).toHaveLength(2)
  await act(async () => readCompletions[1]!())
  expect(a.getAttribute('aria-checked')).toBe('false')
  expect(b.getAttribute('aria-checked')).toBe('false')
  await act(async () => readCompletions[0]!())
  expect(a.getAttribute('aria-checked')).toBe('false')
  expect(b.getAttribute('aria-checked')).toBe('false')
  expect(a.disabled).toBe(false)
  expect(tree.container.textContent).toContain('Saved')
})

test('a failed retention draft does not carry into another settings layer', async () => {
  readInventory = async cwd => {
    const result = durableInventory(cwd)
    if (result.ok) result.inventory.settings = {
      ...durableSettings,
      layers: [{ source: 'userSettings', origin: '/user/settings.json', keys: ['cleanupPeriodDays'] }],
      resolved: [{ key: 'cleanupPeriodDays', source: 'userSettings', editable: true, managed: false }],
      editableValues: [{ key: 'cleanupPeriodDays', source: 'userSettings', value: 30 }],
    }
    return result
  }
  writeSetting = async () => ({
    ok: false,
    error: { code: 'unavailable', message: 'Could not save setting.' },
  })
  const tree = await harness.mount(createElement(SettingsShell, {
    initialCategory: 'privacy', initialScope: 'project',
    projects: [{ cwd: '/repo-a', name: 'Repo A' }],
  }))
  const input = tree.container.querySelector<HTMLInputElement>(
    'input[aria-label="Transcript retention (days)"]',
  )!
  await typeInput(input, '7')
  await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(tree.container.querySelector('[role="alert"]')?.textContent).toContain('Could not save setting.')

  const justMe = Array.from(tree.container.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Where project edits are saved"] button',
  )).find(button => button.textContent === 'Just me')!
  await act(async () => justMe.click())
  expect(tree.container.querySelector<HTMLInputElement>(
    'input[aria-label="Transcript retention (days)"]',
  )?.value).toBe('30')
})

test('a pending toggle is disabled until its saved value has been reloaded', async () => {
  let resolveWrite!: (result: SettingsWriteReadResult) => void
  let resolveReload!: (result: SettingsInventoryReadResult) => void
  let reads = 0
  const writes: SettingsVerbMessage[] = []
  readInventory = cwd => ++reads === 1
    ? Promise.resolve(durableInventory(cwd))
    : new Promise(resolve => { resolveReload = resolve })
  writeSetting = async (_cwd, verb) => {
    writes.push(verb)
    return new Promise(resolve => { resolveWrite = resolve })
  }
  const tree = await harness.mount(createElement(SettingsShell, { initialCategory: 'general' }))
  const toggle = tree.container.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label="Respect .gitignore"]',
  )!
  await act(async () => { toggle.click(); toggle.click() })
  expect(writes).toHaveLength(1)
  expect(toggle.disabled).toBe(true)
  await act(async () => resolveWrite({ ok: true, message: 'Saved' }))
  expect(toggle.disabled).toBe(true)

  const reloaded = durableInventory(null)
  if (reloaded.ok) reloaded.inventory.settings = {
    ...durableSettings,
    layers: [{ source: 'userSettings', origin: '/user/settings.json', keys: ['respectGitignore'] }],
    resolved: [{ key: 'respectGitignore', source: 'userSettings', editable: true, managed: false }],
    editableValues: [{ key: 'respectGitignore', source: 'userSettings', value: false }],
  }
  await act(async () => resolveReload(reloaded))
  expect(toggle.disabled).toBe(false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

test('search waits for a newly loaded scope before focusing its setting', async () => {
  let resolveUser!: (result: SettingsInventoryReadResult) => void
  readInventory = cwd => cwd === null
    ? new Promise(resolve => { resolveUser = resolve })
    : Promise.resolve(durableInventory(cwd))
  const tree = await harness.mount(createElement(SettingsShell, {
    initialCategory: 'skills', projects: [{ cwd: '/repo-a', name: 'Repo A' }],
  }))
  await typeInput(tree.container.querySelector<HTMLInputElement>(
    'input[aria-label="Search all settings"]',
  )!, 'retention')
  await act(async () => tree.container.querySelector<HTMLButtonElement>(
    'section[aria-label="Search results"] button',
  )!.click())
  expect(tree.container.textContent).toContain('Loading configuration')
  await act(async () => resolveUser(durableInventory(null)))
  const retention = tree.container.querySelector<HTMLInputElement>(
    'input[aria-label="Transcript retention (days)"]',
  )
  expect(retention).not.toBeNull()
  expect(harness.document.activeElement === retention).toBe(true)
})

test('inventory retry recovers the selected project and ignores a completion after switching projects', async () => {
  const requested: Array<string | null> = []
  let resolveRetry!: (result: SettingsInventoryReadResult) => void
  readInventory = cwd => {
    requested.push(cwd)
    if (requested.length === 1 || requested.length === 3) return Promise.resolve({
      ok: false,
      error: { code: 'unavailable', message: 'Configuration could not be read.' },
    })
    return requested.length === 2 || requested.length === 4
      ? new Promise(resolve => { resolveRetry = resolve })
      : Promise.resolve(durableInventory(cwd))
  }
  const tree = await harness.mount(createElement(SettingsShell, {
    initialCategory: 'general', initialScope: 'project',
    projects: [{ cwd: '/repo-a', name: 'Repo A' }, { cwd: '/repo-b', name: 'Repo B' }],
  }))
  expect(tree.container.querySelector('[role="alert"]')?.textContent).toContain('Configuration could not be read.')
  const retry = tree.container.querySelector<HTMLButtonElement>('button[aria-label="Retry configuration"]')
  expect(retry).not.toBeNull()
  await act(async () => { retry!.click(); retry!.click() })
  expect(requested).toEqual(['/repo-a', '/repo-a'])
  expect(tree.container.querySelector('button[aria-label="Retry configuration"]')).toBeNull()
  await act(async () => resolveRetry(durableInventory('/repo-a')))
  expect(tree.container.textContent).toContain('Respect .gitignore')
  expect(tree.container.querySelector('[role="alert"]')).toBeNull()

  const project = tree.container.querySelector<HTMLSelectElement>('select[aria-label="Project"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(project, '/repo-b')
    project.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const retryOtherProject = tree.container.querySelector<HTMLButtonElement>('button[aria-label="Retry configuration"]')!
  await act(async () => retryOtherProject.click())
  expect(requested).toEqual(['/repo-a', '/repo-a', '/repo-b', '/repo-b'])
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(project, '/repo-a')
    project.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(tree.container.textContent).toContain('Respect .gitignore')
  await act(async () => resolveRetry({
    ok: false,
    error: { code: 'unavailable', message: 'Old project read failed.' },
  }))
  expect(project.value).toBe('/repo-a')
  expect(tree.container.textContent).not.toContain('Old project read failed.')
  expect(tree.container.textContent).toContain('Respect .gitignore')
})
