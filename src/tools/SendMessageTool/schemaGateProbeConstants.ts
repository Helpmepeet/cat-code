/** Shared between SendMessageTool.schemaGate.probe.test.ts (parent) and
 * SendMessageTool.schemaGate.probe.child.ts (child process), kept in its own
 * file so the parent never has to statically import the child module (which
 * would register the child's `test()` a second time, in the parent's own
 * process, with the parent's own untouched env). */
export const SCHEMA_MESSAGE_JSON_PREFIX = 'SCHEMA_MESSAGE_JSON:'
