import type {
  AppClientMessage as CanonicalAppClientMessage,
  AppReadyPayload as CanonicalAppReadyPayload,
} from '../../src/app-runtime/appSessionProtocol.js'
import type { SDKMessage as CanonicalSDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import type { AppSessionEvent as CanonicalAppSessionEvent } from '../../src/app-runtime/sessionEvents.js'
import type {
  AppClientMessage as SnapshotAppClientMessage,
  AppReadyPayload as SnapshotAppReadyPayload,
  AppSessionEvent as SnapshotAppSessionEvent,
  SDKMessage as SnapshotSDKMessage,
} from '../shared/engine-types.snapshot.js'

type IsMutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false

type Assert<Condition extends true> = Condition

/**
 * Mutual assignability cannot see a DROPPED OPTIONAL property: a snapshot
 * missing `foo?: string` is still assignable both ways. `verifyCommand` went
 * missing from the snapshot's ThreadGoalCriterion and the tripwire stayed
 * green. Comparing key sets catches that.
 */
type SameKeys<Left, Right> = [keyof Left] extends [keyof Right]
  ? [keyof Right] extends [keyof Left]
    ? true
    : false
  : false

export type EngineSnapshotDriftChecks = [
  Assert<IsMutuallyAssignable<SnapshotSDKMessage, CanonicalSDKMessage>>,
  Assert<IsMutuallyAssignable<SnapshotAppSessionEvent, CanonicalAppSessionEvent>>,
  Assert<
    IsMutuallyAssignable<SnapshotAppClientMessage, CanonicalAppClientMessage>
  >,
  Assert<IsMutuallyAssignable<SnapshotAppReadyPayload, CanonicalAppReadyPayload>>,
]
