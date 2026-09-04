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
  type ExternalAgentUserInputAnswers,
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
/** Primary-session turn request. */
export interface ExternalAgentPrimaryTurnRequest extends ExternalAgentConsumerCallbacks {
  readonly session: ExternalAgentSessionId
  readonly route: SessionModelRoute
  readonly turn?: ExternalAgentTurnId
  readonly prompt: string
  readonly attachments?: ExternalAgentTurnRequest['attachments']
  readonly permissionMode: ExternalAgentTurnRequest['permissionMode']
  readonly signal: AbortSignal
  readonly fullAccessConfirmed?: boolean
  readonly fullAccessAuditId?: string
  readonly clientFilesystem?: ExternalAgentOpenRequest['clientFilesystem']
}
/** Primary-session options. */
export interface ExternalAgentPrimaryConsumerOptions {
  readonly openSession?: (request: ExternalAgentOpenRequest) => Promise<ExternalAgentSession>
}

interface PrimarySlot {
  readonly key: string
  readonly route: Extract<SessionModelRoute, { kind: 'external-agent' }>
  session?: ExternalAgentSession
  cursor?: ExternalAgentResumeCursor
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
  private selected: SessionModelRoute | undefined
  private disposed = false

  constructor(private readonly registry: ExternalAgentProviderRegistry, private readonly options: ExternalAgentPrimaryConsumerOptions = {}) {}

  /** Select a route; switching cancels and settles the active turn first. */
  async selectRoute(route: SessionModelRoute): Promise<void> {
    this.assertLive()
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
  async runTurn(request: ExternalAgentPrimaryTurnRequest): Promise<ExternalAgentTurnResult> {
    this.assertLive()
    if (request.route.kind !== 'external-agent') throw new RouteResolutionError('primary consumer requires an external-agent route')
    if (request.signal.aborted) return { status: 'cancelled', text: '' }
    if (this.active !== undefined) {
      if (this.sameRoute(this.selected, request.route)) throw new Error('primary external-agent turn is already active')
      await this.cancelActive()
    }
    await this.selectRoute(request.route)
    await request.onSessionEvent?.({ type: 'route-selected', route: request.route })
    const slot = await this.getSlot(request)
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', forwardAbort, { once: true })
    const effectiveRequest: ExternalAgentTurnRequest = {
      turn: turnId(request.turn ?? crypto.randomUUID()),
      prompt: request.prompt,
      ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      permissionMode: request.permissionMode,
      signal: controller.signal,
    }
    const emit = (event: ExternalAgentConsumerEvent): void | Promise<void> => request.onSessionEvent?.(event)
    const callbacks: ExternalAgentTurnHostCallbacks = {
      publish: event => {
        const activity = emit({ type: 'activity', event })
        return Promise.resolve(activity)
      },
      requestPermission: async permission => {
        await emit({ type: 'permission-pending', request: permission })
        let decision: ExternalAgentPermissionDecision
        try { decision = await request.host.requestPermission(permission) } catch (error) {
          await emit({ type: 'permission-committed', requestId: permission.requestId, outcome: 'unavailable' })
          throw error
        }
        await emit({ type: 'permission-committed', requestId: permission.requestId, outcome: decision.kind })
        return decision
      },
      requestUserInput: async question => {
        await emit({ type: 'question-pending', request: question })
        let answer: ExternalAgentUserInputAnswers
        try { answer = await request.host.requestUserInput(question) } catch (error) {
          await emit({ type: 'question-committed', requestId: question.requestId, answers: [] })
          throw error
        }
        await emit({ type: 'question-committed', requestId: question.requestId, answers: answer.answers })
        return answer
      },
    }
    await emit({ type: 'turn-started', turn: effectiveRequest.turn, route: request.route })
    const session = slot.session
    if (session === undefined) throw new Error('primary external-agent session was disposed before turn start')
    const promise = session.runTurn(effectiveRequest, callbacks)
    this.active = { controller, promise }
    try {
      const result = await promise
      if (result.resumeCursor !== undefined) slot.cursor = result.resumeCursor
      await emit({ type: 'turn-finished', turn: effectiveRequest.turn, result })
      return result
    } finally {
      request.signal.removeEventListener('abort', forwardAbort)
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
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.cancelActive()
    await Promise.all([...this.slots.values()].map(slot => slot.session?.dispose().catch(() => undefined)))
    this.slots.clear()
  }

  private async getSlot(request: ExternalAgentPrimaryTurnRequest): Promise<PrimarySlot> {
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
      signal: request.signal,
    }
    const session = this.options.openSession === undefined ? await this.registry.openSession(openRequest) : await this.options.openSession(openRequest)
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
export interface ExternalAgentSubagentRequest extends ExternalAgentConsumerCallbacks {
  readonly jobId: ExternalAgentJobId
  readonly parentSession: ExternalAgentSessionId
  readonly route: Extract<SessionModelRoute, { kind: 'external-agent' }>
  readonly prompt: string
  readonly permissionMode: ExternalAgentTurnRequest['permissionMode']
  readonly signal?: AbortSignal
  readonly fullAccessConfirmed?: boolean
  readonly fullAccessAuditId?: string
  readonly clientFilesystem?: ExternalAgentOpenRequest['clientFilesystem']
  readonly attachments?: ExternalAgentTurnRequest['attachments']
}
/** Background Job handle; cancellation is the only out-of-band operation. */
export interface ExternalAgentJob {
  readonly id: string
  readonly result: Promise<ExternalAgentTurnResult>
  cancel(): void
}

/**
 * Subagent consumer preserving mandatory disposal and foreground/background
 * result semantics without starting another DSH subagent loop.
 */
export class ExternalAgentSubagentConsumer {
  private disposed = false
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
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const child of this.active.values()) child.controller.abort()
    await Promise.all([...this.active.values()].map(child => child.promise.catch(() => undefined)))
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
    try {
      if (request.signal?.aborted) controller.abort()
      session = await this.registry.openSession({
        route: request.route,
        session: request.parentSession,
        permissionMode: request.permissionMode,
        ...openRequestExtras(request),
        signal: controller.signal,
      })
      const result = await session.runTurn({ turn: turnId(request.jobId), prompt: request.prompt, ...(request.attachments === undefined ? {} : { attachments: request.attachments }), permissionMode: request.permissionMode, signal: controller.signal }, request.host)
      await request.onSessionEvent?.({ type: 'subagent-result', jobId: request.jobId, result })
      return result
    } finally {
      request.signal?.removeEventListener('abort', forward)
      await session?.dispose()
    }
  }

  private assertLive(): void { if (this.disposed) throw new Error('subagent external-agent consumer is disposed') }
}
