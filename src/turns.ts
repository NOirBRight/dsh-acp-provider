/**
 * Cached native turn runner over the provider registry.
 *
 * The runner owns one provider session per DSH session id, persists native
 * cursors through a caller-owned seam, and never opens outside the registry.
 */
import {
  RouteResolutionError,
  type ExternalAgentOpenRequest,
  type ExternalAgentProvider,
  type ExternalAgentProviderId,
  type ExternalAgentSession,
  type ExternalAgentSessionId,
  type ExternalAgentSessionRef,
  type ExternalAgentTurnHostCallbacks,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
} from './contracts.js'
import { resolveExternalAgentRoute, type ExternalAgentProviderRegistry } from './runtime.js'

/** Caller-owned persistence for native session references. */
export interface ExternalAgentTurnRunnerPersistence {
  readonly loadSession?: (sessionId: ExternalAgentSessionId) => ExternalAgentSessionRef | undefined | Promise<ExternalAgentSessionRef | undefined>
  readonly saveSession?: (ref: ExternalAgentSessionRef) => void | Promise<void>
}

interface RunnerSlot {
  readonly sessionId: ExternalAgentSessionId
  provider: ExternalAgentProviderId
  workspaceRoot?: string | undefined
  providerInstance?: ExternalAgentProvider | undefined
  session?: ExternalAgentSession | undefined
  binding?: ExternalAgentSessionRef | undefined
  bindingLoaded: boolean
  releasing?: Promise<void> | undefined
  current?: { readonly controller: AbortController; readonly promise: Promise<ExternalAgentTurnResult> } | undefined
}

function sameRef(left: ExternalAgentSessionRef, right: ExternalAgentSessionRef | undefined): boolean {
  if (right === undefined) return false
  if (String(left.provider) !== String(right.provider) || String(left.session) !== String(right.session)) return false
  const leftNative = left.nativeSession === undefined ? undefined : String(left.nativeSession)
  const rightNative = right.nativeSession === undefined ? undefined : String(right.nativeSession)
  if (leftNative !== rightNative) return false
  if (left.resumeCursor === undefined || right.resumeCursor === undefined) return left.resumeCursor === right.resumeCursor
  return String(left.resumeCursor.provider) === String(right.resumeCursor.provider) && left.resumeCursor.value === right.resumeCursor.value
}

/**
 * Serialized turn runner with fail-closed resume and quiescent reset.
 */
export class ExternalAgentTurnRunner {
  private readonly slots = new Map<string, RunnerSlot>()
  private disposed = false
  private cleanupFailure: AggregateError | undefined
  private resetPromise: Promise<void> | undefined
  private disposePromise: Promise<void> | undefined
  constructor(private readonly registry: ExternalAgentProviderRegistry, private readonly persistence: ExternalAgentTurnRunnerPersistence = {}) {}
  /** Run one turn through the cached session for the open request.
   * @param openRequest - route/session used to open or reuse the native session.
   * @param turnRequest - user turn; the open route model is forwarded as the turn model.
   * @param host - turn callbacks owned by the caller.
   * @returns the provider turn result verbatim.
   */
  async runTurn(openRequest: ExternalAgentOpenRequest, turnRequest: ExternalAgentTurnRequest, host: ExternalAgentTurnHostCallbacks): Promise<ExternalAgentTurnResult> {
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure
    if (this.disposed) throw new Error('external-agent turn runner is disposed')
    if (this.resetPromise !== undefined) throw new Error('external-agent turn runner is resetting')
    const route = openRequest.route
    if (route.kind !== 'external-agent') throw new RouteResolutionError('route kind is not external-agent: ' + route.kind)
    if (openRequest.permissionMode !== turnRequest.permissionMode) throw new RouteResolutionError('open and turn permission modes must agree')
    const key = String(openRequest.session)
    const existing = this.slots.get(key)
    if (existing?.releasing !== undefined) throw new Error('external-agent session is releasing: ' + key)
    let slot = existing
    if (slot === undefined) {
      slot = { sessionId: openRequest.session, provider: route.provider, workspaceRoot: openRequest.workspaceRoot, bindingLoaded: false }
      this.slots.set(key, slot)
    }
    if (slot.current !== undefined) throw new Error('external-agent turn already active for session: ' + key)
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.execute(slot, key, openRequest, turnRequest, host, controller))
    slot.current = { controller, promise }
    try {
      return await promise
    } finally {
      if (slot.current?.promise === promise) slot.current = undefined
    }
  }
  /** Cancel and release one cached session without closing the runner.
   * @param sessionId - DSH session id to release.
   * @returns a promise that resolves when the session is released.
   */
  async release(sessionId: ExternalAgentSessionId): Promise<void> {
    const key = String(sessionId)
    const slot = this.slots.get(key)
    if (slot === undefined) {
      if (this.cleanupFailure !== undefined) throw this.cleanupFailure
      return
    }
    if (slot.releasing !== undefined) {
      await slot.releasing
      return
    }
    const task = Promise.resolve().then(async (): Promise<void> => {
      slot.current?.controller.abort()
      await slot.current?.promise.catch(() => undefined)
      try {
        if (slot.session !== undefined) await this.disposeNative(slot.session)
      } finally {
        slot.session = undefined
        slot.providerInstance = undefined
        if (this.slots.get(key) === slot) this.slots.delete(key)
      }
    })
    slot.releasing = task
    await task
  }
  /** Cancel and release every cached session while staying usable.
   * @returns a promise that resolves when every session is released.
   */
  async reset(): Promise<void> {
    if (this.disposePromise !== undefined) {
      await this.disposePromise
      return
    }
    if (this.resetPromise !== undefined) {
      await this.resetPromise
      return
    }
    const task = Promise.resolve().then(() => this.clearAll())
    this.resetPromise = task
    try {
      await task
    } finally {
      if (this.resetPromise === task) this.resetPromise = undefined
    }
  }
  /** Cancel every session and permanently close the runner.
   * @returns the shared disposal promise.
   */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    const prior = this.resetPromise
    const task = (async (): Promise<void> => {
      if (prior !== undefined) await prior.catch(() => undefined)
      this.resetPromise = undefined
      await this.clearAll()
    })()
    this.disposePromise = task
    return this.disposePromise
  }
  private async clearAll(): Promise<void> {
    const slots = [...this.slots.values()]
    for (const slot of slots) slot.current?.controller.abort()
    await Promise.all(slots.map(slot => slot.current?.promise.catch(() => undefined)))
    const results = await Promise.allSettled(slots.map(slot => slot.releasing ?? slot.session?.dispose()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      this.disposed = true
      this.cleanupFailure = new AggregateError(failures, 'Native session cleanup failed; runner is closed')
    }
    this.slots.clear()
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure
  }
  private async storeBinding(slot: RunnerSlot, ref: ExternalAgentSessionRef): Promise<void> {
    if (ref.session !== slot.sessionId || ref.provider !== slot.provider || (ref.resumeCursor !== undefined && ref.resumeCursor.provider !== ref.provider)) throw new Error('native reference does not belong to this session and provider')
    if (this.persistence.saveSession !== undefined) await this.persistence.saveSession(ref)
    slot.binding = ref
  }
  private async ensureBinding(slot: RunnerSlot, openRequest: ExternalAgentOpenRequest): Promise<void> {
    if (slot.bindingLoaded) return
    if (this.persistence.loadSession === undefined) {
      slot.bindingLoaded = true
      return
    }
    const loaded = await this.persistence.loadSession(openRequest.session)
    const route = openRequest.route
    if (route.kind !== 'external-agent') throw new RouteResolutionError('route kind is not external-agent: ' + route.kind)
    if (loaded !== undefined) {
      if (String(loaded.session) !== String(openRequest.session)) throw new Error('external-agent binding belongs to another session')
      if (loaded.provider !== route.provider) throw new RouteResolutionError('external-agent session is bound to another provider: ' + loaded.provider)
      slot.binding = loaded
    }
    slot.bindingLoaded = true
  }
  private async ensureSession(slot: RunnerSlot, key: string, openRequest: ExternalAgentOpenRequest, controller: AbortController): Promise<ExternalAgentSession | undefined> {
    const route = openRequest.route
    if (route.kind !== 'external-agent') throw new RouteResolutionError('route kind is not external-agent: ' + route.kind)
    if (slot.session !== undefined) {
      const current = this.registry.require(route.provider)
      if (current === slot.providerInstance) {
        await resolveExternalAgentRoute(this.registry, route, controller.signal)
        await this.registry.authorize(openRequest)
        return slot.session
      }
      await this.dropSession(slot, slot.session)
    }
    if (slot.binding !== undefined && slot.binding.resumeCursor === undefined) throw new Error('external-agent binding has no resume cursor; refusing to open a new native session')
    const openingProvider = this.registry.require(route.provider)
    const resume = slot.binding?.resumeCursor ?? openRequest.resumeCursor
    const effectiveOpen: ExternalAgentOpenRequest = { ...openRequest, ...(resume === undefined ? {} : { resumeCursor: resume }), signal: controller.signal }
    let session: ExternalAgentSession
    try {
      session = await this.registry.openSession(effectiveOpen)
    } catch (error) {
      if (controller.signal.aborted) return undefined
      throw error
    }
    if (controller.signal.aborted || this.slots.get(key) !== slot || slot.current?.controller !== controller) {
      await this.disposeNative(session)
      return undefined
    }
    try {
      await this.storeBinding(slot, session.ref)
    } catch (error) {
      await this.disposeNative(session)
      throw error
    }
    slot.session = session
    slot.providerInstance = openingProvider
    return session
  }
  private async disposeNative(session: ExternalAgentSession): Promise<void> {
    try { await session.dispose() } catch (error) {
      this.disposed = true
      this.cleanupFailure = new AggregateError([error], 'Native session cleanup failed; runner is closed')
      throw this.cleanupFailure
    }
  }
  private async dropSession(slot: RunnerSlot, session: ExternalAgentSession): Promise<void> {
    try { await this.disposeNative(session) } finally {
      if (slot.session === session) {
        slot.session = undefined
        slot.providerInstance = undefined
      }
    }
  }
  private async execute(slot: RunnerSlot, key: string, openRequest: ExternalAgentOpenRequest, turnRequest: ExternalAgentTurnRequest, host: ExternalAgentTurnHostCallbacks, controller: AbortController): Promise<ExternalAgentTurnResult> {
    const route = openRequest.route
    if (route.kind !== 'external-agent') throw new RouteResolutionError('route kind is not external-agent: ' + route.kind)
    if (slot.provider !== route.provider) throw new RouteResolutionError('external-agent session is bound to another provider: ' + slot.provider)
    if (slot.workspaceRoot !== openRequest.workspaceRoot) throw new RouteResolutionError('external-agent session is bound to another workspace')
    const forward = (): void => controller.abort()
    if (turnRequest.signal.aborted || openRequest.signal?.aborted) controller.abort()
    turnRequest.signal.addEventListener('abort', forward, { once: true })
    openRequest.signal?.addEventListener('abort', forward, { once: true })
    try {
      if (controller.signal.aborted) return { status: 'cancelled', text: '' }
      await this.ensureBinding(slot, openRequest)
      if (controller.signal.aborted) return { status: 'cancelled', text: '' }
      const session = await this.ensureSession(slot, key, openRequest, controller)
      if (session === undefined || controller.signal.aborted) return { status: 'cancelled', text: '' }
      let result: ExternalAgentTurnResult
      try {
        result = await session.runTurn({ ...turnRequest, model: route.model, signal: controller.signal }, host)
      } catch (error) {
        await this.dropSession(slot, session)
        throw error
      }
      if (this.slots.get(key) !== slot) return result
      const native = result.nativeSessionId ?? slot.binding?.nativeSession ?? session.ref.nativeSession
      const cursor = result.resumeCursor ?? slot.binding?.resumeCursor ?? session.ref.resumeCursor
      const updated: ExternalAgentSessionRef = { provider: route.provider, session: openRequest.session, ...(native === undefined ? {} : { nativeSession: native }), ...(cursor === undefined ? {} : { resumeCursor: cursor }) }
      if (!sameRef(updated, slot.binding)) {
        try {
          await this.storeBinding(slot, updated)
        } catch (error) {
          await this.dropSession(slot, session)
          throw error
        }
      }
      if (result.status !== 'completed') await this.dropSession(slot, session)
      return result
    } finally {
      turnRequest.signal.removeEventListener('abort', forward)
      openRequest.signal?.removeEventListener('abort', forward)
    }
  }
}
