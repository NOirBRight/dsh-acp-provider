/** Deterministic provider/session test double for the public External Agent seam. */
import {
  ManagedExternalAgentSession,
  modelId,
  sessionId,
  optionId,
  providerId,
  resumeCursor,
  type ExternalAgentEvent,
  type ExternalAgentModel,
  type ExternalAgentOpenRequest,
  type ExternalAgentPermissionDecision,
  type ExternalAgentPermissionRequest,
  type ExternalAgentPermissionMode,
  type ExternalAgentProvider,
  type ExternalAgentProviderId,
  type ExternalAgentSession,
  type ExternalAgentSessionRef,
  type ExternalAgentTurnHost,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
  type ExternalAgentUserInputAnswers,
  type ExternalAgentUserInputRequest,
} from './index.js'

/** Model input accepted by the fake. */
export interface FakeExternalAgentModel {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly supportedModes: readonly ExternalAgentPermissionMode[]
}
/** One scripted permission exchange. */
export interface FakePermissionScript {
  readonly request: ExternalAgentPermissionRequest
  readonly decision?: ExternalAgentPermissionDecision
}
/** One scripted question exchange. */
export interface FakeQuestionScript {
  readonly request: ExternalAgentUserInputRequest
  readonly answer?: ExternalAgentUserInputAnswers
}
/** One deterministic native turn. */
export interface FakeExternalAgentScript {
  readonly events?: readonly ExternalAgentEvent[]
  readonly permission?: FakePermissionScript
  readonly question?: FakeQuestionScript
  readonly result?: Partial<ExternalAgentTurnResult>
  readonly error?: Error
  readonly delayMs?: number
}
/** Options for one fake provider instance. */
export interface FakeExternalAgentProviderOptions {
  readonly scripts?: readonly FakeExternalAgentScript[]
  readonly auditFullAccess?: (request: ExternalAgentOpenRequest) => void | Promise<void>
}

class FakeSession implements ExternalAgentSession {
  readonly ref: ExternalAgentSessionRef
  readonly supportedModes: readonly ExternalAgentPermissionMode[]
  private disposed = false
  private readonly script: () => FakeExternalAgentScript
  constructor(provider: ExternalAgentProviderId, request: ExternalAgentOpenRequest, model: ExternalAgentModel, native: string, script: () => FakeExternalAgentScript) {
    this.ref = { provider, session: request.session, nativeSession: sessionId(native), resumeCursor: resumeCursor(provider, native) }
    this.supportedModes = model.supportedModes
    this.script = script
  }
  get isDisposed(): boolean { return this.disposed }
  async runTurn(request: ExternalAgentTurnRequest, host: ExternalAgentTurnHost): Promise<ExternalAgentTurnResult> {
    const script = this.script()
    if (request.signal.aborted) return { status: 'cancelled', text: '', nativeSessionId: this.ref.nativeSession }
    if (script.delayMs !== undefined) {
      await new Promise<void>(resolve => setTimeout(resolve, script.delayMs))
      if (request.signal.aborted) return { status: 'cancelled', text: '', nativeSessionId: this.ref.nativeSession }
    }
    for (const event of script.events ?? []) await host.publish(event)
    if (script.permission !== undefined) {
      const decision = script.permission.decision === undefined ? await host.requestPermission(script.permission.request) : script.permission.decision
      if (decision.kind === 'reject' || decision.kind === 'cancel' || decision.kind === 'unavailable') return { status: decision.kind === 'cancel' || decision.kind === 'unavailable' ? 'cancelled' : 'failed', text: '', nativeSessionId: this.ref.nativeSession, error: decision.kind }
    }
    if (script.question !== undefined) await host.requestUserInput(script.question.request)
    if (script.error !== undefined) throw script.error
    const result = script.result ?? {}
    const status = result.status ?? 'completed'
    return {
      status,
      text: result.text ?? '',
      nativeSessionId: this.ref.nativeSession,
      resumeCursor: result.resumeCursor ?? this.ref.resumeCursor,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }
  async dispose(): Promise<void> { this.disposed = true }
}

/**
 * Scriptable provider that validates exact route/model/mode choices and queues
 * one independent script per native turn.
 */
export class FakeExternalAgentProvider implements ExternalAgentProvider {
  readonly info: { readonly id: ExternalAgentProviderId; readonly name: string; readonly description: string }
  private readonly models: readonly ExternalAgentModel[]
  private readonly scripts: FakeExternalAgentScript[]
  private readonly sessions = new Set<ExternalAgentSession>()
  private sequence = 0
  listModelsCalls = 0
  private readonly options: FakeExternalAgentProviderOptions
  constructor(name: string, models: readonly FakeExternalAgentModel[], options: FakeExternalAgentProviderOptions = {}) {
    this.info = { id: providerId(name), name, description: 'Deterministic External Agent test provider' }
    this.models = models.map(model => ({ id: modelId(model.id), name: model.name ?? model.id, ...(model.description === undefined ? {} : { description: model.description }), supportedModes: [...model.supportedModes] }))
    this.scripts = [...options.scripts ?? []]
    this.options = options
  }
  /** Models advertised by this exact fake provider. */
  async listModels(signal?: AbortSignal): Promise<readonly ExternalAgentModel[]> {
    this.listModelsCalls += 1
    if (signal?.aborted) return []
    return this.models
  }
  /** Add a script consumed by the next opened session turn. */
  enqueue(script: FakeExternalAgentScript): void { this.scripts.push(script) }
  /** Open an exact model and return a managed session. */
  async openSession(request: ExternalAgentOpenRequest): Promise<ExternalAgentSession> {
    if (request.route.kind !== 'external-agent' || request.route.provider !== this.info.id) throw new Error('fake provider received another route')
    const model = this.models.find(candidate => candidate.id === request.route.model)
    if (model === undefined) throw new Error('fake model is unavailable: ' + request.route.model)
    if (!model.supportedModes.includes(request.permissionMode)) throw new Error('fake mode is unavailable: ' + request.permissionMode)
    if (request.permissionMode === 'full-access') {
      if (request.fullAccessConfirmed !== true) throw new Error('fake full-access requires explicit confirmation')
      if (this.options.auditFullAccess === undefined) throw new Error('fake full-access requires an audit callback')
      await this.options.auditFullAccess(request)
    }
    if (request.resumeCursor !== undefined && request.resumeCursor.provider !== this.info.id) throw new Error('fake resume cursor belongs to another provider')
    const native = 'fake-native-' + String(++this.sequence)
    const inner = new FakeSession(this.info.id, request, model, native, () => this.scripts.shift() ?? {})
    const session = new ManagedExternalAgentSession(inner)
    this.sessions.add(session)
    return session
  }
  /** Dispose every session created by this provider. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions].map(session => session.dispose().catch(() => undefined)))
    this.sessions.clear()
  }
}

/** Build a permission request with a unique native option id for fake tests. */
export function fakePermissionRequest(toolName = 'write'): ExternalAgentPermissionRequest {
  return {
    requestId: optionId('request-' + toolName),
    toolName,
    reason: 'fake provider requests permission',
    options: [
      { optionId: optionId('allow-once-' + toolName), kind: 'allow_once', label: 'Allow once' },
      { optionId: optionId('allow-always-' + toolName), kind: 'allow_always', label: 'Allow for this session', scope: 'session' },
      { optionId: optionId('reject-' + toolName), kind: 'reject', label: 'Reject' },
    ],
  }
}
