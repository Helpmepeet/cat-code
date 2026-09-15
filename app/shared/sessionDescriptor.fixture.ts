/**
 * The one hand-built `SessionDescriptor` (`hostApi.ts`) for tests — the single
 * copy of its twelve required fields, so a call site writes only what its
 * assertion is about. `hostApi.ts` records the cost this pays down: `name` /
 * `createdBy` / `peerWakeBlocked` are optional because a required field meant
 * editing every file that spelled the list out.
 *
 * Overrides land by spread, so an explicit `null` (an `engineSessionId` that has
 * not arrived yet — the two-id bridge) survives where a `??` default would
 * mangle it.
 */

import type { SessionDescriptor } from './hostApi.js'

export function sessionDescriptorFixture(
  over: Partial<SessionDescriptor> & { appSessionId: string; cwd: string },
): SessionDescriptor {
  // The two required fields are lifted out of the spread so the built object's
  // key order matches the type's declaration order instead of trailing them.
  const { appSessionId, cwd, ...rest } = over
  return {
    appSessionId,
    engineSessionId: null,
    cwd,
    title: null,
    forked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...rest,
  }
}
