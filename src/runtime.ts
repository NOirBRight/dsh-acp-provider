import {
  DuplicateProviderError,
  FullAccessConfirmationError,
  RouteResolutionError,
  SessionDisposedError,
  UnsupportedModeError,
  authorizeExternalAgentOpen,
  createExternalAgentTurnHost,
  modelId,
  providerId,
  type ExternalAgentFullAccessAuditor,
  type ExternalAgentModel,
  type ExternalAgentOpenRequest,
  type ExternalAgentPermissionMode,
  type ExternalAgentProvider,
  type ExternalAgentProviderId,
  type ExternalAgentRoute,
  type ExternalAgentSession,
  type ExternalAgentSessionRef,
  type ExternalAgentTurnHost,
  type ExternalAgentTurnHostController,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
  type SessionModelRoute,
} from './contracts.js'

const authorizedFullAccessRequests = new WeakSet<ExternalAgentOpenRequest>()

/** Consume proof that a full-access request passed the registry's confirmation and audit step.
 * @param request - provider open request received from the registry.
 */
export function consumeExternalAgentOpenAuthorization(request: ExternalAgentOpenRequest): void {
  if (request.permissionMode === 'full-access' && !authorizedFullAccessRequests.delete(request)) throw new FullAccessConfirmationError('full-access requests must be authorized by the provider registry')
}

/** Resolved external route with exact provider and model metadata. */
export interface ResolvedExternalAgentRoute {
  readonly provider: ExternalAgentProvider
  readonly model: ExternalAgentModel
  readonly route: ExternalAgentRoute
}
/** Resolve an external route and verify the exact advertised model. */
export async function resolveExternalAgentRoute(registry: ExternalAgentProviderRegistry, route: SessionModelRoute, signal?: AbortSignal): Promise<ResolvedExternalAgentRoute> {
  if (route.kind !== 'external-agent') throw new RouteResolutionError('route kind is not external-agent: ' + route.kind)
  const provider = registry.require(route.provider)
  const models = await provider.listModels(signal)
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  const model = models.find(candidate => candidate.id === route.model)
  if (model === undefined) throw new RouteResolutionError('external-agent model is unavailable: ' + route.provider + '/' + route.model)
  return { provider, model, route }
}

/**
 * Session wrapper enforcing exact modes, host lifetime, cancellation and
 * quiescent disposal around a provider implementation.
 */
export class ManagedExternalAgentSession implements ExternalAgentSession {
  readonly ref: ExternalAgentSessionRef
  readonly supportedModes: readonly ExternalAgentPermissionMode[]
  private disposed = false
  private activeController: AbortController | undefined
  private activeHost: ExternalAgentTurnHostController | undefined
  private activeTurn: Promise<ExternalAgentTurnResult> | undefined

  constructor(private readonly inner: ExternalAgentSession) {
    this.ref = inner.ref
    this.supportedModes = inner.supportedModes
  }
  /** Whether dispose has completed its ownership transition. */
  get isDisposed(): boolean { return this.disposed }
  /** Run one turn with a fresh host and a provider-owned cancellation signal. */
  async runTurn(request: ExternalAgentTurnRequest, host: ExternalAgentTurnHost): Promise<ExternalAgentTurnResult> {
    if (this.disposed) throw new SessionDisposedError('external-agent session is disposed')
    if (this.activeTurn !== undefined) throw new Error('external-agent session already has an active turn')
    if (!this.supportedModes.includes(request.permissionMode)) throw new UnsupportedModeError('mode ' + request.permissionMode + ' is not supported by ' + this.ref.provider)
    if (request.signal.aborted) return { status: 'cancelled', text: '' }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    const scoped = createExternalAgentTurnHost(controller.signal, {
      publish: event => host.publish(event),
      requestPermission: requestValue => host.requestPermission(requestValue),
      requestUserInput: requestValue => host.requestUserInput(requestValue),
    })
    this.activeController = controller
    this.activeHost = scoped
    const effectiveRequest = { ...request, signal: controller.signal }
    const turn = Promise.resolve().then(() => this.inner.runTurn(effectiveRequest, scoped))
    this.activeTurn = turn
    try {
      return await turn
    } catch (error) {
      if (controller.signal.aborted || request.signal.aborted) return { status: 'cancelled', text: '' }
      throw error
    } finally {
      scoped.expire()
      request.signal.removeEventListener('abort', abort)
      if (this.activeTurn === turn) this.activeTurn = undefined
      if (this.activeController === controller) this.activeController = undefined
      if (this.activeHost === scoped) this.activeHost = undefined
    }
  }
  /** Cancel the active turn, await it, and release the native session. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.activeController?.abort()
    this.activeHost?.expire()
    await this.activeTurn?.catch(() => undefined)
    await this.inner.dispose()
  }
}

/** Registry options for full-access auditing. */
export interface ExternalAgentRegistryOptions { readonly auditFullAccess?: ExternalAgentFullAccessAuditor }
/** Provider registry with exact lookup and asynchronous quiescent disposal. */
export class ExternalAgentProviderRegistry {
  private readonly providers = new Map<ExternalAgentProviderId, ExternalAgentProvider>()
  private readonly sessions = new Map<ExternalAgentProviderId, Set<ExternalAgentSession>>()
  constructor(private readonly options: ExternalAgentRegistryOptions = {}) {}
  /** Register one provider instance and return an idempotent async disposer. */
  register(provider: ExternalAgentProvider): () => Promise<void> {
    const id = provider.info.id
    if (this.providers.has(id)) throw new DuplicateProviderError(id)
    this.providers.set(id, provider)
    const sessions = new Set<ExternalAgentSession>()
    this.sessions.set(id, sessions)
    let active = true
    return async (): Promise<void> => {
      if (!active) return
      active = false
      if (this.providers.get(id) === provider) this.providers.delete(id)
      this.sessions.delete(id)
      await Promise.all([...sessions].map(session => session.dispose().catch(() => undefined)))
      await provider.dispose?.()
      sessions.clear()
    }
  }
  /** Return a provider or throw an exact availability error. */
  require(id: ExternalAgentProviderId): ExternalAgentProvider {
    const provider = this.providers.get(id)
    if (provider === undefined) throw new RouteResolutionError('external-agent provider is unavailable: ' + id)
    return provider
  }
  /** Return providers in registration order. */
  list(): readonly ExternalAgentProvider[] { return [...this.providers.values()] }
  /** Test and HMR helper for exact provider presence. */
  has(id: string): boolean { return id.trim() !== '' && this.providers.has(providerId(id)) }
  /** Return an exact provider without throwing. */
  get(id: string): ExternalAgentProvider | undefined { return id.trim() === '' ? undefined : this.providers.get(providerId(id)) }
  /** Return registered provider ids in registration order. */
  names(): readonly string[] { return [...this.providers.keys()].map(String) }
  /** Resolve one exact provider/model route. */
  async resolveExternalRoute(provider: string, model: string, signal?: AbortSignal): Promise<ExternalAgentRoute> {
    const route: ExternalAgentRoute = { kind: 'external-agent', provider: providerId(provider), model: modelId(model) }
    await resolveExternalAgentRoute(this, route, signal)
    return route
  }
  /** List models from one exact provider. */
  listModels(id: ExternalAgentProviderId, signal?: AbortSignal): Promise<readonly ExternalAgentModel[]> { return this.require(id).listModels(signal) }
  /** Resolve and open one exact provider session, registering it for disposal. */
  async openSession(request: ExternalAgentOpenRequest): Promise<ExternalAgentSession> {
    const route = request.route
    if (route.kind !== 'external-agent') throw new RouteResolutionError('route kind is not external-agent: ' + route.kind)
    await authorizeExternalAgentOpen(request, this.options.auditFullAccess)
    const resolved = await resolveExternalAgentRoute(this, route, request.signal)
    if (!resolved.model.supportedModes.includes(request.permissionMode)) throw new UnsupportedModeError('mode ' + request.permissionMode + ' is not supported by ' + route.provider + '/' + route.model)
    if (request.permissionMode === 'full-access') authorizedFullAccessRequests.add(request)
    let raw: ExternalAgentSession
    try { raw = await resolved.provider.openSession(request) } finally { authorizedFullAccessRequests.delete(request) }
    const session = raw instanceof ManagedExternalAgentSession ? raw : new ManagedExternalAgentSession(raw)
    const sessions = this.sessions.get(route.provider)
    if (this.providers.get(route.provider) !== resolved.provider || sessions === undefined) {
      await session.dispose()
      throw new RouteResolutionError('external-agent provider was disposed while opening a session: ' + route.provider)
    }
    const tracked: ExternalAgentSession = {
      ref: session.ref,
      supportedModes: session.supportedModes,
      runTurn: (turnRequest, turnHost) => session.runTurn(turnRequest, turnHost),
      dispose: async () => { try { await session.dispose() } finally { sessions.delete(tracked) } },
    }
    sessions.add(tracked)
    return tracked
  }
}
