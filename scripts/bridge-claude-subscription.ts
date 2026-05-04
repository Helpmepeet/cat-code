#!/usr/bin/env bun

import { readFileSync } from 'fs'
import { spawn } from 'child_process'

if (typeof MACRO === 'undefined') {
  ;(globalThis as { MACRO?: Record<string, string | undefined> }).MACRO = {
    VERSION: '2.1.87-dev',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'claude-code-source-snapshot',
    NATIVE_PACKAGE_URL: undefined,
    FEEDBACK_CHANNEL: 'github',
    ISSUES_EXPLAINER:
      'This reconstructed source snapshot does not include Anthropic internal issue routing.',
    VERSION_CHANGELOG: 'https://github.com/paoloanzn/claude-code',
  }
}

process.env.USER_TYPE ??= 'external'

type BridgeInput = {
  model?: string
  messages: { role: 'user'; content: string }[]
  maxTokens?: number
}

type BridgeSuccess = {
  ok: true
  text: string
  usage: Record<string, unknown> | null
}

type BridgeError = {
  ok: false
  code: string
  message: string
}

type BridgeOutput = BridgeSuccess | BridgeError

type CliResult = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  usage?: Record<string, unknown> | null
  errors?: string[]
}

function writeOutput(payload: BridgeOutput): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function readInput(): BridgeInput | null {
  let inputText: string
  try {
    inputText = readFileSync(0, 'utf8')
  } catch (error) {
    writeOutput({
      ok: false,
      code: 'read_stdin_failed',
      message: `Unable to read stdin: ${error instanceof Error ? error.message : 'unknown error'}`,
    })
    return null
  }

  if (!inputText.trim()) {
    writeOutput({
      ok: false,
      code: 'invalid_input',
      message: 'Expected JSON on stdin with { "model": "...", "messages": [...] }',
    })
    return null
  }

  try {
    return JSON.parse(inputText) as BridgeInput
  } catch (error) {
    writeOutput({
      ok: false,
      code: 'invalid_json',
      message: `Invalid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    })
    return null
  }
}

function buildPrompt(messages: BridgeInput['messages']): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  const contents = messages
    .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
    .map(msg => msg.content)
    .filter(Boolean)

  if (contents.length === 0) {
    return null
  }

  return contents.join('\n\n')
}

function extractErrorMessage(parsed: CliResult): string {
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return parsed.errors.join(' | ')
  }
  if (typeof parsed.result === 'string' && parsed.result.trim()) {
    return parsed.result
  }
  return 'Claude CLI returned an error'
}

async function runCli(model: string, prompt: string): Promise<BridgeOutput> {
  const cliArgs = [
    './cli',
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    prompt,
  ]

  return await new Promise<BridgeOutput>(resolve => {
    const child = spawn(cliArgs[0], cliArgs.slice(1), {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      resolve({
        ok: false,
        code: 'bridge_start_failed',
        message: error.message,
      })
    })

    child.on('close', exitCode => {
      const lines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      const lastLine = lines.at(-1)

      if (!lastLine) {
        resolve({
          ok: false,
          code: 'invalid_bridge_output',
          message: stderr.trim() || 'Claude CLI returned no JSON result',
        })
        return
      }

      let parsed: CliResult
      try {
        parsed = JSON.parse(lastLine) as CliResult
      } catch (error) {
        resolve({
          ok: false,
          code: 'invalid_bridge_output',
          message:
            stderr.trim() ||
            `Invalid JSON from Claude CLI: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
        return
      }

      if (parsed.type !== 'result') {
        resolve({
          ok: false,
          code: 'invalid_bridge_output',
          message: stderr.trim() || 'Claude CLI returned a non-result payload',
        })
        return
      }

      if (parsed.is_error || parsed.subtype !== 'success') {
        const code = parsed.subtype || (exitCode === 0 ? 'bridge_error' : `exit_${exitCode ?? 'unknown'}`)
        resolve({
          ok: false,
          code,
          message: extractErrorMessage(parsed),
        })
        return
      }

      resolve({
        ok: true,
        text: typeof parsed.result === 'string' ? parsed.result : '',
        usage: parsed.usage ?? null,
      })
    })
  })
}

async function main() {
  const payload = readInput()
  if (!payload) {
    return
  }

  const prompt = buildPrompt(payload.messages)
  if (!prompt) {
    writeOutput({
      ok: false,
      code: 'invalid_input',
      message:
        'Invalid payload: messages must be a non-empty array of { role: "user", content: "..." }',
    })
    return
  }

  const model = payload.model?.trim() || 'claude-sonnet-4-6'
  const result = await runCli(model, prompt)
  writeOutput(result)
}

void main()
