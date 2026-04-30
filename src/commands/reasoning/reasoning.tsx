import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']
const VALID_MODES = ['off', 'summary', 'raw'] as const
type Mode = (typeof VALID_MODES)[number]

function isMode(v: string): v is Mode {
  return (VALID_MODES as readonly string[]).includes(v)
}

function getCurrentMode(): Mode {
  try {
    const s = getInitialSettings() as { reasoningDisplay?: string }
    if (s?.reasoningDisplay && isMode(s.reasoningDisplay)) return s.reasoningDisplay
  } catch {
    // fall through
  }
  return 'summary'
}

function describeMode(mode: Mode): string {
  switch (mode) {
    case 'off':
      return 'reasoning is hidden'
    case 'summary':
      return "show the model's reasoning summary inline (default)"
    case 'raw':
      return 'show raw provider trace when the server emits it; otherwise show summary'
  }
}

function setMode(mode: Mode): { message: string } {
  const result = updateSettingsForSource('userSettings', {
    reasoningDisplay: mode,
  })
  if (result.error) {
    return { message: `Failed to set reasoning display: ${result.error.message}` }
  }
  return { message: `Reasoning display set to ${mode}: ${describeMode(mode)}` }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const arg = (args ?? '').trim().toLowerCase()

  if (COMMON_HELP_ARGS.includes(arg)) {
    onDone(
      'Usage: /reasoning [off|summary|raw]\n\n' +
        'Controls how reasoning from Codex/GPT models is displayed:\n' +
        '- off:     Hide reasoning entirely\n' +
        '- summary: Show provider-managed reasoning summary inline (default)\n' +
        '- raw:     Show raw provider trace when the server sends it; falls back to summary\n\n' +
        'Note: raw provider trace is only available when the model and account are\n' +
        'entitled to receive it. When unavailable, summary is shown instead.',
    )
    return null
  }

  if (!arg || arg === 'current' || arg === 'status') {
    const mode = getCurrentMode()
    onDone(`Reasoning display: ${mode} (${describeMode(mode)})`)
    return null
  }

  if (!isMode(arg)) {
    onDone(
      `Invalid argument: ${args}. Valid options are: off, summary, raw`,
    )
    return null
  }

  const { message } = setMode(arg)
  onDone(message)
  return null
}
