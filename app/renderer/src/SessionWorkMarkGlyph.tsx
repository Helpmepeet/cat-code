import type { SessionWorkMark } from './sessionWorkState.js'

/** A session's work mark, shared by its sidebar row and its tab: a turn
 * running, a request waiting on the user, a failed last turn, or a reply not
 * yet seen. Colour follows urgency (accent for the user's move, danger for a
 * failure, good for a finished reply, neutral for work in progress);
 * connection state has no mark at all. */
export function WorkMarkGlyph({ mark }: { mark: SessionWorkMark }) {
  switch (mark) {
    case 'working':
      return (
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className="text-text-subtle motion-safe:animate-spin"
        >
          <circle
            cx="4"
            cy="4"
            r="3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="11 19"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'needs-you':
      return (
        <span className="text-[11px] font-bold leading-[17px] text-accent">?</span>
      )
    case 'failed':
      return <span className="h-1.5 w-1.5 rounded-full bg-tone-danger" />
    case 'unseen':
      return (
        <span className="h-1.5 w-1.5 rounded-full bg-tone-good ring-[2.5px] ring-tone-good/[0.18]" />
      )
  }
}
