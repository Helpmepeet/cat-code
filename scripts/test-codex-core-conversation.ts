#!/usr/bin/env tsx

import { runCodexLLM, CodexCoreError, type CodexReasoningEffort } from '../src/codex-core/index.js'

type Args = {
  account?: string
  model?: string
  reasoningEffort?: CodexReasoningEffort
  firstPrompt?: string
  secondPrompt?: string
}

const args = parseArgs(process.argv.slice(2))

if (!args.account || !args.model) {
  printUsageAndExit()
}

try {
  const first = await runCodexLLM({
    accountProfile: args.account,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    messages: [{ role: 'user', content: args.firstPrompt ?? 'Give a short greeting.' }],
    stream: false,
  })

  console.log('TURN 1')
  console.log(first.text)
  console.log(
    JSON.stringify(
      {
        conversationId: first.conversationId,
        usage: first.usage,
        cache: first.cache,
      },
      null,
      2,
    ),
  )

  const second = await runCodexLLM({
    accountProfile: args.account,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    conversationId: first.conversationId,
    messages: [
      ...first.messagesForNextTurn,
      { role: 'user', content: args.secondPrompt ?? 'Now answer in one sentence.' },
    ],
    stream: false,
  })

  console.log('TURN 2')
  console.log(second.text)
  console.log(
    JSON.stringify(
      {
        conversationId: second.conversationId,
        usage: second.usage,
        cache: second.cache,
      },
      null,
      2,
    ),
  )
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
      case '--first-prompt':
        parsed.firstPrompt = value
        break
      case '--second-prompt':
        parsed.secondPrompt = value
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
    'Usage: pnpm tsx scripts/test-codex-core-conversation.ts --account <alias-or-id-prefix> --model <model> [--reasoning-effort medium] [--first-prompt "..."] [--second-prompt "..."]',
  )
  process.exit(1)
}
