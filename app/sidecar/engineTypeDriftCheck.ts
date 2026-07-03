import type {
  AppClientMessage as CanonicalAppClientMessage,
  AppReadyPayload as CanonicalAppReadyPayload,
} from '../../src/web/appSessionProtocol.js'
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

export type EngineSnapshotDriftChecks = [
  Assert<IsMutuallyAssignable<SnapshotSDKMessage, CanonicalSDKMessage>>,
  Assert<IsMutuallyAssignable<SnapshotAppSessionEvent, CanonicalAppSessionEvent>>,
  Assert<
    IsMutuallyAssignable<SnapshotAppClientMessage, CanonicalAppClientMessage>
  >,
  Assert<IsMutuallyAssignable<SnapshotAppReadyPayload, CanonicalAppReadyPayload>>,
]
