/**
 * The renderer's shorthand over `shared/sessionDescriptor.fixture.ts`: an
 * ordinary live session named entirely by its id.
 *
 * The shared fixture owns the field list, so this adds only what the renderer
 * suites were each spelling out by hand — an engine session that has already
 * arrived, a cwd under `/tmp`, and the three optional peer fields written as
 * present-and-empty rather than absent (a reducer that copies a descriptor
 * carries the keys either way, but `toEqual` does not treat a missing key and a
 * null one as the same thing).
 *
 * Anything a suite cares about it passes in `overrides`, so a suite whose
 * subject IS a different status — an exited row, a titled pane — states that
 * difference at the call rather than in a private copy of the shape.
 *
 * Import this from a test file only.
 */

import type { SessionDescriptor } from '../../shared/hostApi.js'
import { sessionDescriptorFixture } from '../../shared/sessionDescriptor.fixture.js'

export function sessionDescriptor(
  id: string,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return sessionDescriptorFixture({
    appSessionId: id,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${id}`,
    name: null,
    createdBy: null,
    peerWakeBlocked: false,
    ...overrides,
  })
}
