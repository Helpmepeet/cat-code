import { MarkdownPre, MarkdownCode, MarkdownCallout, MarkdownTable, MarkdownTableHeader, MarkdownTableCell } from './MarkdownElements.js'

/** Shared presentation; callers keep their own navigation and command handling. */
export const MARKDOWN_COMPONENTS = {
  pre: MarkdownPre,
  code: MarkdownCode,
  aside: MarkdownCallout,
  table: MarkdownTable,
  th: MarkdownTableHeader,
  td: MarkdownTableCell,
}
