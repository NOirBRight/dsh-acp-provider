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

/** One selectable model inside a route. */
export interface BridgeModel {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One directory entry contributed with an explicit kind. */
export interface BridgeRoute {
  readonly id: string
  readonly displayName: string
  readonly kind: BridgeRouteKind
  readonly models: readonly BridgeModel[]
}

/** One external turn request. */
export interface BridgeTurnRequest {
  readonly sessionId: string
  readonly routeId: string
  readonly model: string
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

/** Agentless approval question forwarded to the host. */
export interface BridgeApprovalRequest {
  readonly sessionId: string
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Closed approval outcome vocabulary. */
export type BridgeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One human question forwarded to the host. */
export interface BridgeQuestion {
  readonly id: string
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
    read(sessionId: string): readonly BridgeSessionEvent[]
  }
  readonly interaction: {
    requestApproval(request: BridgeApprovalRequest): Promise<BridgeApprovalOutcome>
    askUser(question: BridgeQuestion, options?: { signal?: AbortSignal }): Promise<string>
  }
}
