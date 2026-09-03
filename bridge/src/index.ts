/**
 * dsh-bridge: optional out-of-tree DSH integration bridge for External
 * Agent routes. Executable against any BridgeHost; blocked against
 * current DSH (see README and probeBridgeHost).
 *
 * @module dsh-bridge
 */

export type {
  BridgeApprovalOutcome,
  BridgeApprovalRequest,
  BridgeDriveOutcome,
  BridgeHost,
  BridgeModel,
  BridgePrimaryDriver,
  BridgeQuestion,
  BridgeRoute,
  BridgeRouteKind,
  BridgeRunner,
  BridgeSessionEvent,
  BridgeStopReason,
  BridgeTurnRequest,
  BridgeTurnResult,
} from './contracts.ts';
export { createBridge } from './bridge.ts';
export type { Bridge, BridgeConfig } from './bridge.ts';
export { missingPaths, probeBridgeHost, REQUIRED_HOST_PATHS } from './current-dsh.ts';
export type { BridgeHostProbe } from './current-dsh.ts';
export { apply, inject, name } from './plugin.ts';
export type { Config } from './plugin.ts';
