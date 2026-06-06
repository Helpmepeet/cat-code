import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import {
  buildMapContextReminder,
  matchSubsystemMaps,
  parseMapScopes,
} from './subsystemMapContext.js'

// This test file lives at src/utils/processUserInput/; the repo root (which
// holds docs/maps/) is three directories up. Derive it rather than hardcoding a
// checkout path so the tests pass in any clone/CI workspace.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')

const SAMPLE_TABLE = `# Workspace Map

| Sub-map | Scope |
|---|---|
| [\`codex-core.md\`](codex-core.md) | Codex-backed API behavior, account pool, request/response shaping, and provider routing. |
| [\`auth-accounts-oauth.md\`](auth-accounts-oauth.md) | Auth source selection, OAuth, account storage/switching, secure storage, and account pools. |
| [\`WORKSPACE_MAP.md\`](WORKSPACE_MAP.md) | This self-row should be ignored. |
`

describe('parseMapScopes', () => {
  test('extracts scope for a known map', () => {
    const scopes = parseMapScopes(SAMPLE_TABLE)
    expect(scopes.get('codex-core.md')).toBe(
      'Codex-backed API behavior, account pool, request/response shaping, and provider routing.',
    )
    expect(scopes.get('auth-accounts-oauth.md')).toBe(
      'Auth source selection, OAuth, account storage/switching, secure storage, and account pools.',
    )
  })

  test('skips the header row and the WORKSPACE_MAP.md self-row', () => {
    const scopes = parseMapScopes(SAMPLE_TABLE)
    expect(scopes.has('WORKSPACE_MAP.md')).toBe(false)
    expect(scopes.has('Sub-map')).toBe(false)
    expect(scopes.size).toBe(2)
  })
})

describe('matchSubsystemMaps', () => {
  test('matches codex-core for a codex cache prompt', () => {
    const matches = matchSubsystemMaps('why is the codex cache hit rate low', {
      projectRoot: REPO_ROOT,
    })
    expect(matches.map(m => m.map)).toContain('codex-core.md')
  })

  test('matches auth map for an account lease failover prompt', () => {
    const matches = matchSubsystemMaps('fix the account lease failover', {
      projectRoot: REPO_ROOT,
    })
    // `lease` also lives in codex-core; we only assert the expected one is present.
    expect(matches.map(m => m.map)).toContain('auth-accounts-oauth.md')
  })

  test('returns [] for an unrelated prompt', () => {
    const matches = matchSubsystemMaps("what's the weather today", {
      projectRoot: REPO_ROOT,
    })
    expect(matches).toEqual([])
  })

  test('does not match single-token keywords as substrings of common words', () => {
    // Regression: `lease` in "please", `ink` in "thinking", `repl` in "reply"
    // must NOT trigger a map. These prompts have no real subsystem reference.
    for (const prompt of [
      'please fix the flaky test',
      'thinking about this error',
      'reply to the user',
    ]) {
      expect(
        matchSubsystemMaps(prompt, { projectRoot: REPO_ROOT }),
      ).toEqual([])
    }
  })

  test('still matches single-token keywords as whole words', () => {
    expect(
      matchSubsystemMaps('the repl prompt input is broken', {
        projectRoot: REPO_ROOT,
      }).map(m => m.map),
    ).toContain('terminal-ui-state.md')
  })

  test('caps at 2 matches even when many areas are hit', () => {
    const promptHittingMany =
      'the oauth login, codex cache routing, sandbox permission, repl prompt input, ' +
      'lsp diagnostic, growthbook analytics, and slash command plugin all need work'
    const matches = matchSubsystemMaps(promptHittingMany, {
      projectRoot: REPO_ROOT,
    })
    expect(matches.length).toBeLessThanOrEqual(2)
  })

  test('returns scope text alongside matched maps', () => {
    const matches = matchSubsystemMaps('codex openai gpt provider routing', {
      projectRoot: REPO_ROOT,
    })
    const codex = matches.find(m => m.map === 'codex-core.md')
    expect(codex).toBeDefined()
    expect(codex?.scope.length).toBeGreaterThan(0)
  })

  test('returns [] when projectRoot has no docs/maps directory', () => {
    const matches = matchSubsystemMaps('why is the codex cache hit rate low', {
      projectRoot: os.tmpdir(),
    })
    expect(matches).toEqual([])
  })
})

describe('buildMapContextReminder', () => {
  test('returns null on no matches', () => {
    expect(buildMapContextReminder([])).toBeNull()
  })

  test('returns a string containing the map path and filename', () => {
    const reminder = buildMapContextReminder([
      { map: 'codex-core.md', scope: 'Codex-backed API behavior.' },
    ])
    expect(reminder).not.toBeNull()
    expect(reminder).toContain('docs/maps/')
    expect(reminder).toContain('codex-core.md')
    expect(reminder).toContain('Codex-backed API behavior.')
  })

  test('handles an empty scope gracefully', () => {
    const reminder = buildMapContextReminder([
      { map: 'codex-core.md', scope: '' },
    ])
    expect(reminder).toContain('docs/maps/codex-core.md')
  })
})
