import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Synthetic retained transcripts, never a replacement dashboard snapshot. */
export function prepareAnalyticsFixture(configHome: string, cwd: string, now = new Date()): string[] {
  const project = join(configHome, 'projects', 'analytics-fixture')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(configHome, 'fixture-home'), { recursive: true })
  const files: string[] = []
  const models = ['gpt-6.1-sol', 'claude-opus-4-6', 'gpt-5.5', 'claude-sonnet-4-6']
  const tools = ['Bash', 'Read', 'Edit', 'Skill', 'SendToPeer', 'WebFetch', 'GenerateImage', 'mcp__cua-driver__click', 'JumpWorkspace', 'ClaudeCli']
  for (let session = 0; session < 3; session++) {
    const sessionId = `00000000-0000-4000-8000-${String(session + 1).padStart(12, '0')}`
    for (const source of ['chat', 'subagents', 'compaction']) {
      const rows: unknown[] = []
      for (let day = 0; day < 65; day++) for (let call = 0; call < 15; call++) {
        if (day > 7 && day !== 32 && day !== 64) continue
        if (session !== day % 3) continue
        const timestamp = new Date(now)
        timestamp.setDate(timestamp.getDate() - day)
        timestamp.setHours(6 + Math.floor(call / 3) * 3, session, call % 3 * 20, 0)
        if (timestamp >= now) continue
        const id = `${source}-${session}-${day}-${call}`
        const model = models[(session + day + call) % models.length]!
        const name = tools[(day * 3 + session + call % 3) % tools.length]!
        const at = (ms: number) => new Date(timestamp.getTime() + ms).toISOString()
        const base = { sessionId, cwd, version: `2.1.87-desktop.sha${day < 8 ? '12345678' : day < 35 ? 'abcdef01' : 'feedbeef'}` }
        const system = (subtype: string, fields: Record<string, unknown>, ms: number) => ({ ...base, type: 'system', uuid: `${id}-${subtype}`, timestamp: at(ms), subtype, schema_version: 1, ...fields })
        rows.push({ ...base, type: 'assistant', uuid: id, timestamp: at(0), message: { id, model, usage: { input_tokens: (66 - day) * (session + 1) * 100, cache_read_input_tokens: (65 - day) * 170, cache_creation_input_tokens: model.startsWith('gpt-') ? 0 : 150 + session * 30, output_tokens: (66 - day) * 40 }, content: [{ type: 'tool_use', id, name, input: name === 'Skill' ? { skill: ['review:typescript', 'design-html', 'grilling'][session % 3] } : {} }] } })
        rows.push({ ...base, type: 'user', uuid: `${id}-result`, timestamp: at(15000), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: (session + day + call) % 7 === 0, content: 'Synthetic fixture result' }] } })
        const identity = { call_id: id, attempt_id: `${id}-attempt`, attempt_index: 1 }
        rows.push(system('model_attempt_start', { ...identity, provider: session % 2 ? 'firstParty' : 'openai', model, mode: 'streaming' }, 100))
        rows.push(system('model_attempt_first_text', { ...identity, duration_ms: 100 + session * 100 }, 300))
        rows.push(system('model_attempt_end', { ...identity, outcome: (session + day) % 11 === 0 ? 'failed' : 'succeeded', duration_ms: 500 + session * 1100 + day * 50 }, 10000))
        rows.push(system('tool_execution_start', { tool_use_id: id }, 11000))
        rows.push(system('tool_execution_end', { tool_use_id: id, outcome: (session + day + call) % 7 === 0 ? 'failed' : 'succeeded', duration_ms: 4000 }, 15000))
        rows.push(system('auto_permission_start', { attempt_id: id, tool_use_id: id, tool_kind: 'bash', auto_mode: 'auto', initial: true }, 11010))
        rows.push(system('auto_permission_end', { attempt_id: id, raw_result: 'allow', disposition: 'allowed', route: session % 2 ? 'base' : 'stage1' }, 11020))
      }
      const dir = source === 'chat' ? project : join(project, sessionId, 'subagents')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, source === 'chat' ? `${sessionId}.jsonl` : source === 'compaction' ? 'agent-acompact-0123456789abcdef.jsonl' : 'agent-a0123456789abcdef.jsonl')
      writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      files.push(file)
    }
  }
  return files
}

export function isolatedCaptureEnvironment(configHome: string, cwd: string, outDir: string, rendererUrl?: string): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: configHome, HOME: join(configHome, 'fixture-home'),
    CATCODE_TEST_CWD_ALLOWLIST: cwd, CATCODE_HEADLESS_CAPTURE: '1',
    CATCODE_CAPTURE_OUT: outDir, CATCODE_CAPTURE_SCENE: 'analytics-matrix', CATCODE_USAGE_DASHBOARD: '1',
    ...(rendererUrl ? { CATCODE_RENDERER_URL: rendererUrl } : {}),
    ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
  }
}
