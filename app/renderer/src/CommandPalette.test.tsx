import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommandPalette } from './CommandPalette.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PALETTE_LAYER = 210

function zLayers(source: string): number[] {
  return Array.from(source.matchAll(/\bz-(?:\[(\d+)\]|(\d+))|\bz-index:\s*(\d+)/g), match =>
    Number(match[1] ?? match[2] ?? match[3]),
  )
}

test('the global palette emits its dedicated top-modal layer', () => {
  const html = renderToStaticMarkup(
    <CommandPalette items={[]} onClose={() => {}} open />,
  )
  expect(html).toContain('z-[210]')
  expect(html).toContain('aria-label="Command palette"')
})

test('the global palette layer is above every current modal owner it can interrupt', () => {
  const modalOwners = readdirSync(ROOT)
    .filter(file => file.endsWith('.tsx') && !file.includes('.test.'))
    .filter(file =>
      readFileSync(join(ROOT, file), 'utf8').includes('useModalFocus({'),
    )
    .sort()

  expect(modalOwners).toEqual([
    'AccountsPage.tsx',
    'AgentsPage.tsx',
    'CommandPalette.tsx',
    'CreateProjectDialog.tsx',
    'MetadataInspector.tsx',
    'PlanPanel.tsx',
    'SAModal.tsx',
    'StartupSurfaces.tsx',
    'TasksDialog.tsx',
    'TranscriptView.tsx',
  ])

  for (const file of modalOwners) {
    if (file === 'CommandPalette.tsx') continue
    const stylesheet = join(ROOT, file.replace(/\.tsx$/, '.css'))
    const layers = zLayers(
      readFileSync(join(ROOT, file), 'utf8') +
      (existsSync(stylesheet) ? readFileSync(stylesheet, 'utf8') : ''),
    )
    expect(layers.length).toBeGreaterThan(0)
    expect(Math.max(...layers)).toBeLessThan(PALETTE_LAYER)
  }
})
