import { join } from 'node:path'

export async function requireEngineModelPin(engine: string, model: string): Promise<void> {
  // The supplied engine may predate the current catalog and exact-pin helper.
  const { mapClaudeModelToCodex } = await import(join(engine, 'src/services/api/codex-fetch-adapter.ts'))
  const effective = mapClaudeModelToCodex(model)
  if (effective !== model) {
    throw new Error(`Workspace-map evaluation requires ${model}; this engine routes it to ${effective}`)
  }
}
