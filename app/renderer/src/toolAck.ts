/**
 * Some tools return no output, only an authored sentence: their result is
 * `{ success: boolean, message: string }` serialized by the tool's own
 * `mapToolResultToToolResultBlockParam` (`src/tools/ResumeAgentTool/
 * ResumeAgentTool.tsx:93-99`). The transcript used to render those as an escaped
 * JSON blob behind a click, so the one field carrying the whole meaning was the
 * one field you had to expand and then mentally unquote.
 *
 * Detection is keyed on the SHAPE, not the tool name, so a future tool with the
 * same result contract inherits the rendering. Two tools match today:
 * `ResumeAgent` exactly, and `SendMessage` whose `MessageOutput` adds an
 * optional `routing` (`src/tools/SendMessageTool/SendMessageTool.ts:122-126`).
 * `Skill`/`Config`/`TaskUpdate` carry a `success` boolean but NO `message`, so
 * they do not match and keep their existing rendering.
 *
 * `ok` is carried separately from the row's own status on purpose: a tool call
 * can succeed (status `'success'`) while the operation it performed did not
 * (`success: false` for an unknown agent, `ResumeAgentTool.tsx:123-129`). The
 * card reports both and must not collapse one into the other.
 */
export type ToolAck = {
  /** The ack's OWN outcome. Never the row's tool-call status. */
  ok: boolean
  message: string
  /**
   * True when `success` and `message` are the object's ONLY fields, so showing
   * the message shows the whole result.
   *
   * This is what separates the two renderings. The collapsed peek is additive
   * (it hides nothing, the body still expands in full), so it runs for every
   * ack. Replacing the BODY discards whatever else the object carried, so it
   * runs only when there is nothing else to discard.
   */
  exact: boolean
}

/**
 * Runtime-narrows a tool result's flattened text to `ToolAck`, or null when it
 * is anything else. Fail-soft by contract: every non-matching input
 * (unparseable text, an array, a partial object, a non-string message, an empty
 * message) returns null and leaves the caller on its existing rendering path.
 * Zero casts.
 */
export function parseToolAck(content: string): ToolAck | null {
  if (content.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  // `in` narrows the fields to `unknown` without a cast; the typeof guards below
  // do the actual narrowing.
  if (!('success' in parsed) || !('message' in parsed)) return null
  const { success, message } = parsed
  if (typeof success !== 'boolean') return null
  if (typeof message !== 'string' || message.length === 0) return null
  return { ok: success, message, exact: Object.keys(parsed).length === 2 }
}
