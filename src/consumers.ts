/**
 * DSH-side primary-session and subagent consumers for the provider seam.
 * Providers remain unaware of route selection, visible event ordering and Jobs.
 */
import {
  RouteResolutionError,
  type ExternalAgentEvent,
  type ExternalAgentJobId,
  type ExternalAgentOpenRequest,
  type ExternalAgentOptionId,
  type ExternalAgentPermissionDecision,
  type ExternalAgentPermissionRequest,
  type ExternalAgentProviderRegistry,
  type ExternalAgentResumeCursor,
  type ExternalAgentSession,
  type ExternalAgentSessionId,
  type ExternalAgentTurnHostCallbacks,
  type ExternalAgentTurnId,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
  type ExternalAgentUserInputRequest,
  type SessionModelRoute,
  turnId,
} from './index.js'

/** One durable event emitted by a consumer for DSH Session projection. */
export type ExternalAgentConsumerEvent =
  | { readonly type: 'route-selected'; readonly route: SessionModelRoute }
  | { readonly type: 'turn-started'; readonly turn: ExternalAgentTurnId; readonly route: SessionModelRoute }
  | { readonly type: 'activity'; readonly event: ExternalAgentEvent }
  | { readonly type: 'permission-pending'; readonly request: ExternalAgentPermissionRequest }
  | { readonly type: 'permission-committed'; readonly requestId: ExternalAgentOptionId; readonly outcome: ExternalAgentPermissionDecision['kind'] }
  | { readonly type: 'question-pending'; readonly request: ExternalAgentUserInputRequest }
  | { readonly type: 'question-committed'; readonly requestId: ExternalAgentOptionId; readonly answers: readonly string[] }
  | { readonly type: 'turn-finished'; readonly turn: ExternalAgentTurnId; readonly result: ExternalAgentTurnResult }
  | { readonly type: 'subagent-result'; readonly jobId: ExternalAgentJobId; readonly result: ExternalAgentTurnResult }

/** Callbacks used by both consumer roles. */
export interface ExternalAgentConsumerCallbacks {
  readonly host: ExternalAgentTurnHostCallbacks
  readonly onSessionEvent?: (event: ExternalAgentConsumerEvent) => void | Promise<void>
}
/** Turn fields shared by primary-session and subagent consumers. */
export interface ExternalAgentConsumerTurnInput extends ExternalAgentConsumerCallbacks {
  readonly prompt: string
  readonly attachments?: ExternalAgentTurnRequest['attachments']
  readonly permissionMode: ExternalAgentTurnRequest['permissionMode']
  readonly fullAccessConfirmed?: boolean
  readonly fullAccessAuditId?: string
  readonly clientFilesystem?: ExternalAgentOpenRequest['clientFilesystem']
}

/** Primary-session turn request. */
export interface ExternalAgentPrimaryTurnRequest extends ExternalAgentConsumerTurnInput {
  readonly session: ExternalAgentSessionId
  readonly route: SessionModelRoute
  readonly turn?: ExternalAgentTurnId
  readonly signal: AbortSignal
}
interface PrimarySlot {
  readonly key: string
  readonly route: Extract<SessionModelRoute, { kind: 'external-agent' }>
  session?: ExternalAgentSession
  cursor?: ExternalAgentResumeCursor
}

function createConsumerTurnHost(host: ExternalAgentTurnHostCallbacks, emit: (event: ExternalAgentConsumerEvent) => void | Promise<void>): ExternalAgentTurnHostCallbacks {
  return {
    publish: async event => {
      await emit({ type: 'activity', event })
      await host.publish(event)
    },
    requestPermission: async request => {
      await emit({ type: 'permission-pending', request })
      try {
        const decision = await host.requestPermission(request)
        await emit({ type: 'permission-committed', requestId: request.requestId, outcome: decision.kind })
        return decision
      } catch (error) {
        await emit({ type: 'permission-committed', requestId: request.requestId, outcome: 'unavailable' })
        throw error
      }
    },
    requestUserInput: async request => {
      await emit({ type: 'question-pending', request })
      try {
        const answer = await host.requestUserInput(request)
        await emit({ type: 'question-committed', requestId: request.requestId, answers: answer.answers })
        return answer
      } catch (error) {
        await emit({ type: 'question-committed', requestId: request.requestId, answers: [] })
        throw error
      }
    },
  }
}

function openRequestExtras(request: Pick<ExternalAgentOpenRequest, 'clientFilesystem' | 'fullAccessConfirmed' | 'fullAccessAuditId'>): Pick<ExternalAgentOpenRequest, 'clientFilesystem' | 'workspaceRoot' | 'attachmentRoots' | 'fullAccessConfirmed' | 'fullAccessAuditId'> {
  return {
    ...(request.clientFilesystem === undefined ? {} : { clientFilesystem: request.clientFilesystem, ...(request.clientFilesystem.workspaceRoots[0] === undefined ? {} : { workspaceRoot: request.clientFilesystem.workspaceRoots[0] }), attachmentRoots: request.clientFilesystem.attachmentRoots }),
    ...(request.fullAccessConfirmed === undefined ? {} : { fullAccessConfirmed: request.fullAccessConfirmed }),
    ...(request.fullAccessAuditId === undefined ? {} : { fullAccessAuditId: request.fullAccessAuditId }),
  }
}

/**
 * Primary consumer that closes provider sessions on route changes and keeps
 * provider-scoped resume cursors isolated by route.
 */
export class ExternalAgentPrimaryConsumer {
  private readonly slots = new Map<string, PrimarySlot>()
  private active: { readonly controller: AbortController; readonly promise: Promise<ExternalAgentTurnResult> } | undefined
  private preparation: { readonly controller: AbortController; readonly promise: Promise<ExternalAgentTurnResult> } | undefined
  private selected: SessionModelRoute | undefined
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(private readonly registry: ExternalAgentProviderRegistry) {}

  /** Select a route; switching cancels and settles the active turn first. */
  async selectRoute(route: SessionModelRoute): Promise<void> {
    this.assertLive()
    if (this.preparation !== undefined) throw new Error('primary external-agent turn is already preparing')
    await this.switchRoute(route)
  }

  private async switchRoute(route: SessionModelRoute): Promise<void> {
    if (this.sameRoute(this.selected, route)) return
    const previous = this.selected
    await this.cancelActive()
    if (previous?.kind === 'external-agent') {
      const previousSlot = this.slots.get(this.routeKey(previous))
      if (previousSlot?.session !== undefined) {
        previousSlot.cursor ??= previousSlot.session.ref.resumeCursor
        await previousSlot.session.dispose()
        previousSlot.session = undefined
      }
    }
    this.selected = route
  }

  /** Run one explicit external-agent turn through the selected provider. */
  runTurn(request: ExternalAgentPrimaryTurnRequest): Promise<ExternalAgentTurnResult> {
    this.assertLive()
    if (request.route.kind !== 'external-agent') return Promise.reject(new RouteResolutionError('primary consumer requires an external-agent route'))
    if (request.signal.aborted) return Promise.resolve({ status: 'cancelled', text: '' })
    if (this.preparation !== undefined) return Promise.reject(new Error('primary external-agent turn is already preparing'))
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    request.signal.addEventListener('abort', forwardAbort, { once: true })
    const promise = this.runTurnInternal(request, controller).finally(() => {
      request.signal.removeEventListener('abort', forwardAbort)
      if (this.preparation?.promise === promise) this.preparation = undefined
    })
    this.preparation = { controller, promise }
    return promise
  }

  private async runTurnInternal(request: ExternalAgentPrimaryTurnRequest, controller: AbortController): Promise<ExternalAgentTurnResult> {
    if (this.active !== undefined) {
      if (this.sameRoute(this.selected, request.route)) throw new Error('primary external-agent turn is already active')
      await this.cancelActive()
    }
    await this.switchRoute(request.route)
    await request.onSessionEvent?.({ type: 'route-selected', route: request.route })
    this.assertLive()
    const effectiveTurn = turnId(request.turn ?? crypto.randomUUID())
    const emit = (event: ExternalAgentConsumerEvent): void | Promise<void> => request.onSessionEvent?.(event)
    await emit({ type: 'turn-started', turn: effectiveTurn, route: request.route })
    let slot: PrimarySlot
    try { slot = await this.getSlot(request, controller.signal) } catch (error) {
      const result: ExternalAgentTurnResult = controller.signal.aborted ? { status: 'cancelled', text: '' } : { status: 'failed', text: '', error: 'external-agent turn failed' }
      await emit({ type: 'turn-finished', turn: effectiveTurn, result })
      if (controller.signal.aborted) return result
      throw error
    }
    const effectiveRequest: ExternalAgentTurnRequest = {
      turn: effectiveTurn,
      prompt: request.prompt,
      ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      permissionMode: request.permissionMode,
      signal: controller.signal,
    }
    const callbacks = createConsumerTurnHost(request.host, emit)
    const session = slot.session
    const promise = session === undefined
      ? Promise.reject(new Error('primary external-agent session was disposed before turn start'))
      : Promise.resolve().then(() => session.runTurn(effectiveRequest, callbacks))
    this.active = { controller, promise }
    try {
      const result = await promise
      if (result.resumeCursor !== undefined) slot.cursor = result.resumeCursor
      await emit({ type: 'turn-finished', turn: effectiveRequest.turn, result })
      return result
    } catch (error) {
      await emit({ type: 'turn-finished', turn: effectiveRequest.turn, result: { status: 'failed', text: '', error: 'external-agent turn failed' } })
      throw error
    } finally {
      if (this.active?.promise === promise) this.active = undefined
    }
  }

  /** Cancel one active turn and wait for provider quiescence. */
  async cancelActive(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    active.controller.abort()
    await active.promise.catch(() => undefined)
    if (this.active?.promise === active.promise) this.active = undefined
  }

  /** Dispose all route cursors and active provider sessions. */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async () => {
      const preparation = this.preparation
      preparation?.controller.abort()
      await preparation?.promise.catch(() => undefined)
      await this.cancelActive()
      await Promise.all([...this.slots.values()].map(slot => slot.session?.dispose().catch(() => undefined)))
      this.slots.clear()
    })()
    return this.disposePromise
  }

  private async getSlot(request: ExternalAgentPrimaryTurnRequest, signal: AbortSignal): Promise<PrimarySlot> {
    const route = request.route
    if (route.kind !== 'external-agent') throw new RouteResolutionError('primary consumer requires an external-agent route')
    const key = this.routeKey(route)
    const existing = this.slots.get(key)
    if (existing?.session !== undefined) return existing
    const cursor = existing?.cursor
    const openRequest: ExternalAgentOpenRequest = {
      route,
      session: request.session,
      permissionMode: request.permissionMode,
      ...openRequestExtras(request),
      ...(cursor === undefined ? {} : { resumeCursor: cursor }),
      signal,
    }
    const session = await this.registry.openSession(openRequest)
    const slot = existing ?? { key, route }
    slot.session = session
    if (cursor !== undefined) slot.cursor = cursor
    this.slots.set(key, slot)
    return slot
  }

  private assertLive(): void { if (this.disposed) throw new Error('primary external-agent consumer is disposed') }
  private routeKey(route: Extract<SessionModelRoute, { kind: 'external-agent' }>): string { return String(route.provider) + '\u0000' + String(route.model) }
  private sameRoute(left: SessionModelRoute | undefined, right: SessionModelRoute): boolean {
    return left?.kind === right.kind && left?.kind === 'external-agent' && right.kind === 'external-agent' && left.provider === right.provider && left.model === right.model
  }
}

/** Subagent request with explicit parent authority and foreground/background mode. */
export interface ExternalAgentSubagentRequest extends ExternalAgentConsumerTurnInput {
  readonly jobId: ExternalAgentJobId
  readonly parentSession: ExternalAgentSessionId
  readonly route: Extract<SessionModelRoute, { kind: 'external-agent' }>
  readonly signal?: AbortSignal
}
/** Background Job handle; cancellation is the only out-of-band operation. */
export interface ExternalAgentJob {
  readonly id: ExternalAgentJobId
  readonly result: Promise<ExternalAgentTurnResult>
  cancel(): void
}

/**
 * Subagent consumer preserving mandatory disposal and foreground/background
 * result semantics without starting another DSH subagent loop.
 */
export class ExternalAgentSubagentConsumer {
  private disposed = false
  private disposePromise: Promise<void> | undefined
  private readonly active = new Map<ExternalAgentJobId, { readonly controller: AbortController; readonly promise: Promise<ExternalAgentTurnResult> }>()
  constructor(private readonly registry: ExternalAgentProviderRegistry) {}

  /** Run a foreground child and fold its terminal result through callbacks. */
  runForeground(request: ExternalAgentSubagentRequest): Promise<ExternalAgentTurnResult> {
    return this.runWithController(request, new AbortController())
  }

  /** Start a background child with a caller-owned cancellation controller. */
  startBackground(request: ExternalAgentSubagentRequest): ExternalAgentJob {
    return { id: request.jobId, result: this.runWithController(request, new AbortController()), cancel: () => this.active.get(request.jobId)?.controller.abort() }
  }

  /** Cancel active children and await their provider-session disposers. */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async () => {
      for (const child of this.active.values()) child.controller.abort()
      await Promise.all([...this.active.values()].map(child => child.promise.catch(() => undefined)))
    })()
    return this.disposePromise
  }

  private runWithController(request: ExternalAgentSubagentRequest, controller: AbortController): Promise<ExternalAgentTurnResult> {
    this.assertLive()
    if (this.active.has(request.jobId)) throw new Error('duplicate external-agent job id: ' + request.jobId)
    const promise = this.runForegroundInternal(request, controller).finally(() => {
      if (this.active.get(request.jobId)?.promise === promise) this.active.delete(request.jobId)
    })
    this.active.set(request.jobId, { controller, promise })
    return promise
  }

  private async runForegroundInternal(request: ExternalAgentSubagentRequest, controller: AbortController): Promise<ExternalAgentTurnResult> {
    const forward = (): void => controller.abort()
    request.signal?.addEventListener('abort', forward, { once: true })
    let session: ExternalAgentSession | undefined
    const turn = turnId(request.jobId)
    const emit = (event: ExternalAgentConsumerEvent): void | Promise<void> => request.onSessionEvent?.(event)
    try {
      if (request.signal?.aborted) controller.abort()
      await emit({ type: 'route-selected', route: request.route })
      await emit({ type: 'turn-started', turn, route: request.route })
      session = await this.registry.openSession({
        route: request.route,
        session: request.parentSession,
        permissionMode: request.permissionMode,
        ...openRequestExtras(request),
        signal: controller.signal,
      })
      const result = await session.runTurn({ turn, prompt: request.prompt, ...(request.attachments === undefined ? {} : { attachments: request.attachments }), permissionMode: request.permissionMode, signal: controller.signal }, createConsumerTurnHost(request.host, emit))
      await emit({ type: 'turn-finished', turn, result })
      await emit({ type: 'subagent-result', jobId: request.jobId, result })
      return result
    } catch (error) {
      const result: ExternalAgentTurnResult = controller.signal.aborted ? { status: 'cancelled', text: '' } : { status: 'failed', text: '', error: 'external-agent subagent failed' }
      await emit({ type: 'turn-finished', turn, result })
      await emit({ type: 'subagent-result', jobId: request.jobId, result })
      if (controller.signal.aborted) return result
      throw error
    } finally {
      request.signal?.removeEventListener('abort', forward)
      await session?.dispose()
    }
  }

  private assertLive(): void { if (this.disposed) throw new Error('subagent external-agent consumer is disposed') }
}
