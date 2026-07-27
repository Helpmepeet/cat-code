import type {
  AgentStateTone,
  AgentTypeTone,
} from './agentIdentity.js'

export const AGENT_STATE_TONE_CLASS: Record<
  AgentStateTone,
  { text: string; dot: string; border: string; soft: string; line: string }
> = {
  info: { text: 'text-blue-400', dot: 'bg-blue-400', border: 'border-blue-400', soft: 'bg-blue-400/10', line: 'border-blue-400/30' },
  success: { text: 'text-tone-good', dot: 'bg-tone-good', border: 'border-tone-good', soft: 'bg-tone-good/10', line: 'border-tone-good/30' },
  danger: { text: 'text-tone-danger', dot: 'bg-tone-danger', border: 'border-tone-danger', soft: 'bg-tone-danger/10', line: 'border-tone-danger/30' },
  warning: { text: 'text-tone-warn', dot: 'bg-tone-warn', border: 'border-tone-warn', soft: 'bg-tone-warn/10', line: 'border-tone-warn/30' },
  neutral: { text: 'text-stone-400', dot: 'bg-stone-400', border: 'border-stone-400', soft: 'bg-stone-400/10', line: 'border-stone-400/30' },
  muted: { text: 'text-zinc-500', dot: 'bg-zinc-500', border: 'border-zinc-500', soft: 'bg-zinc-500/10', line: 'border-zinc-500/30' },
  purple: { text: 'text-purple-400', dot: 'bg-purple-400', border: 'border-purple-400', soft: 'bg-purple-400/10', line: 'border-purple-400/30' },
}

export const AGENT_TYPE_TONE_CLASS: Record<
  AgentTypeTone,
  { text: string; soft: string; line: string; dot: string }
> = {
  teal: { text: 'text-teal-300', soft: 'bg-teal-300/10', line: 'border-teal-300/30', dot: 'bg-teal-300' },
  blue: { text: 'text-blue-300', soft: 'bg-blue-300/10', line: 'border-blue-300/30', dot: 'bg-blue-300' },
  purple: { text: 'text-violet-300', soft: 'bg-violet-300/10', line: 'border-violet-300/30', dot: 'bg-violet-300' },
  sky: { text: 'text-sky-300', soft: 'bg-sky-300/10', line: 'border-sky-300/30', dot: 'bg-sky-300' },
  neutral: { text: 'text-zinc-400', soft: 'bg-zinc-400/10', line: 'border-zinc-400/30', dot: 'bg-zinc-400' },
}
