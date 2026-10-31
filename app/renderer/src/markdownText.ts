import { isValidElement, type ReactNode } from 'react'

/** Flatten react-markdown code children (a string, a node array, or the
 * highlight.js <span> element tree `rehype-highlight` wraps tokens in) to raw
 * text — the copy button needs the un-tokenized source. */
export function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (isValidElement(children)) {
    const props: unknown = children.props
    if (props !== null && typeof props === 'object' && 'children' in props) {
      return childrenToText((props as { children?: ReactNode }).children)
    }
  }
  return ''
}
