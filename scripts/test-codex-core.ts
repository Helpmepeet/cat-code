#!/usr/bin/env bun

import { runCodexLLM, CodexCoreError, type CodexReasoningEffort } from '../src/codex-core/index.js'

type Args = {
  account?: string
  model?: string
  reasoningEffort?: CodexReasoningEffort
  prompt?: string
  systemPrompt?: string
}

const args = parseArgs(process.argv.slice(2))

if (!args.account || !args.model || !args.prompt) {
  printUsageAndExit()
}

try {
  const result = await runCodexLLM({
    accountProfile: args.account,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    input: args.prompt,
    systemPrompt: args.systemPrompt,
    stream: false,
  })

  console.log(result.text)
  console.log(JSON.stringify({ usage: result.usage, metadata: result.metadata }, null, 2))
} catch (error) {
  if (error instanceof CodexCoreError) {
    console.error(`[${error.code}] ${error.message}`)
    if (error.status) {
      console.error(`status=${error.status}`)
    }
    process.exit(1)
  }
  throw error
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (!arg?.startsWith('--')) continue
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`)
    }
    i++
    switch (arg) {
      case '--account':
        parsed.account = value
        break
      case '--model':
        parsed.model = value
        break
      case '--reasoning-effort':
        parsed.reasoningEffort = parseReasoningEffort(value)
        break
      case '--prompt':
        parsed.prompt = value
        break
      case '--system-prompt':
        parsed.systemPrompt = value
        break
      default:
        throw new Error(`Unknown argument ${arg}`)
    }
  }
  return parsed
}

function parseReasoningEffort(value: string): CodexReasoningEffort {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
  ) {
    return value
  }
  throw new Error(`Invalid --reasoning-effort ${value}`)
}

function printUsageAndExit(): never {
  console.error(
    'Usage: bun run scripts/test-codex-core.ts --account <alias-or-id-prefix> --model <model> [--reasoning-effort medium] [--system-prompt "..."] --prompt "hello"',
  )
  process.exit(1)
}
