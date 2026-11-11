import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8')
const header = (name: string) => source(name).split('<header ')[1]!.split('</header>')[0]!

test('every side pane starts its header with shared pane history and closes last', () => {
  for (const name of ['FilePane', 'BrowserPane', 'ComputerPane', 'SubagentSidePanel', 'ToolInspector']) {
    const text = header(name)
    expect(text.indexOf('<SidePaneNavigation />')).toBeLessThan(text.indexOf('<button'))
    expect(text).toMatch(/aria-label="(?:Close|Hide) /)
  }
})

test('file controls follow history, Files, Reload, path, existing app actions, Close order', () => {
  for (const text of source('FilePane').split('<header ').slice(1).map(part => part.split('</header>')[0]!)) {
    const positions = ['<SidePaneNavigation />', '<FilePaneFiles ', 'aria-label="Reload"', 'className="file-pane-path', 'className="file-pane-app-split"', 'aria-label="Close file"'].map(token => text.indexOf(token))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  }
})

test('browser uses unified history before Reload and address, never native history flags', () => {
  const text = header('BrowserPane')
  expect(text.indexOf('<SidePaneNavigation />')).toBeLessThan(text.indexOf("action('reload'"))
  expect(text.indexOf("action('reload'")).toBeLessThan(text.indexOf('file-pane-path'))
  expect(text).not.toContain('state.canGoBack')
  expect(text).not.toContain('state.canGoForward')
})

test('worker header keeps one identity line and the dock remains the only worker switcher', () => {
  const text = header('SubagentSidePanel')
  expect(text).not.toContain('<nav')
  expect(text).not.toContain('subagent-side-switch')
  expect(text).not.toContain('pulse=')
  expect(text.match(/className="subagent-side-line"/g)).toHaveLength(1)
  expect(text.indexOf('<AgentFace')).toBeLessThan(text.indexOf('subagent-side-name'))
  expect(text.indexOf('subagent-side-name')).toBeLessThan(text.indexOf('subagent-side-model'))
})
