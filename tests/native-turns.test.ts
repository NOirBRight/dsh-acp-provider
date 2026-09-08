/** Native turn-runner coverage over the real registry. */
import { describe, expect, it } from 'vitest'
import {
  createSessionModelRoute,
  modelId,
  optionId,
  providerId,
  resumeCursor,
  sessionId,
  turnId,
  type ExternalAgentModel,
  type ExternalAgentOpenRequest,
  type ExternalAgentPermissionMode,
  type ExternalAgentProvider,
  type ExternalAgentSession,
  type ExternalAgentSessionId,
  type ExternalAgentSessionRef,
  type ExternalAgentTurnHostCallbacks,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResult,
} from '../src/index.js'
import { ExternalAgentProviderRegistry } from '../src/runtime.js'
import { ExternalAgentTurnRunner } from '../src/turns.js'

const modes: readonly ExternalAgentPermissionMode[] = ['approval-required', 'auto-accept-edits', 'full-access']
function route(provider: string, model = 'coder') { return createSessionModelRoute('external-agent', provider, model) }
function host(): ExternalAgentTurnHostCallbacks {
  return { publish: (): void => undefined, requestPermission: async () => ({ kind: 'allow-once', optionId: optionId('x') }), requestUserInput: async () => ({ answers: [] }) }
}
let turnSeq = 0
function openRequest(session: string, provider = 'mini', model = 'coder', extra: Partial<ExternalAgentOpenRequest> = {}): ExternalAgentOpenRequest {
  return { route: route(provider, model), session: sessionId(session), permissionMode: 'approval-required', ...extra }
}
function turnRequest(prompt = 'go', extra: Partial<ExternalAgentTurnRequest> = {}): ExternalAgentTurnRequest {
  turnSeq += 1
  return { turn: turnId('t-' + String(turnSeq)), prompt, permissionMode: 'approval-required', signal: new AbortController().signal, ...extra }
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(new DOMException('The operation was aborted', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
interface MiniScript { readonly result?: Partial<ExternalAgentTurnResult>; readonly error?: Error }
class MiniProvider implements ExternalAgentProvider {
  readonly info: { readonly id: ReturnType<typeof providerId>; readonly name: string; readonly description: string }
  readonly opens: ExternalAgentOpenRequest[] = []
  readonly turns: ExternalAgentTurnRequest[] = []
  disposedSessions = 0
  private seq = 0
  constructor(name: string, private readonly models: readonly ExternalAgentModel[], private readonly scripts: MiniScript[] = [], private readonly openDelayMs = 0, private readonly turnDelayMs = 0) {
    this.info = { id: providerId(name), name, description: 'mini' }
  }
  async listModels(signal?: AbortSignal): Promise<readonly ExternalAgentModel[]> {
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    return this.models
  }
  async openSession(request: ExternalAgentOpenRequest): Promise<ExternalAgentSession> {
    this.opens.push(request)
    if (request.resumeCursor !== undefined && request.resumeCursor.provider !== this.info.id) throw new Error('fake resume cursor belongs to another provider')
    if (this.openDelayMs > 0) await sleep(this.openDelayMs, request.signal)
    if (request.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    const value = request.resumeCursor?.value ?? 'native-' + String(++this.seq)
    const ref: ExternalAgentSessionRef = { provider: this.info.id, session: request.session, nativeSession: sessionId(value), resumeCursor: resumeCursor(this.info.id, value) }
    const provider = this
    return {
      ref,
      supportedModes: modes,
      async runTurn(turn: ExternalAgentTurnRequest, _host: unknown): Promise<ExternalAgentTurnResult> {
        provider.turns.push(turn)
        if (turn.signal.aborted) return { status: 'cancelled', text: '' }
        if (provider.turnDelayMs > 0) await sleep(provider.turnDelayMs, turn.signal).catch(() => undefined)
        if (turn.signal.aborted) return { status: 'cancelled', text: '' }
        const script = provider.scripts.shift() ?? {}
        if (script.error !== undefined) throw script.error
        const partial = script.result ?? {}
        const native = partial.nativeSessionId ?? ref.nativeSession
        const cursor = partial.resumeCursor ?? ref.resumeCursor
        return { status: partial.status ?? 'completed', text: partial.text ?? 'ok', ...(native === undefined ? {} : { nativeSession: native }), ...(cursor === undefined ? {} : { resumeCursor: cursor }), ...(partial.error === undefined ? {} : { error: partial.error }) }
      },
      async dispose(): Promise<void> { provider.disposedSessions += 1 },
    }
  }
}
function mini(name = 'mini', scripts: MiniScript[] = [], openDelayMs = 0, turnDelayMs = 0): MiniProvider {
  return new MiniProvider(name, [{ id: modelId('coder'), name: 'Coder', supportedModes: modes }, { id: modelId('reviewer'), name: 'Reviewer', supportedModes: modes }], scripts, openDelayMs, turnDelayMs)
}
function memoryStore(initial?: Map<string, ExternalAgentSessionRef>): { map: Map<string, ExternalAgentSessionRef>; load: (id: ExternalAgentSessionId) => ExternalAgentSessionRef | undefined; save: (ref: ExternalAgentSessionRef) => void } {
  const map = initial ?? new Map<string, ExternalAgentSessionRef>()
  return { map, load: (id: ExternalAgentSessionId) => map.get(String(id)), save: (ref: ExternalAgentSessionRef) => { map.set(String(ref.session), ref) } }
}

describe('native turns', () => {
  it('reserves the slot before invoking a reentrant binding loader', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    let attempted: Promise<unknown> | undefined
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: () => {
      attempted = runner.runTurn(openRequest('reentrant'), turnRequest(), host()).catch(error => error)
      return undefined
    } })
    await runner.runTurn(openRequest('reentrant'), turnRequest(), host())
    expect(await attempted).toBeInstanceOf(Error)
    expect(provider.opens).toHaveLength(1)
    await runner.dispose()
  })
  it('rejects permission disagreement and unadvertised models before prompting', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    await expect(runner.runTurn(openRequest('mode'), turnRequest('go', { permissionMode: 'full-access' }), host())).rejects.toThrow('must agree')
    expect(provider.opens).toHaveLength(0)
    await runner.runTurn(openRequest('mode'), turnRequest(), host())
    await expect(runner.runTurn(openRequest('mode', 'mini', 'unadvertised'), turnRequest(), host())).rejects.toThrow('model is unavailable')
    expect(provider.turns).toHaveLength(1)
    await runner.dispose()
  })
  it('fails closed without leaving a releasing slot after a single-session teardown error', async () => {
    const provider = mini()
    const open = provider.openSession.bind(provider)
    provider.openSession = async request => ({ ...await open(request), dispose: async () => { throw new Error('still alive') } })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    await runner.runTurn(openRequest('cleanup'), turnRequest(), host())
    await expect(runner.release(sessionId('cleanup'))).rejects.toThrow('cleanup failed')
    await expect(runner.release(sessionId('cleanup'))).rejects.toThrow('cleanup failed')
    await expect(runner.runTurn(openRequest('cleanup'), turnRequest(), host())).rejects.toThrow('cleanup failed')
  })
  it('reports teardown failure instead of reopening after a partial reset', async () => {
    const provider = mini()
    const open = provider.openSession.bind(provider)
    provider.openSession = async request => ({ ...await open(request), dispose: async () => { throw new Error('still alive') } })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    await runner.runTurn(openRequest('cleanup'), turnRequest(), host())
    await expect(runner.reset()).rejects.toThrow('cleanup failed')
    await expect(runner.runTurn(openRequest('another'), turnRequest(), host())).rejects.toThrow('cleanup failed')
  })
  it('forwards the open route model into every turn and reuses the session', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const store = memoryStore()
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: store.load, saveSession: store.save })
    await runner.runTurn(openRequest('s1'), turnRequest(), host())
    await runner.runTurn(openRequest('s1', 'mini', 'reviewer'), turnRequest(), host())
    expect(provider.opens).toHaveLength(1)
    expect(provider.turns).toHaveLength(2)
    expect(String(provider.turns[0].model)).toBe('coder')
    expect(String(provider.turns[1].model)).toBe('reviewer')
    await runner.dispose()
  })
  it('resumes from a persisted binding without a second open', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const seeded = new Map<string, ExternalAgentSessionRef>([['s2', { provider: providerId('mini'), session: sessionId('s2'), nativeSession: sessionId('native-9'), resumeCursor: resumeCursor('mini', 'native-9') }]])
    const store = memoryStore(seeded)
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: store.load, saveSession: store.save })
    await runner.runTurn(openRequest('s2'), turnRequest(), host())
    expect(provider.opens).toHaveLength(1)
    expect(provider.opens[0].resumeCursor?.value).toBe('native-9')
    await runner.runTurn(openRequest('s2'), turnRequest(), host())
    expect(provider.opens).toHaveLength(1)
    await runner.dispose()
  })
  it('fails closed when a binding has no resume cursor', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const seeded = new Map<string, ExternalAgentSessionRef>([['s3', { provider: providerId('mini'), session: sessionId('s3') }]])
    const store = memoryStore(seeded)
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: store.load, saveSession: store.save })
    await expect(runner.runTurn(openRequest('s3'), turnRequest(), host())).rejects.toThrow(/resume cursor/)
    expect(provider.opens).toHaveLength(0)
    await runner.dispose()
  })
  it('disposes a new session when the pre-turn save fails', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry, { saveSession: () => { throw new Error('persist down') } })
    await expect(runner.runTurn(openRequest('s4'), turnRequest(), host())).rejects.toThrow('persist down')
    expect(provider.opens).toHaveLength(1)
    expect(provider.turns).toHaveLength(0)
    expect(provider.disposedSessions).toBe(1)
    await runner.dispose()
  })
  it('returns failed results verbatim', async () => {
    const provider = mini('mini', [{ result: { status: 'failed', text: 'oops', error: 'boom' } }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    const result = await runner.runTurn(openRequest('s5'), turnRequest(), host())
    expect(result).toMatchObject({ status: 'failed', text: 'oops', error: 'boom' })
    await runner.dispose()
  })
  it('disposes and reopens when the provider object changes', async () => {
    const first = mini('swap')
    const registry = new ExternalAgentProviderRegistry()
    const removeFirst = registry.register(first)
    const store = memoryStore()
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: store.load, saveSession: store.save })
    await runner.runTurn(openRequest('s6', 'swap'), turnRequest(), host())
    await removeFirst()
    const second = mini('swap')
    registry.register(second)
    await runner.runTurn(openRequest('s6', 'swap'), turnRequest(), host())
    expect(first.disposedSessions).toBe(1)
    expect(second.opens).toHaveLength(1)
    expect(second.opens[0].resumeCursor?.value).toBe('native-1')
    await runner.dispose()
  })
  it('rejects concurrent turns for one session', async () => {
    const provider = mini('mini', [], 0, 30)
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    const first = runner.runTurn(openRequest('s7'), turnRequest(), host())
    await expect(runner.runTurn(openRequest('s7'), turnRequest(), host())).rejects.toThrow(/already active/)
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    await runner.dispose()
  })
  it('reset cancels an opening turn without leaking the session', async () => {
    const provider = mini('mini', [], 30, 0)
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    const pending = runner.runTurn(openRequest('s8'), turnRequest(), host())
    await sleep(5)
    await runner.reset()
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    await expect(runner.runTurn(openRequest('s8'), turnRequest(), host())).resolves.toMatchObject({ status: 'completed' })
    expect(provider.opens).toHaveLength(2)
    await runner.dispose()
  })
  it('dispose cancels an active turn and stays closed', async () => {
    const provider = mini('mini', [], 0, 40)
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    const pending = runner.runTurn(openRequest('s9'), turnRequest(), host())
    await sleep(10)
    const disposal = runner.dispose()
    expect(runner.dispose()).toBe(disposal)
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    await disposal
    await expect(runner.runTurn(openRequest('s9'), turnRequest(), host())).rejects.toThrow(/disposed/)
  })
  it('passes caller aborts through without retrying the turn', async () => {
    const provider = mini('mini', [], 0, 40)
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    const controller = new AbortController()
    const pending = runner.runTurn(openRequest('s10'), turnRequest('go', { signal: controller.signal }), host())
    await sleep(10)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(provider.turns).toHaveLength(1)
    await runner.dispose()
  })
  it('release frees one session only', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    await runner.runTurn(openRequest('a'), turnRequest(), host())
    await runner.runTurn(openRequest('b'), turnRequest(), host())
    expect(provider.opens).toHaveLength(2)
    await runner.release(sessionId('a'))
    await runner.runTurn(openRequest('a'), turnRequest(), host())
    await runner.runTurn(openRequest('b'), turnRequest(), host())
    expect(provider.opens).toHaveLength(3)
    await runner.dispose()
  })
  it('rejects provider and workspace swaps for a bound session', async () => {
    const a = mini('a')
    const b = mini('b')
    const registry = new ExternalAgentProviderRegistry()
    registry.register(a)
    registry.register(b)
    const runner = new ExternalAgentTurnRunner(registry)
    await runner.runTurn({ ...openRequest('s11', 'a'), workspaceRoot: '/a' }, turnRequest(), host())
    await expect(runner.runTurn(openRequest('s11', 'b'), turnRequest(), host())).rejects.toThrow(/another provider/)
    await expect(runner.runTurn({ ...openRequest('s11', 'a'), workspaceRoot: '/b' }, turnRequest(), host())).rejects.toThrow(/another workspace/)
    expect(b.opens).toHaveLength(0)
    await runner.dispose()
  })
  it('audits full access once per open and again per reused turn', async () => {
    let audits = 0
    const registry = new ExternalAgentProviderRegistry({ auditFullAccess: () => { audits += 1 } })
    const provider = mini('secure')
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    await runner.runTurn({ ...openRequest('s12', 'secure'), permissionMode: 'full-access', fullAccessConfirmed: true }, turnRequest('go', { permissionMode: 'full-access' }), host())
    expect(audits).toBe(1)
    await runner.runTurn({ ...openRequest('s12', 'secure'), permissionMode: 'full-access', fullAccessConfirmed: true }, turnRequest('go', { permissionMode: 'full-access' }), host())
    expect(audits).toBe(2)
    expect(provider.opens).toHaveLength(1)
    await runner.dispose()
  })
  it('reopens with resume after a failed turn instead of caching a dead session', async () => {
    const provider = mini('mini', [{ result: { status: 'failed', text: 'oops', error: 'boom' } }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const store = memoryStore()
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: store.load, saveSession: store.save })
    const failed = await runner.runTurn(openRequest('s-fail'), turnRequest(), host())
    expect(failed.status).toBe('failed')
    expect(provider.disposedSessions).toBe(1)
    await runner.runTurn(openRequest('s-fail'), turnRequest(), host())
    expect(provider.opens).toHaveLength(2)
    expect(provider.opens[1].resumeCursor?.value).toBe('native-1')
    await runner.dispose()
  })
  it('releases the session but keeps the old cursor when a turn throws', async () => {
    const provider = mini('mini', [{ error: new Error('native failure') }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const store = memoryStore()
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: store.load, saveSession: store.save })
    await expect(runner.runTurn(openRequest('s-throw'), turnRequest(), host())).rejects.toThrow('native failure')
    expect(provider.disposedSessions).toBe(1)
    await runner.runTurn(openRequest('s-throw'), turnRequest(), host())
    expect(provider.opens).toHaveLength(2)
    expect(provider.opens[1].resumeCursor?.value).toBe('native-1')
    await runner.dispose()
  })
  it('fails the turn when the result-cursor save fails', async () => {
    const provider = mini('mini', [{ result: { resumeCursor: resumeCursor('mini', 'native-9') } }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    let calls = 0
    const runner = new ExternalAgentTurnRunner(registry, { saveSession: () => { calls += 1; if (calls > 1) throw new Error('cursor persist down') } })
    await expect(runner.runTurn(openRequest('s13'), turnRequest(), host())).rejects.toThrow('cursor persist down')
    expect(provider.turns).toHaveLength(1)
    expect(provider.disposedSessions).toBe(1)
    await runner.dispose()
  })
  it('retries the persistence load after a failure instead of opening around it', async () => {
    const provider = mini()
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    let loads = 0
    const runner = new ExternalAgentTurnRunner(registry, { loadSession: () => { loads += 1; if (loads <= 2) throw new Error('store corrupt'); return undefined } })
    await expect(runner.runTurn(openRequest('s-load'), turnRequest(), host())).rejects.toThrow('store corrupt')
    await expect(runner.runTurn(openRequest('s-load'), turnRequest(), host())).rejects.toThrow('store corrupt')
    expect(provider.opens).toHaveLength(0)
    expect(loads).toBe(2)
    await expect(runner.runTurn(openRequest('s-load'), turnRequest(), host())).resolves.toMatchObject({ status: 'completed' })
    expect(loads).toBe(3)
    expect(provider.opens).toHaveLength(1)
    await runner.dispose()
  })
  it('rejects new sessions while a reset is waiting', async () => {
    const provider = mini('mini', [], 30, 0)
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const runner = new ExternalAgentTurnRunner(registry)
    const pending = runner.runTurn(openRequest('s-reset'), turnRequest(), host())
    await sleep(5)
    const resetting = runner.reset()
    await expect(runner.runTurn(openRequest('s-new'), turnRequest(), host())).rejects.toThrow(/resetting/)
    await resetting
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    await expect(runner.runTurn(openRequest('s-new'), turnRequest(), host())).resolves.toMatchObject({ status: 'completed' })
    await runner.dispose()
  })
  it('only saves when the ref actually changes', async () => {
    const provider = mini('mini', [{}, {}, { result: { resumeCursor: resumeCursor('mini', 'native-9') } }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    let saves = 0
    const runner = new ExternalAgentTurnRunner(registry, { saveSession: () => { saves += 1 } })
    await runner.runTurn(openRequest('s-save'), turnRequest(), host())
    await runner.runTurn(openRequest('s-save'), turnRequest(), host())
    expect(saves).toBe(1)
    await runner.runTurn(openRequest('s-save'), turnRequest(), host())
    expect(saves).toBe(2)
    await runner.dispose()
  })
})
