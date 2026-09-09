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
/** Provider kind identifier. */
export type ExternalAgentProviderId = Branded<string, 'ExternalAgentProviderId'>
/** Independently mounted provider instance identifier. */
export type ExternalAgentProviderInstanceId = Branded<string, 'ExternalAgentProviderInstanceId'>
/** Full-access audit correlation identifier. */
export type ExternalAgentAuditId = Branded<string, 'ExternalAgentAuditId'>
/** Provider model identifier. */
export type ExternalAgentModelId = Branded<string, 'ExternalAgentModelId'>
/** DSH-visible session identifier. */
export type ExternalAgentSessionId = Branded<string, 'ExternalAgentSessionId'>
/** Provider turn identifier. */
export type ExternalAgentTurnId = Branded<string, 'ExternalAgentTurnId'>
/** External-agent subagent job identifier. */
export type ExternalAgentJobId = Branded<string, 'ExternalAgentJobId'>
/** Provider tool-call identifier. */
export type ExternalAgentToolId = Branded<string, 'ExternalAgentToolId'>
/** Native permission option identifier. */
export type ExternalAgentOptionId = Branded<string, 'ExternalAgentOptionId'>

function brand<T extends string, Kind extends string>(value: T, label: string): Branded<T, Kind> {
  if (value.trim() === '') throw new TypeError(label + ' must not be empty')
  return value as Branded<T, Kind>
}
/** Brand a provider identifier at a configuration boundary. */
export function providerId(value: string): ExternalAgentProviderId {
  if (value.includes('/')) throw new TypeError('provider id must not contain /')
  return brand<string, 'ExternalAgentProviderId'>(value, 'provider id')
}
/** Brand a mounted provider instance identifier at a configuration boundary. */
export function providerInstanceId(value: string): ExternalAgentProviderInstanceId { return brand<string, 'ExternalAgentProviderInstanceId'>(value, 'provider instance id') }
/** Brand a full-access audit identifier at an interaction boundary. */
export function auditId(value: string): ExternalAgentAuditId { return brand<string, 'ExternalAgentAuditId'>(value, 'audit id') }
/** Brand a model identifier at a configuration boundary. */
export function modelId(value: string): ExternalAgentModelId {
  if (value.includes('/')) throw new TypeError('model id must not contain /')
  return brand<string, 'ExternalAgentModelId'>(value, 'model id')
}
/** Brand a session identifier at a persistence boundary. */
export function sessionId(value: string): ExternalAgentSessionId { return brand<string, 'ExternalAgentSessionId'>(value, 'session id') }
/** Brand a turn identifier at a request boundary. */
export function turnId(value: string): ExternalAgentTurnId { return brand<string, 'ExternalAgentTurnId'>(value, 'turn id') }
/** Brand a subagent job identifier at a request boundary. */
export function jobId(value: string): ExternalAgentJobId { return brand<string, 'ExternalAgentJobId'>(value, 'job id') }
/** Brand a provider tool-call identifier at a wire boundary.
 * @param value - non-empty native tool identifier.
 * @returns the branded identifier.
 */
export function toolId(value: string): ExternalAgentToolId { return brand<string, 'ExternalAgentToolId'>(value, 'tool id') }
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
/** Answers to one native question. `answers` stays flattened selected labels plus custom text for existing consumers. */
export interface ExternalAgentUserInputAnswers {
  readonly answers: readonly string[]
  /** Host Other/free-text value. Provenance is typed custom, not a selected option, even when the text collides with an option label or native option id. */
  readonly custom?: string
}

/** File location associated with native tool activity. */
export interface ExternalAgentToolLocation { readonly path: string; readonly line?: number }

/** Authoritative native trajectory relationships; absent relationships are never inferred from tool names. */
export interface ExternalAgentOwnership {
  readonly trajectoryId: string
  readonly parentTrajectoryId?: string
  readonly depth?: number
}

/** Normalized activity visible to DSH; tool activity is never re-executed by DSH. */
export type ExternalAgentEvent =
  | { readonly type: 'assistant-delta'; readonly text: string; readonly ownership?: ExternalAgentOwnership }
  | { readonly type: 'thought-delta'; readonly text: string; readonly ownership?: ExternalAgentOwnership }
  | { readonly type: 'tool-activity'; readonly toolId: ExternalAgentToolId; readonly name: string; readonly nameMissing?: boolean; readonly ownership?: ExternalAgentOwnership; readonly status: 'pending' | 'running' | 'completed' | 'failed'; readonly input?: string; readonly output?: string; readonly error?: string; readonly locations?: readonly ExternalAgentToolLocation[] }
  | { readonly type: 'plan-update'; readonly summary: string; readonly steps: readonly string[] }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; readonly reasoningTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number }
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
  readonly fullAccessAuditId?: ExternalAgentAuditId
  readonly workspaceRoot?: string
  readonly attachmentRoots?: readonly string[]
  readonly clientFilesystem?: ExternalAgentFilesystem
  readonly signal?: AbortSignal
}
/** One user turn submitted to a native session. */
export interface ExternalAgentTurnRequest {
  readonly turn: ExternalAgentTurnId
  readonly prompt: string
  /** Exact native model selected for this turn; omitted only when retaining the open model. */
  readonly model?: ExternalAgentModelId
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
export interface ExternalAgentTurnHost extends ExternalAgentTurnHostCallbacks {
  readonly signal?: AbortSignal
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
  readonly auditId?: ExternalAgentAuditId
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
