/**
 * Renders the projector's view models (transcriptProjector.ts — §5 layer 2).
 * P1-3: structure over polish — a markdown text row and a bare tool card
 * styled with the P0-2 tokens only.
 */

import Markdown from 'react-markdown'
import type { TranscriptRow } from './transcriptProjector.js'

export function TranscriptView({ rows }: { rows: TranscriptRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-text-subtle">No transcript rows yet.</div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map(row => {
        if (row.kind === 'assistant-text') {
          return (
          <div
            key={row.id}
            className="font-sans text-sm leading-relaxed [&>*+*]:mt-2 [&_code]:font-mono [&_a]:text-accent [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
          >
            <Markdown>{row.content}</Markdown>
          </div>
          )
        }
        if (row.kind === 'tool-use') {
          return (
          <div
            key={row.id}
            className="rounded border border-accent/40 bg-app-bg p-3"
          >
            <div className="font-mono text-xs text-accent">{row.toolName}</div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-muted">
              {JSON.stringify(row.input, null, 2)}
            </pre>
          </div>
          )
        }
        // P2-1 adds projector view models only. Their dedicated presentation
        // components stay outside this layer-2 slice.
        return null
      })}
    </div>
  )
}
