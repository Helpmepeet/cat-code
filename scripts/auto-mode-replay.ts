#!/usr/bin/env bun
/**
 * Run the labeled auto-mode cases against the real classifier.
 *
 * MUST be run with the port gate on, or it silently exercises the legacy
 * classifier and reports a meaningless result:
 *
 *   bun --feature=AUTO_MODE_UPSTREAM_PORT scripts/auto-mode-replay.ts
 *
 * The guard below refuses to run without it, because a green report from the
 * wrong classifier is worse than no report.
 *
 * This calls `classifyYoloAction` — the same entry point the permission system
 * uses — rather than assembling a request of its own. A runner that built its
 * own prompt would prove only that the runner works.
 *
 * Costs one classifier request per case, so it needs live model quota.
 */
import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'

import {
  AUTO_MODE_EXPECTATIONS,
  type AutoModeExpectation,
  type ExpectationTurn,
} from '../fixtures/auto-mode-expectations.js'
import type { ToolPermissionContext, Tools } from '../src/Tool.js'
import { enableConfigs } from '../src/utils/config.js'
import {
  CROSS_SESSION_MESSAGE_TAG,
  TEAMMATE_MESSAGE_TAG,
} from '../src/constants/xml.js'
import { getTools } from '../src/tools.js'
import type { Message } from '../src/types/message.js'
import { normalizeAutoModeCategory } from '../src/utils/permissions/autoModeCategories.js'
import {
  recordAutoModeOutcome,
  resetRecordedAutoModeOutcomesForTest,
} from '../src/utils/permissions/autoModeMeta.js'
import {
  classifyYoloAction,
  formatActionForClassifier,
} from '../src/utils/permissions/yoloClassifier.js'

const PORT_ON = feature('AUTO_MODE_UPSTREAM_PORT') ? true : false

type Arguments = { only?: string; json: boolean; list: boolean }

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { json: false, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--list') {
      parsed.list = true
      continue
    }
    if (arg === '--only') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--only requires a case id')
      }
      parsed.only = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return parsed
}

const permissionContext: ToolPermissionContext = {
  mode: 'auto',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
} as ToolPermissionContext

/** A user turn whose text is exactly what the harness would have delivered. */
function userTurn(text: string, origin?: Message['origin']): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...(origin !== undefined && { origin }),
  } as unknown as Message
}

/**
 * Build the message history for one case, and record the outcomes it declares.
 *
 * Outcomes go through `recordAutoModeOutcome`, the same ledger the live path
 * writes to, so the correlation under test is the real one.
 */
function buildMessages(expectation: AutoModeExpectation): Message[] {
  const messages: Message[] = []
  let lastQuestionId: string | null = null

  for (const turn of expectation.transcript) {
    switch (turn.role) {
      case 'user':
        messages.push(userTurn(turn.text))
        break
      case 'task-notification':
        messages.push(
          userTurn(turn.text, {
            kind: 'task-notification',
            summary: 'replay case',
          } as Message['origin']),
        )
        break
      case 'teammate':
        messages.push(
          userTurn(
            `<${TEAMMATE_MESSAGE_TAG} teammate_id="peer">\n${turn.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
          ),
        )
        break
      case 'cross-session':
        messages.push(
          userTurn(
            `<${CROSS_SESSION_MESSAGE_TAG}>\n${turn.text}\n</${CROSS_SESSION_MESSAGE_TAG}>`,
          ),
        )
        break
      case 'question-answer': {
        if (lastQuestionId === null) {
          throw new Error(
            `${expectation.id}: a question-answer turn needs an AskUserQuestion call before it`,
          )
        }
        messages.push({
          type: 'user',
          uuid: randomUUID(),
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: lastQuestionId,
                content: `User has answered your questions: ${turn.text}`,
              },
            ],
          },
        } as unknown as Message)
        lastQuestionId = null
        break
      }
      case 'assistant': {
        const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
        if (turn.tool === 'AskUserQuestion') lastQuestionId = id
        messages.push({
          type: 'assistant',
          uuid: randomUUID(),
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id, name: turn.tool, input: turn.input },
            ],
          },
        } as unknown as Message)
        if (turn.outcome !== undefined) recordAutoModeOutcome(id, turn.outcome)
        break
      }
      default: {
        const exhaustive: never = turn
        throw new Error(`unhandled turn: ${JSON.stringify(exhaustive)}`)
      }
    }
  }
  return messages
}

type Outcome = {
  expectation: AutoModeExpectation
  verdictMatched: boolean
  categoryMatched: boolean | null
  actualBlock: boolean
  actualCategory: string | undefined
  reason: string
  unavailable: boolean
  error?: string
}

async function runOne(
  expectation: AutoModeExpectation,
  tools: Tools,
): Promise<Outcome> {
  resetRecordedAutoModeOutcomesForTest()
  const messages = buildMessages(expectation)
  const action = formatActionForClassifier(
    expectation.action.tool,
    expectation.action.input,
  )

  try {
    const result = await classifyYoloAction(
      messages,
      action,
      tools,
      permissionContext,
      AbortSignal.timeout(120_000),
    )
    const expectBlock = expectation.expect === 'block'
    const actualCategory = result.category?.id
    // The fixture writes categories in upstream's display form; ours are
    // snake_case ids derived from the same rule names. Normalise both with the
    // engine's own function rather than comparing raw strings.
    const categoryMatched =
      expectation.category === undefined
        ? null
        : actualCategory === normalizeAutoModeCategory(expectation.category)
    return {
      expectation,
      verdictMatched: result.shouldBlock === expectBlock,
      categoryMatched,
      actualBlock: result.shouldBlock,
      actualCategory,
      reason: result.reason,
      unavailable: result.unavailable === true,
    }
  } catch (error) {
    return {
      expectation,
      verdictMatched: false,
      categoryMatched: null,
      actualBlock: false,
      actualCategory: undefined,
      reason: '',
      unavailable: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const args = parseArguments(process.argv.slice(2))

const selected = args.only
  ? AUTO_MODE_EXPECTATIONS.filter(c => c.id === args.only)
  : AUTO_MODE_EXPECTATIONS
if (selected.length === 0) throw new Error(`no case matches --only ${args.only}`)

if (args.list) {
  for (const c of selected) {
    console.log(
      `${c.expect === 'block' ? 'BLOCK' : 'ALLOW'}  ${c.id}${c.knownGap ? '  [known gap]' : ''}`,
    )
  }
  process.exit(0)
}

if (!PORT_ON) {
  console.error(
    'Refusing to run: the upstream port is off, so this would grade the legacy\n' +
      'classifier and report a number that means nothing. Re-run with:\n\n' +
      '  bun --feature=AUTO_MODE_UPSTREAM_PORT scripts/auto-mode-replay.ts\n',
  )
  process.exit(2)
}

// The engine refuses config reads until the entrypoint opts in. The classifier
// reads settings (auto-mode config, model choice), so this has to happen before
// the first case runs.
enableConfigs()

const tools = getTools(permissionContext)
const results: Outcome[] = []

for (const expectation of selected) {
  const outcome = await runOne(expectation, tools)
  results.push(outcome)
  const gap = expectation.knownGap !== undefined
  // Unreachable is never a pass. A fail-closed block "matches" every
  // block-expecting case without judging anything, so the verdict alone cannot
  // be trusted unless the classifier actually answered.
  const ok = outcome.verdictMatched && !outcome.unavailable && !outcome.error
  const mark = outcome.error
    ? 'ERROR'
    : ok
      ? 'pass '
      : gap
        ? 'gap  '
        : 'FAIL '
  const got = outcome.error
    ? outcome.error
    : `${outcome.actualBlock ? 'block' : 'allow'}${outcome.actualCategory ? ` (${outcome.actualCategory})` : ''}${outcome.unavailable ? ' [classifier unavailable]' : ''}`
  console.log(`${mark} ${expectation.id.padEnd(32)} want ${expectation.expect.padEnd(5)} got ${got}`)
}

// Known gaps are reported apart from real failures: they measure a limit we
// already chose, and folding them into the failure count would either hide a
// regression or manufacture one.
const real = results.filter(r => r.expectation.knownGap === undefined)
const gaps = results.filter(r => r.expectation.knownGap !== undefined)
// Only the verdict decides pass/fail. `category` is advisory — it groups
// denials for analysis and never affects `shouldBlock` — so grading it as a
// failure would fail a case over something that gates nothing. Mismatches are
// still reported, because a consistently odd category is worth seeing.
const reached = (r: Outcome) => !r.unavailable && r.error === undefined
const passed = real.filter(r => r.verdictMatched && reached(r))
const failed = real.filter(r => !(r.verdictMatched && reached(r)))
const categoryDrift = real.filter(
  r => r.verdictMatched && reached(r) && r.categoryMatched === false,
)
const unavailable = results.filter(r => r.unavailable || r.error)

if (args.json) {
  console.log(
    JSON.stringify(
      {
        passed: passed.length,
        failed: failed.length,
        knownGaps: gaps.length,
        cases: results.map(r => ({
          id: r.expectation.id,
          want: r.expectation.expect,
          wantCategory: r.expectation.category,
          gotBlock: r.actualBlock,
          gotCategory: r.actualCategory,
          verdictMatched: r.verdictMatched,
          categoryMatched: r.categoryMatched,
          knownGap: r.expectation.knownGap,
          reason: r.reason,
          error: r.error,
        })),
      },
      null,
      2,
    ),
  )
}

console.log(
  `\n${passed.length}/${real.length} passed · ${gaps.length} known gap${gaps.length === 1 ? '' : 's'}` +
    (unavailable.length > 0
      ? ` · ${unavailable.length} could not reach the classifier`
      : ''),
)

if (categoryDrift.length > 0) {
  console.log('\nRight verdict, unexpected category (advisory, not a failure):')
  for (const r of categoryDrift) {
    console.log(
      `  ${r.expectation.id}: wanted ${r.expectation.category}, got ${r.actualCategory ?? 'none'}`,
    )
  }
}

if (failed.length > 0) {
  console.log('\nFailures:')
  for (const r of failed) {
    console.log(`  ${r.expectation.id}: ${r.expectation.because}`)
    if (r.reason) console.log(`    classifier said: ${r.reason}`)
  }
}

// A case that could not reach the classifier is not a pass and not a failure of
// judgement; exit non-zero so a quota outage never reads as a green run.
process.exit(failed.length > 0 || unavailable.length > 0 ? 1 : 0)
