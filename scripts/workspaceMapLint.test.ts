import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateWorkspaceMaps } from './workspaceMapLint.js'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-map-lint-'))
  roots.push(root)
  mkdirSync(join(root, 'docs', 'maps'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'owner.ts'), 'export {}\n')
  writeFileSync(
    join(root, 'docs', 'maps', 'WORKSPACE_MAP.md'),
    '# Workspace Map\n\nLast refreshed: 2026-07-14\n\n## Map Index\n\n| Sub-map | Scope | Last refreshed |\n|---|---|---|\n| [`docs/maps/domain.md`](domain.md) | Domain. | 2026-07-14 |\n',
  )
  writeFileSync(
    join(root, 'docs', 'maps', 'domain.md'),
    '# Domain\n\nLast refreshed: 2026-07-14\n\n## First Files To Inspect\n\n- `src/owner.ts`\n\n## Tests And Validation\n\n- Read it.\n\n## Traps And Stale Assumptions\n\n- None.\n',
  )
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('workspace map lint', () => {
  test('accepts a complete indexed map set', () => {
    const result = validateWorkspaceMaps(fixture())
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.mapCount).toBe(2)
  })

  test('reports stale dates, broken links and paths, and missing sections', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'docs', 'maps', 'domain.md'),
      '# Domain\n\nLast refreshed: 2026-07-13\n\n[Missing](missing.md)\n\n`src/missing.ts`\n',
    )
    const result = validateWorkspaceMaps(root)
    expect(result.errors).toContain('docs/maps/domain.md: Last refreshed 2026-07-13 does not match index 2026-07-14')
    expect(result.errors).toContain('docs/maps/domain.md: broken link target missing.md')
    expect(result.errors).toContain('docs/maps/domain.md: cited path does not exist: src/missing.ts')
    expect(result.warnings).toHaveLength(3)
  })

  test('does not exempt a citation because unrelated same-line prose says it was removed', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'docs', 'maps', 'domain.md'),
      '# Domain\n\nLast refreshed: 2026-07-14\n\n## First Files To Inspect\n\n- The old command was removed; inspect `src/missing.ts`.\n\n## Tests And Validation\n\n- Read it.\n\n## Traps And Stale Assumptions\n\n- None.\n',
    )
    expect(validateWorkspaceMaps(root).errors).toContain(
      'docs/maps/domain.md: cited path does not exist: src/missing.ts',
    )
  })

  test('reports malformed URI links instead of crashing', () => {
    const root = fixture()
    const mapPath = join(root, 'docs', 'maps', 'domain.md')
    writeFileSync(
      mapPath,
      '# Domain\n\nLast refreshed: 2026-07-14\n\n[Bad](bad%ZZ.md)\n\n## First Files To Inspect\n\n## Tests And Validation\n\n## Traps And Stale Assumptions\n',
    )
    expect(validateWorkspaceMaps(root).errors).toContain(
      'docs/maps/domain.md: broken link target bad%ZZ.md',
    )
  })

  test('rejects an index label that links to a different map', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'docs', 'maps', 'WORKSPACE_MAP.md'),
      '# Workspace Map\n\nLast refreshed: 2026-07-14\n\n## Map Index\n\n| Sub-map | Scope | Last refreshed |\n|---|---|---|\n| [`docs/maps/domain.md`](WORKSPACE_MAP.md) | Domain. | 2026-07-14 |\n',
    )
    expect(validateWorkspaceMaps(root).errors).toContain(
      'workspace-map index href mismatch: docs/maps/domain.md links to WORKSPACE_MAP.md',
    )
  })
})
