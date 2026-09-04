/**
 * Provider-neutral External Agent platform seam for DeepSeek Harness.
 *
 * This package owns the provider/session contract, exact routes, interaction
 * lifetime, canonical activity and bounded payloads. ACP, processes, auth and
 * filesystem implementations stay in provider packages.
 */

declare const brandSymbol: unique symbol

/** Nominal value crossing an External Agent boundary. */
export type Branded<T, Kind extends string> = T & { readonly [brandSymbol]: Kind }
/** Provider instance identifier. */
export type ExternalAgentProviderId = Branded<string, 'ExternalAgentProviderId'>
/** Provider model identifier. */
export type ExternalAgentModelId = Branded<string, 'ExternalAgentModelId'>
/** DSH-visible session identifier. */
export type ExternalAgentSessionId = Branded<string, 'ExternalAgentSessionId'>
/** Provider turn identifier. */
export type ExternalAgentTurnId = Branded<string, 'ExternalAgentTurnId'>
/** External-agent subagent job identifier. */
export type ExternalAgentJobId = Branded<string, 'ExternalAgentJobId'>
/** Native permission option identifier. */
export type ExternalAgentOptionId = Branded<string, 'ExternalAgentOptionId'>

function brand<T extends string, Kind extends string>(value: T, label: string): Branded<T, Kind> {
  if (value.trim() === '') throw new TypeError(label + ' must not be empty')
  return value as Branded<T, Kind>
}
/** Brand a provider identifier at a configuration boundary. */
export function providerId(value: string): ExternalAgentProviderId { return brand<string, 'ExternalAgentProviderId'>(value, 'provider id') }
/** Brand a model identifier at a configuration boundary. */
export function modelId(value: string): ExternalAgentModelId { return brand<string, 'ExternalAgentModelId'>(value, 'model id') }
/** Brand a session identifier at a persistence boundary. */
export function sessionId(value: string): ExternalAgentSessionId { return brand<string, 'ExternalAgentSessionId'>(value, 'session id') }
/** Brand a turn identifier at a request boundary. */
export function turnId(value: string): ExternalAgentTurnId { return brand<string, 'ExternalAgentTurnId'>(value, 'turn id') }
/** Brand a subagent job identifier at a request boundary. */
export function jobId(value: string): ExternalAgentJobId { return brand<string, 'ExternalAgentJobId'>(value, 'job id') }
/** Brand a native option identifier at a wire boundary. */
export function optionId(value: string): ExternalAgentOptionId { return brand<string, 'ExternalAgentOptionId'>(value, 'option id') }

/** Error raised when a provider name is already registered. */
export class DuplicateProviderError extends Error {
  constructor(readonly provider: ExternalAgentProviderId) {
    super('duplicate external-agent provider: ' + provider)
    this.name = 'DuplicateProviderError'
  }
}
/** Error raised for malformed or unavailable exact routes. */
export class RouteResolutionError extends Error {
  constructor(message: string) { super(message); this.name = 'RouteResolutionError' }
}
/** Error raised after a native session is disposed. */
export class SessionDisposedError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionDisposedError' }
}
/** Error raised when a turn is cancelled while an interaction is pending. */
export class TurnAbortedError extends Error {
  constructor(message: string) { super(message); this.name = 'TurnAbortedError' }
}
/** Error raised when a provider retains a turn host after settlement. */
export class HostExpiredError extends Error {
  constructor(message: string) { super(message); this.name = 'HostExpiredError' }
}
/** Error raised when a model does not advertise a requested permission mode. */
export class UnsupportedModeError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedModeError' }
}
/** Error raised when full access was not explicitly confirmed. */
export class FullAccessConfirmationError extends Error {
  constructor(message = 'full-access requires explicit confirmation') { super(message); this.name = 'FullAccessConfirmationError' }
}
/** Error raised when full-access audit cannot be recorded before startup. */
export class FullAccessAuditError extends Error {
  constructor(message = 'full-access requires an audit callback') { super(message); this.name = 'FullAccessAuditError' }
}

/** Runtime route kind; LLM and complete external turns never fall back. */
export type ExternalAgentRouteKind = 'llm' | 'external-agent'
/** Raw LLM selection owned by the current DSH Agent Loop. */
export interface LlmRoute {
  readonly kind: 'llm'
  readonly model: ExternalAgentModelId
}
/** External selection whose provider owns the native turn and tools. */
export interface ExternalAgentRoute {
  readonly kind: 'external-agent'
  readonly provider: ExternalAgentProviderId
  readonly model: ExternalAgentModelId
}
/** Explicit model selection understood by the platform. */
export type SessionModelRoute = LlmRoute | ExternalAgentRoute
/** Build an explicit raw LLM route without a provider. */
export function createSessionModelRoute(kind: 'llm', model: string): LlmRoute
/** Build an explicit external-agent route. */
export function createSessionModelRoute(kind: 'external-agent', provider: string, model: string): ExternalAgentRoute
export function createSessionModelRoute(kind: ExternalAgentRouteKind, providerOrModel: string, maybeModel?: string): SessionModelRoute {
  if (kind === 'llm') return { kind, model: modelId(providerOrModel) }
  if (maybeModel === undefined) throw new RouteResolutionError('external-agent route requires provider and model')
  return { kind, provider: providerId(providerOrModel), model: modelId(maybeModel) }
}

/** Parse llm:model or external-agent:provider/model without fallback. */
export function parseRouteSpecifier(specifier: string): SessionModelRoute {
  if (specifier.startsWith('llm:')) {
    const model = specifier.slice(4)
    if (model.length === 0 || model.includes('/')) throw new RouteResolutionError('invalid llm route: ' + specifier)
    return { kind: 'llm', model: modelId(model) }
  }
  if (specifier.startsWith('external-agent:')) {
    const rest = specifier.slice('external-agent:'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0 || slash !== rest.lastIndexOf('/') || slash === rest.length - 1) throw new RouteResolutionError('invalid external-agent route: ' + specifier)
    return { kind: 'external-agent', provider: providerId(rest.slice(0, slash)), model: modelId(rest.slice(slash + 1)) }
  }
  throw new RouteResolutionError('unknown route specifier: ' + specifier)
}

/** Generic permission policy for one native session. */
export type ExternalAgentPermissionMode = 'approval-required' | 'auto-accept-edits' | 'full-access'
/** All public permission modes in selector order. */
export const ALL_PERMISSION_MODES: readonly ExternalAgentPermissionMode[] = ['approval-required', 'auto-accept-edits', 'full-access']
/** Native option kind offered by a provider. */
export type ExternalAgentPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject' | 'cancel'
/** Native permission option; allow-always is always explicitly scoped. */
export interface ExternalAgentPermissionOption {
  readonly optionId: ExternalAgentOptionId
  readonly kind: ExternalAgentPermissionOptionKind
  readonly label: string
  readonly scope?: 'session' | 'thread'
}
/** Provider warning displayed beside a permission request. */
export interface ExternalAgentSecurityWarning {
  readonly message: string
  readonly scope?: 'session' | 'thread'
}
/** Sensitive native action awaiting host authority. */
export interface ExternalAgentPermissionRequest {
  readonly requestId: ExternalAgentOptionId
  readonly toolName: string
  readonly reason: string
  readonly options: readonly ExternalAgentPermissionOption[]
  readonly securityWarning?: ExternalAgentSecurityWarning
}
/** Host decision; native option ids are preserved and never replayed from logs. */
export type ExternalAgentPermissionDecision =
  | { readonly kind: 'allow-once'; readonly optionId: ExternalAgentOptionId }
  | { readonly kind: 'allowed-for-session'; readonly optionId: ExternalAgentOptionId }
  | { readonly kind: 'reject'; readonly optionId?: ExternalAgentOptionId }
  | { readonly kind: 'cancel'; readonly optionId?: ExternalAgentOptionId }
  | { readonly kind: 'unavailable'; readonly optionId?: ExternalAgentOptionId }

/** Error raised when an allow-always option lacks its native scope. */
export class UnscopedAllowAlwaysError extends Error {
  constructor() { super('allow_always requires a session or thread scope'); this.name = 'UnscopedAllowAlwaysError' }
}
/** Return the host outcome represented by one native option. */
export function outcomeForOption(option: ExternalAgentPermissionOption): 'allowed-once' | 'allowed-for-session' | 'rejected' {
  switch (option.kind) {
    case 'allow_once': return 'allowed-once'
    case 'allow_always':
      if (option.scope === undefined) throw new UnscopedAllowAlwaysError()
      return 'allowed-for-session'
    case 'reject': case 'cancel': return 'rejected'
  }
}
/** Whether a request exposes a native session-scoped grant. */
export function offersAllowAlways(options: readonly ExternalAgentPermissionOption[]): boolean { return options.some(option => option.kind === 'allow_always' && option.scope !== undefined) }
/** Compatibility names for provider-neutral event and interaction types. */
export type PermissionMode = ExternalAgentPermissionMode
export type PermissionOption = ExternalAgentPermissionOption
export type PermissionRequest = ExternalAgentPermissionRequest
export type PermissionOutcome = 'allowed-once' | 'allowed-for-session' | 'rejected' | 'cancelled' | 'unavailable'
export type ActivityEvent = ExternalAgentEvent

/** Question emitted by a native provider. */
export interface ExternalAgentUserInputRequest {
  readonly requestId: ExternalAgentOptionId
  readonly question: string
  readonly options?: readonly string[]
  readonly multiple?: boolean
}
/** User-provided prompt attachment forwarded by a native provider. */
export interface ExternalAgentAttachment {
  readonly name: string
  readonly path?: string
  readonly mimeType?: string
  readonly data?: string
}
/** Answers to one native question. */
export interface ExternalAgentUserInputAnswers { readonly answers: readonly string[] }

/** Normalized activity visible to DSH; tool activity is never re-executed by DSH. */
export type ExternalAgentEvent =
  | { readonly type: 'assistant-delta'; readonly text: string }
  | { readonly type: 'thought-delta'; readonly text: string }
  | { readonly type: 'tool-activity'; readonly toolId: string; readonly name: string; readonly status: 'pending' | 'running' | 'completed' | 'failed'; readonly input?: string; readonly output?: string; readonly error?: string; readonly locations?: readonly string[] }
  | { readonly type: 'plan-update'; readonly summary: string; readonly steps: readonly string[] }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly type: 'notice'; readonly level: 'info' | 'warning' | 'error'; readonly message: string }
  | { readonly type: 'session'; readonly status: 'created' | 'resumed' | 'closed'; readonly cursor?: string }
  | { readonly type: 'turn-result'; readonly status: 'completed' | 'cancelled' | 'failed'; readonly content?: string }

/** Provider-native cursor isolated by its owning provider instance. */
export interface ExternalAgentResumeCursor {
  readonly provider: ExternalAgentProviderId
  readonly value: string
}
/** Make a provider-scoped native resume cursor. */
export function resumeCursor(provider: ExternalAgentProviderId | string, value: string): ExternalAgentResumeCursor {
  if (value.trim() === '') throw new TypeError('resume cursor value must not be empty')
  return { provider: typeof provider === 'string' ? providerId(provider) : provider, value }
}

/** Result of one complete native turn. */
export interface ExternalAgentTurnResult {
  readonly status: 'completed' | 'cancelled' | 'failed'
  readonly text: string
  readonly nativeSessionId?: ExternalAgentSessionId
  readonly resumeCursor?: ExternalAgentResumeCursor
  readonly error?: string
}
/** Provider-owned session reference projected into DSH. */
export interface ExternalAgentSessionRef {
  readonly provider: ExternalAgentProviderId
  readonly session: ExternalAgentSessionId
  readonly nativeSession?: ExternalAgentSessionId
  readonly resumeCursor?: ExternalAgentResumeCursor
}

/** Host filesystem capability supplied only when a native session opts in. */
export interface ExternalAgentFilesystem {
  readonly workspaceRoots: readonly string[]
  readonly attachmentRoots: readonly string[]
  readTextFile(path: string, signal?: AbortSignal): Promise<string>
  writeTextFile(path: string, content: string, signal?: AbortSignal): Promise<void>
  resolvePath?(path: string, operation: 'read' | 'write'): Promise<string> | string
}
/** Request to create or resume a native session. */
export interface ExternalAgentOpenRequest {
  readonly route: SessionModelRoute
  readonly session: ExternalAgentSessionId
  readonly permissionMode: ExternalAgentPermissionMode
  readonly resumeCursor?: ExternalAgentResumeCursor
  readonly fullAccessConfirmed?: boolean
  readonly fullAccessAuditId?: string
  readonly workspaceRoot?: string
  readonly attachmentRoots?: readonly string[]
  readonly clientFilesystem?: ExternalAgentFilesystem
  readonly signal?: AbortSignal
}
/** One user turn submitted to a native session. */
export interface ExternalAgentTurnRequest {
  readonly turn: ExternalAgentTurnId
  readonly prompt: string
  readonly attachments?: readonly ExternalAgentAttachment[]
  readonly permissionMode: ExternalAgentPermissionMode
  readonly signal: AbortSignal
}

/** Callbacks owned by the DSH primary or subagent consumer for one turn. */
export interface ExternalAgentTurnHostCallbacks {
  publish(event: ExternalAgentEvent): void | Promise<void>
  requestPermission(request: ExternalAgentPermissionRequest): Promise<ExternalAgentPermissionDecision>
  requestUserInput(request: ExternalAgentUserInputRequest): Promise<ExternalAgentUserInputAnswers>
}
/** Turn-scoped authority handed to a provider; all operations fail after expiry. */
export interface ExternalAgentTurnHost {
  readonly signal?: AbortSignal
  publish(event: ExternalAgentEvent): void | Promise<void>
  requestPermission(request: ExternalAgentPermissionRequest): Promise<ExternalAgentPermissionDecision>
  requestUserInput(request: ExternalAgentUserInputRequest): Promise<ExternalAgentUserInputAnswers>
}
/** Controller used by the session runner to expire a turn host. */
export interface ExternalAgentTurnHostController extends ExternalAgentTurnHost {
  readonly expired: boolean
  expire(): void
}

/** Create an expiring host with abort-aware pending interactions. */
export function createExternalAgentTurnHost(signal: AbortSignal, callbacks: ExternalAgentTurnHostCallbacks): ExternalAgentTurnHostController {
  let expired = false
  const pending = new Set<(error: unknown) => void>()
  const raceAbort = <T>(promise: Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(new TurnAbortedError('turn aborted while waiting for the host'))
    let rejectPending: (error: unknown) => void = () => undefined
    const guard = new Promise<T>((_resolve, reject) => { rejectPending = reject })
    pending.add(rejectPending)
    const onAbort = (): void => {
      pending.delete(rejectPending)
      rejectPending(new TurnAbortedError('turn aborted while waiting for the host'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return Promise.race([promise, guard]).finally(() => {
      pending.delete(rejectPending)
      signal.removeEventListener('abort', onAbort)
    })
  }
  const check = (): void => {
    if (expired) throw new HostExpiredError('turn host used after the turn settled')
    if (signal.aborted) throw new TurnAbortedError('turn aborted')
  }
  return {
    signal,
    get expired(): boolean { return expired },
    expire(): void {
      if (expired) return
      expired = true
      const error = new HostExpiredError('turn settled; pending host interaction rejected')
      for (const reject of pending) reject(error)
      pending.clear()
    },
    publish(event): void | Promise<void> { check(); return callbacks.publish(event) },
    requestPermission(request): Promise<ExternalAgentPermissionDecision> { check(); return raceAbort(callbacks.requestPermission(request)) },
    requestUserInput(request): Promise<ExternalAgentUserInputAnswers> { check(); return raceAbort(callbacks.requestUserInput(request)) },
  }
}

/** Full-access audit record written before a provider starts a process. */
export interface ExternalAgentFullAccessAudit {
  readonly provider: ExternalAgentProviderId
  readonly session: ExternalAgentSessionId
  readonly mode: 'full-access'
  readonly auditId?: string
}
/** Callback that records a value-free full-access event. */
export type ExternalAgentFullAccessAuditor = (entry: ExternalAgentFullAccessAudit) => void | Promise<void>

/** Verify and audit a full-access open request before provider startup. */
export async function authorizeExternalAgentOpen(request: ExternalAgentOpenRequest, audit?: ExternalAgentFullAccessAuditor): Promise<void> {
  if (request.permissionMode !== 'full-access') return
  if (request.fullAccessConfirmed !== true) throw new FullAccessConfirmationError()
  if (audit === undefined) throw new FullAccessAuditError()
  if (request.route.kind !== 'external-agent') throw new RouteResolutionError('full-access route is not external-agent')
  await audit({ provider: request.route.provider, session: request.session, ...(request.fullAccessAuditId === undefined ? {} : { auditId: request.fullAccessAuditId }), mode: 'full-access' })
}

/** Exact model metadata advertised by one provider. */
export interface ExternalAgentModel {
  readonly id: ExternalAgentModelId
  readonly name: string
  readonly description?: string
  readonly supportedModes: readonly ExternalAgentPermissionMode[]
}
/** Provider identity displayed in model selection and Settings. */
export interface ExternalAgentProviderInfo {
  readonly id: ExternalAgentProviderId
  readonly name: string
  readonly description?: string
}
/** Provider implementation shared by primary and subagent consumers. */
export interface ExternalAgentProvider {
  readonly info: ExternalAgentProviderInfo
  listModels(signal?: AbortSignal): Promise<readonly ExternalAgentModel[]>
  openSession(request: ExternalAgentOpenRequest): Promise<ExternalAgentSession>
  dispose?(): Promise<void>
}
/** Provider-owned native session. */
export interface ExternalAgentSession {
  readonly ref: ExternalAgentSessionRef
  readonly supportedModes: readonly ExternalAgentPermissionMode[]
  runTurn(request: ExternalAgentTurnRequest, host: ExternalAgentTurnHost): Promise<ExternalAgentTurnResult>
  dispose(): Promise<void>
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
  const model = (await provider.listModels(signal)).find(candidate => candidate.id === route.model)
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
    const resolved = await resolveExternalAgentRoute(this, route, request.signal)
    if (!resolved.model.supportedModes.includes(request.permissionMode)) throw new UnsupportedModeError('mode ' + request.permissionMode + ' is not supported by ' + route.provider + '/' + route.model)
    await authorizeExternalAgentOpen(request, this.options.auditFullAccess)
    const raw = await resolved.provider.openSession(request)
    const session = raw instanceof ManagedExternalAgentSession ? raw : new ManagedExternalAgentSession(raw)
    const sessions = this.sessions.get(route.provider)
    if (this.providers.get(route.provider) !== resolved.provider || sessions === undefined) {
      await session.dispose()
      throw new RouteResolutionError('external-agent provider was disposed while opening a session: ' + route.provider)
    }
    sessions.add(session)
    return session
  }
}
/** Alias retained for code that names the registry without the shorter form. */
export const ExternalAgentRegistry = ExternalAgentProviderRegistry

/** Byte limit for canonical provider payloads. */
export interface ExternalAgentEventBounds {
  readonly maxTextBytes: number
  readonly maxPayloadBytes: number
}
function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength }
function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxTextBytes must be a non-negative safe integer')
  if (utf8Length(value) <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const next = utf8Length(character)
    if (bytes + next > maxBytes) break
    result += character
    bytes += next
  }
  return result
}
function payloadBytes(value: unknown): number { return utf8Length(JSON.stringify(value)) }
function emptyEvent(event: ExternalAgentEvent): ExternalAgentEvent {
  switch (event.type) {
    case 'assistant-delta': return { type: event.type, text: '' }
    case 'thought-delta': return { type: event.type, text: '' }
    case 'tool-activity': return { type: event.type, toolId: '', name: '', status: event.status }
    case 'plan-update': return { type: event.type, summary: '', steps: [] }
    case 'usage': return event
    case 'notice': return { type: event.type, level: event.level, message: '' }
    case 'session': return { type: event.type, status: event.status }
    case 'turn-result': return { type: event.type, status: event.status }
  }
}
function boundedInitialEvent(event: ExternalAgentEvent, maxTextBytes: number): ExternalAgentEvent {
  switch (event.type) {
    case 'assistant-delta': return { ...event, text: truncateUtf8(event.text, maxTextBytes) }
    case 'thought-delta': return { ...event, text: truncateUtf8(event.text, maxTextBytes) }
    case 'tool-activity': return {
      ...event,
      toolId: truncateUtf8(event.toolId, maxTextBytes),
      name: truncateUtf8(event.name, maxTextBytes),
      ...(event.input === undefined ? {} : { input: truncateUtf8(event.input, maxTextBytes) }),
      ...(event.output === undefined ? {} : { output: truncateUtf8(event.output, maxTextBytes) }),
      ...(event.error === undefined ? {} : { error: truncateUtf8(event.error, maxTextBytes) }),
      ...(event.locations === undefined ? {} : { locations: event.locations.map(location => truncateUtf8(location, maxTextBytes)) }),
    }
    case 'plan-update': return { ...event, summary: truncateUtf8(event.summary, maxTextBytes), steps: event.steps.map(step => truncateUtf8(step, maxTextBytes)) }
    case 'usage': return event
    case 'notice': return { ...event, message: truncateUtf8(event.message, maxTextBytes) }
    case 'session': return event.cursor === undefined ? event : { ...event, cursor: truncateUtf8(event.cursor, maxTextBytes) }
    case 'turn-result': return event.content === undefined ? event : { ...event, content: truncateUtf8(event.content, maxTextBytes) }
  }
}
/** Bound every variable in one event and guarantee its complete JSON is within the payload cap. */
export function boundExternalAgentEvent(event: ExternalAgentEvent, bounds: ExternalAgentEventBounds): ExternalAgentEvent {
  if (!Number.isSafeInteger(bounds.maxTextBytes) || bounds.maxTextBytes < 0) throw new RangeError('maxTextBytes must be a non-negative safe integer')
  if (!Number.isSafeInteger(bounds.maxPayloadBytes) || bounds.maxPayloadBytes < 1) throw new RangeError('maxPayloadBytes must be a positive safe integer')
  const initial = boundedInitialEvent(event, bounds.maxTextBytes)
  if (payloadBytes(initial) <= bounds.maxPayloadBytes) return initial
  let current = emptyEvent(initial)
  if (payloadBytes(current) > bounds.maxPayloadBytes) throw new RangeError('external-agent event exceeds maxPayloadBytes: ' + event.type)
  const slots: Array<{ readonly value: string; readonly optional?: boolean; readonly apply: (event: ExternalAgentEvent, value: string) => ExternalAgentEvent }> = []
  switch (initial.type) {
    case 'assistant-delta': slots.push({ value: initial.text, apply: (valueEvent, value) => ({ ...valueEvent, text: value } as ExternalAgentEvent) }); break
    case 'thought-delta': slots.push({ value: initial.text, apply: (valueEvent, value) => ({ ...valueEvent, text: value } as ExternalAgentEvent) }); break
    case 'tool-activity':
      slots.push({ value: initial.toolId, apply: (valueEvent, value) => ({ ...valueEvent, toolId: value } as ExternalAgentEvent) }, { value: initial.name, apply: (valueEvent, value) => ({ ...valueEvent, name: value } as ExternalAgentEvent) })
      for (const location of initial.locations ?? []) slots.push({ value: location, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, locations: [...(valueEvent.type === 'tool-activity' ? valueEvent.locations ?? [] : []), value] } as ExternalAgentEvent) })
      for (const key of ['input', 'output', 'error'] as const) {
        const value = initial[key]
        if (value !== undefined) slots.push({ value, optional: true, apply: (valueEvent, next) => ({ ...valueEvent, [key]: next } as ExternalAgentEvent) })
      }
      break
    case 'plan-update':
      slots.push({ value: initial.summary, apply: (valueEvent, value) => ({ ...valueEvent, summary: value } as ExternalAgentEvent) })
      for (const step of initial.steps) slots.push({ value: step, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, steps: [...(valueEvent.type === 'plan-update' ? valueEvent.steps : []), value] } as ExternalAgentEvent) })
      break
    case 'notice': slots.push({ value: initial.message, apply: (valueEvent, value) => ({ ...valueEvent, message: value } as ExternalAgentEvent) }); break
    case 'session': if (initial.cursor !== undefined) slots.push({ value: initial.cursor, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, cursor: value } as ExternalAgentEvent) }); break
    case 'turn-result': if (initial.content !== undefined) slots.push({ value: initial.content, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, content: value } as ExternalAgentEvent) }); break
    case 'usage': break
  }
  for (const slot of slots) {
    const points = Array.from(slot.value)
    let low = 0
    let high = points.length
    let best = ''
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = points.slice(0, middle).join('')
      if (payloadBytes(slot.apply(current, candidate)) <= bounds.maxPayloadBytes) { best = candidate; low = middle + 1 } else high = middle - 1
    }
    if (best !== '' || slot.optional !== true) current = slot.apply(current, best)
  }
  if (payloadBytes(current) > bounds.maxPayloadBytes) throw new RangeError('external-agent event exceeds maxPayloadBytes: ' + event.type)
  return current
}

function boundPermissionRequest(request: ExternalAgentPermissionRequest, bounds: ExternalAgentEventBounds): ExternalAgentPermissionRequest {
  const result: ExternalAgentPermissionRequest = {
    requestId: request.requestId,
    toolName: truncateUtf8(request.toolName, bounds.maxTextBytes),
    reason: truncateUtf8(request.reason, bounds.maxTextBytes),
    options: request.options.map(option => ({ ...option, label: truncateUtf8(option.label, bounds.maxTextBytes) })),
    ...(request.securityWarning === undefined ? {} : { securityWarning: { ...request.securityWarning, message: truncateUtf8(request.securityWarning.message, bounds.maxTextBytes) } }),
  }
  if (payloadBytes(result) > bounds.maxPayloadBytes) throw new RangeError('external-agent permission request exceeds maxPayloadBytes')
  return result
}
function boundUserInputRequest(request: ExternalAgentUserInputRequest, bounds: ExternalAgentEventBounds): ExternalAgentUserInputRequest {
  const result: ExternalAgentUserInputRequest = {
    requestId: request.requestId,
    question: truncateUtf8(request.question, bounds.maxTextBytes),
    ...(request.options === undefined ? {} : { options: request.options.map(option => truncateUtf8(option, bounds.maxTextBytes)) }),
    ...(request.multiple === undefined ? {} : { multiple: request.multiple }),
  }
  if (payloadBytes(result) > bounds.maxPayloadBytes) throw new RangeError('external-agent user-input request exceeds maxPayloadBytes')
  return result
}
/** Apply event and interaction bounds before display or persistence. */
export function withBoundedExternalAgentHost(host: ExternalAgentTurnHost, bounds: ExternalAgentEventBounds): ExternalAgentTurnHost {
  return {
    ...(host.signal === undefined ? {} : { signal: host.signal }),
    publish: event => host.publish(boundExternalAgentEvent(event, bounds)),
    requestPermission: request => host.requestPermission(boundPermissionRequest(request, bounds)),
    requestUserInput: request => host.requestUserInput(boundUserInputRequest(request, bounds)),
  }
}

/** Options for a bounded in-memory event log. */
export interface BoundedEventLogOptions {
  readonly maxEvents?: number
  readonly maxTextBytes?: number
  readonly maxPayloadBytes?: number
}
/** Bounded event sink that drops oldest events after its count cap. */
export class BoundedEventLog {
  private readonly buffer: ExternalAgentEvent[] = []
  private dropped = 0
  private readonly maxEvents: number
  private readonly bounds: ExternalAgentEventBounds
  constructor(options: BoundedEventLogOptions = {}) {
    this.maxEvents = Math.max(1, options.maxEvents ?? 500)
    this.bounds = { maxTextBytes: Math.max(0, options.maxTextBytes ?? 4000), maxPayloadBytes: Math.max(1, options.maxPayloadBytes ?? 16 * 1024 * 1024) }
  }
  /** Push one bounded event. */
  push(event: ExternalAgentEvent): void {
    const bounded = boundExternalAgentEvent(event, this.bounds)
    if (this.buffer.length >= this.maxEvents) { this.buffer.shift(); this.dropped += 1 }
    this.buffer.push(bounded)
  }
  /** Return a snapshot of retained events. */
  events(): readonly ExternalAgentEvent[] { return [...this.buffer] }
  /** Number of events dropped due to the count cap. */
  get droppedCount(): number { return this.dropped }
}
