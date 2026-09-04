/**
 * Smallest host surface the bridge needs. Every member maps to one
 * capability in the task brief; anything current DSH cannot provide is
 * named in the package README with its exact upstream hook.
 *
 * @module dsh-bridge/contracts
 */

/**
 * Route discriminant. Current DSH has no equivalent: LlmProviderInfo in
 * packages/llm/llm/src/types.ts carries only id plus name, and the
 * configurable-provider directory carries no kind.
 */
export type BridgeRouteKind = 'llm' | 'external-agent'

declare const bridgeIdBrand: unique symbol
type BridgeId<Kind extends string> = string & { readonly [bridgeIdBrand]: Kind }
/** Configured route identifier. */
export type BridgeRouteId = BridgeId<'route'>
/** Configured model identifier. */
export type BridgeModelId = BridgeId<'model'>
/** DSH session identifier crossing the bridge. */
export type BridgeSessionId = BridgeId<'session'>
/** Human-question identifier crossing the bridge. */
export type BridgeQuestionId = BridgeId<'question'>
/** Native approval option identifier. */
export type BridgeApprovalOptionId = BridgeId<'approval-option'>
/** Brand a validated route identifier. */
export function bridgeRouteId(value: string): BridgeRouteId { return value as BridgeRouteId }
/** Brand a validated model identifier. */
export function bridgeModelId(value: string): BridgeModelId { return value as BridgeModelId }
/** Brand one native approval option id at the host boundary. */
export function bridgeApprovalOptionId(value: string): BridgeApprovalOptionId { return value as BridgeApprovalOptionId }

/** One selectable model inside a route. */
export interface BridgeModel {
  readonly id: BridgeModelId
  readonly name: string
  readonly description?: string
}

/** One directory entry contributed with an explicit kind. */
export interface BridgeRoute {
  readonly id: BridgeRouteId
  readonly displayName: string
  readonly kind: BridgeRouteKind
  readonly models: readonly BridgeModel[]
}

/** One external turn request. */
export interface BridgeTurnRequest {
  readonly sessionId: BridgeSessionId
  readonly routeId: BridgeRouteId
  readonly model: BridgeModelId
  readonly prompt: string
  readonly signal?: AbortSignal
}

/** Terminal outcome vocabulary; mirrors the harness turn-end wording. */
export type BridgeStopReason = 'completed' | 'aborted' | 'error'

/** Terminal outcome of one driven external turn. */
export interface BridgeTurnResult {
  readonly stopReason: BridgeStopReason
  readonly outputText: string
  readonly diagnostic?: string
}

/**
 * Dispatch outcome. Handled false leaves model-kind and unknown routes
 * to the host loop; only external-agent routes are driven here.
 */
export type BridgeDriveOutcome =
  | { readonly handled: false }
  | { readonly handled: true, readonly result: BridgeTurnResult }

/** Primary turn driver: drives external turns without an LlmAdapter. */
export interface BridgePrimaryDriver {
  drive(request: BridgeTurnRequest): Promise<BridgeDriveOutcome>
}

/**
 * Deployment-injected product runner. The bridge never spawns a process
 * itself; the deployment owns credentials, executables, and transport.
 */
export interface BridgeRunner {
  run(request: BridgeTurnRequest): Promise<BridgeTurnResult>
}

/** Minimal durable session event the bridge folds or follows. */
export interface BridgeSessionEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/** Native approval option displayed without changing its provider-owned id. */
export type BridgeApprovalOption =
  | { readonly id: BridgeApprovalOptionId; readonly kind: 'allow-always'; readonly label: string; readonly scope: 'session' | 'thread' }
  | { readonly id: BridgeApprovalOptionId; readonly kind: 'allow-once' | 'reject' | 'cancel'; readonly label: string; readonly scope?: never }

/** Security warning attached to one native approval. */
export interface BridgeApprovalSecurityWarning { readonly message: string; readonly severity: 'warning' | 'danger' }

/** Agentless approval question forwarded to the host. */
export interface BridgeApprovalRequest {
  readonly sessionId: BridgeSessionId
  readonly toolName: string
  readonly reason?: string
  readonly options: readonly BridgeApprovalOption[]
  readonly securityWarning?: BridgeApprovalSecurityWarning
  readonly signal?: AbortSignal
}

/** Closed approval outcome preserving the selected native option id and scope. */
export type BridgeApprovalOutcome =
  | { readonly kind: 'allowed-once'; readonly optionId: BridgeApprovalOptionId }
  | { readonly kind: 'allowed-for-session'; readonly optionId: BridgeApprovalOptionId; readonly scope: 'session' | 'thread' }
  | { readonly kind: 'rejected'; readonly optionId: BridgeApprovalOptionId }
  | { readonly kind: 'cancelled' | 'unavailable' }

/** One human question forwarded to the host. */
export interface BridgeQuestion {
  readonly id: BridgeQuestionId
  readonly question: string
}

/**
 * Smallest host surface the bridge mounts against. A fake implements
 * this in tests; current DSH does not (see probeBridgeHost and README).
 */
export interface BridgeHost {
  readonly directory: {
    register(route: BridgeRoute): () => void
    list(): BridgeRoute[]
  }
  readonly drivers: {
    setPrimary(driver: BridgePrimaryDriver): () => void
  }
  readonly sessions: {
    read(sessionId: BridgeSessionId): readonly BridgeSessionEvent[]
  }
  readonly interaction: {
    requestApproval(request: BridgeApprovalRequest): Promise<BridgeApprovalOutcome>
    askUser(question: BridgeQuestion, options?: { signal?: AbortSignal }): Promise<string>
  }
}
