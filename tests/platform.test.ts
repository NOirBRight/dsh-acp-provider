import { describe, expect, it } from 'vitest'
import {
  BoundedEventLog,
  DuplicateProviderError,
  ExternalAgentProviderRegistry,
  FullAccessConfirmationError,
  HostExpiredError,
  RouteResolutionError,
  TurnAbortedError,
  UnscopedAllowAlwaysError,
  UnsupportedModeError,
  boundExternalAgentEvent,
  createExternalAgentTurnHost,
  createSessionModelRoute,
  jobId,
  offersAllowAlways,
  optionId,
  outcomeForOption,
  parseRouteSpecifier,
  providerId,
  resumeCursor,
  sessionId,
  turnId,
  withBoundedExternalAgentHost,
  type ExternalAgentEvent,
  type ExternalAgentOpenRequest,
  type ExternalAgentPermissionDecision,
  type ExternalAgentPermissionRequest,
} from '../src/index.js'
import { FakeExternalAgentProvider, fakePermissionRequest } from '../src/fake.js'
import { ExternalAgentPrimaryConsumer, ExternalAgentSubagentConsumer, type ExternalAgentConsumerEvent } from '../src/consumers.js'
import { ExternalAgentSettingsEditorRegistry, ExternalAgentSettingsEditorUnavailableError, ExternalAgentSettingsPageModel, MemoryExternalAgentSettingsStore } from '../src/settings.js'
import { ExternalAgentFilesystemPolicyError, createExternalAgentFilesystemHandler, type ExternalAgentFilesystemResolver } from '../src/filesystem.js'

const modes = ['approval-required', 'auto-accept-edits', 'full-access'] as const
function route(provider: string, model = 'coder') { return createSessionModelRoute('external-agent', provider, model) }
function openRequest(provider: string, mode: (typeof modes)[number] = 'approval-required'): ExternalAgentOpenRequest { return { route: route(provider), session: sessionId('session-1'), permissionMode: mode } }
function host(decision: ExternalAgentPermissionDecision = { kind: 'allow-once', optionId: optionId('allow-once') }) {
  return { publish: (): void => undefined, requestPermission: async (): Promise<ExternalAgentPermissionDecision> => decision, requestUserInput: async () => ({ answers: ['answer'] }) }
}

describe('external-agent platform', () => {
  it('parses explicit LLM and external routes without fallback', () => {
    expect(parseRouteSpecifier('llm:gpt')).toEqual({ kind: 'llm', model: 'gpt' })
    expect(parseRouteSpecifier('external-agent:acme/coder')).toEqual(route('acme'))
    expect(() => parseRouteSpecifier('llm:')).toThrow(RouteResolutionError)
    expect(() => parseRouteSpecifier('external-agent:acme/coder/extra')).toThrow(RouteResolutionError)
    expect(() => parseRouteSpecifier('coder')).toThrow(RouteResolutionError)
  })

  it('registers exact providers and removes only its own row', async () => {
    const provider = new FakeExternalAgentProvider('acme', [{ id: 'coder', supportedModes: modes }])
    const registry = new ExternalAgentProviderRegistry()
    const remove = registry.register(provider)
    expect(() => registry.register(provider)).toThrow(DuplicateProviderError)
    await expect(registry.resolveExternalRoute('acme', 'missing')).rejects.toThrow(RouteResolutionError)
    expect(registry.get('acme')).toBe(provider)
    await remove()
    expect(registry.has('acme')).toBe(false)
    expect(registry.names()).toEqual([])
    expect(registry.has('')).toBe(false)
    expect(registry.get('')).toBeUndefined()
  })

  it('releases a disposed session from registry ownership', async () => {
    let disposeCalls = 0
    const provider = {
      info: { id: providerId('tracked'), name: 'Tracked' },
      listModels: async () => [{ id: route('tracked').model, name: 'Coder', supportedModes: modes }],
      openSession: async () => ({
        ref: { provider: providerId('tracked'), session: sessionId('session-1') },
        supportedModes: modes,
        runTurn: async () => ({ status: 'completed' as const, text: '' }),
        dispose: async () => { disposeCalls += 1 },
      }),
    }
    const registry = new ExternalAgentProviderRegistry()
    const remove = registry.register(provider)
    const session = await registry.openSession(openRequest('tracked'))
    await session.dispose()
    await remove()
    expect(disposeCalls).toBe(1)
  })

  it('rejects unscoped allow-always outcomes by name', () => {
    expect(() => outcomeForOption({ optionId: optionId('native'), kind: 'allow_always', label: 'Always' })).toThrow(UnscopedAllowAlwaysError)
  })

  it('requires full-access confirmation and audits before a provider starts', async () => {
    const audit: unknown[] = []
    const registry = new ExternalAgentProviderRegistry({ auditFullAccess: entry => { audit.push(entry) } })
    const provider = new FakeExternalAgentProvider('secure', [{ id: 'coder', supportedModes: modes }], { auditFullAccess: () => undefined })
    registry.register(provider)
    await expect(registry.openSession(openRequest('secure', 'full-access'))).rejects.toThrow(FullAccessConfirmationError)
    expect(provider.listModelsCalls).toBe(0)
    const session = await registry.openSession({ ...openRequest('secure', 'full-access'), fullAccessConfirmed: true, fullAccessAuditId: 'audit-1' })
    expect(audit).toHaveLength(1)
    expect(provider.listModelsCalls).toBe(1)
    await session.dispose()
  })

  it('enforces mode support and maps only scoped allow-always options', async () => {
    const request = fakePermissionRequest('write')
    expect(offersAllowAlways(request.options)).toBe(true)
    expect(outcomeForOption(request.options[0])).toBe('allowed-once')
    expect(outcomeForOption(request.options[1])).toBe('allowed-for-session')
    const provider = new FakeExternalAgentProvider('limited', [{ id: 'coder', supportedModes: ['approval-required'] }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    await expect(registry.openSession(openRequest('limited', 'auto-accept-edits'))).rejects.toThrow(UnsupportedModeError)
  })

  it('expires hosts and rejects pending interactions on cancellation', async () => {
    const controller = new AbortController()
    const pending = createExternalAgentTurnHost(controller.signal, { publish: (): void => undefined, requestPermission: () => new Promise(() => undefined), requestUserInput: async () => ({ answers: [] }) })
    const waiting = pending.requestPermission(fakePermissionRequest())
    controller.abort()
    await expect(waiting).rejects.toThrow(TurnAbortedError)
    pending.expire()
    expect(() => pending.publish({ type: 'assistant-delta', text: 'late' })).toThrow(HostExpiredError)
  })

  it('runs scripted turns and rejects cross-provider cursors', async () => {
    const provider = new FakeExternalAgentProvider('fake', [{ id: 'coder', supportedModes: modes }], { scripts: [{ events: [{ type: 'assistant-delta', text: 'hello' }], permission: { request: fakePermissionRequest(), decision: { kind: 'allowed-for-session', optionId: optionId('allow-always-write') } }, result: { text: 'done' } }] })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const session = await registry.openSession(openRequest('fake'))
    const events: ExternalAgentEvent[] = []
    const result = await session.runTurn({ turn: turnId('turn-1'), prompt: 'go', permissionMode: 'approval-required', signal: new AbortController().signal }, { publish: event => { events.push(event) }, requestPermission: async request => ({ kind: 'allowed-for-session', optionId: request.options[1].optionId }), requestUserInput: async () => ({ answers: [] }) })
    expect(result.status).toBe('completed')
    expect(result.resumeCursor?.provider).toBe(provider.info.id)
    expect(events[0]).toEqual({ type: 'assistant-delta', text: 'hello' })
    await expect(provider.openSession({ ...openRequest('fake'), resumeCursor: resumeCursor('other', 'private') })).rejects.toThrow(/another provider/)
    await session.dispose()
  })

  it('cancels an in-flight session during registry disposal', async () => {
    const provider = new FakeExternalAgentProvider('slow', [{ id: 'coder', supportedModes: modes }], { scripts: [{ permission: { request: fakePermissionRequest() } }] })
    const registry = new ExternalAgentProviderRegistry()
    const remove = registry.register(provider)
    const session = await registry.openSession(openRequest('slow'))
    const running = session.runTurn({ turn: turnId('turn-slow'), prompt: 'wait', permissionMode: 'approval-required', signal: new AbortController().signal }, { publish: (): void => undefined, requestPermission: () => new Promise(() => undefined), requestUserInput: async () => ({ answers: [] }) })
    await remove()
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    expect(registry.has('slow')).toBe(false)
  })

  it('bounds complete event and interaction payloads', async () => {
    expect(() => new BoundedEventLog({ maxEvents: 0 })).toThrow(/maxEvents/)
    expect(() => new BoundedEventLog({ maxTextBytes: -1 })).toThrow(/maxTextBytes/)
    expect(() => new BoundedEventLog({ maxPayloadBytes: 0 })).toThrow(/maxPayloadBytes/)
    const event = boundExternalAgentEvent({ type: 'tool-activity', toolId: '工具'.repeat(20), name: 'x'.repeat(100), status: 'completed', input: '😀'.repeat(100) }, { maxTextBytes: 64, maxPayloadBytes: 160 })
    expect(new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeLessThanOrEqual(160)
    const seen: string[] = []
    const bounded = withBoundedExternalAgentHost({ publish: (): void => undefined, requestPermission: async request => { seen.push(request.reason); return { kind: 'allow-once', optionId: request.options[0].optionId } }, requestUserInput: async () => ({ answers: [] }) }, { maxTextBytes: 8, maxPayloadBytes: 512 })
    await bounded.requestPermission({ ...fakePermissionRequest(), reason: 'r'.repeat(100) })
    expect(seen[0]).toBe('r'.repeat(8))
    expect(() => boundExternalAgentEvent({ type: 'usage', inputTokens: 1, outputTokens: 2 }, { maxTextBytes: 0, maxPayloadBytes: 1 })).toThrow(RangeError)
  })

  it('switches primary routes and folds pending/committed interaction events', async () => {
    const first = new FakeExternalAgentProvider('one', [{ id: 'coder', supportedModes: modes }], { scripts: [{ permission: { request: fakePermissionRequest() }, result: { text: 'one' } }] })
    const second = new FakeExternalAgentProvider('two', [{ id: 'coder', supportedModes: modes }], { scripts: [{ result: { text: 'two' } }] })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(first); registry.register(second)
    const consumer = new ExternalAgentPrimaryConsumer(registry)
    const sessionEvents: string[] = []
    const request = (provider: string, turn: string) => ({ session: sessionId('primary'), route: route(provider), turn: turnId(turn), prompt: 'go', permissionMode: 'approval-required' as const, signal: new AbortController().signal, host: { publish: (): void => undefined, requestPermission: async (req: ExternalAgentPermissionRequest) => ({ kind: 'allow-once' as const, optionId: req.options[0].optionId }), requestUserInput: async () => ({ answers: [] }) }, onSessionEvent: (event: ExternalAgentConsumerEvent) => { sessionEvents.push(event.type) } })
    expect((await consumer.runTurn(request('one', 't1'))).text).toBe('one')
    expect((await consumer.runTurn(request('two', 't2'))).text).toBe('two')
    expect(sessionEvents).toEqual(expect.arrayContaining(['permission-pending', 'permission-committed', 'turn-finished']))
    await consumer.dispose()
  })

  it('rejects a concurrent turn while the first turn is preparing', async () => {
    const provider = new FakeExternalAgentProvider('serial', [{ id: 'coder', supportedModes: modes }], { scripts: [{ result: { text: 'done' } }] })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const consumer = new ExternalAgentPrimaryConsumer(registry)
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const request = { session: sessionId('serial'), route: route('serial'), prompt: 'go', permissionMode: 'approval-required' as const, signal: new AbortController().signal, host: host(), onSessionEvent: async (event: ExternalAgentConsumerEvent) => { if (event.type === 'route-selected') { entered(); await gate } } }
    const first = consumer.runTurn(request)
    await preparing
    await expect(consumer.runTurn(request)).rejects.toThrow(/preparing/)
    release()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    await consumer.dispose()
  })

  it('waits for in-flight primary preparation during disposal', async () => {
    const provider = new FakeExternalAgentProvider('disposing', [{ id: 'coder', supportedModes: modes }])
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const consumer = new ExternalAgentPrimaryConsumer(registry)
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const turn = consumer.runTurn({ session: sessionId('disposing'), route: route('disposing'), prompt: 'go', permissionMode: 'approval-required', signal: new AbortController().signal, host: host(), onSessionEvent: async event => { if (event.type === 'route-selected') { entered(); await gate } } })
    await preparing
    const disposal = consumer.dispose()
    release()
    await expect(disposal).resolves.toBeUndefined()
    await expect(turn).rejects.toThrow(/disposed/)
    expect(provider.listModelsCalls).toBe(0)
  })

  it('disposes subagent sessions for foreground and background runs', async () => {
    const provider = new FakeExternalAgentProvider('worker', [{ id: 'coder', supportedModes: modes }], { scripts: [{ events: [{ type: 'assistant-delta', text: 'working' }], result: { text: 'foreground' } }, { result: { text: 'background' } }] })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const consumer = new ExternalAgentSubagentConsumer(registry)
    const events: string[] = []
    const base = { parentSession: sessionId('parent'), route: route('worker'), prompt: 'work', permissionMode: 'approval-required' as const, host: host(), jobId: jobId('job-1'), onSessionEvent: (event: ExternalAgentConsumerEvent) => { events.push(event.type) } }
    expect((await consumer.runForeground(base)).text).toBe('foreground')
    const job = consumer.startBackground({ ...base, jobId: jobId('job-2') })
    expect((await job.result).text).toBe('background')
    expect(events).toEqual(expect.arrayContaining(['route-selected', 'turn-started', 'activity', 'turn-finished', 'subagent-result']))
    await consumer.dispose()
  })

  it('closes switched primary sessions and reopens with the route cursor', async () => {
    const provider = new FakeExternalAgentProvider('cursor', [{ id: 'coder', supportedModes: modes }, { id: 'reviewer', supportedModes: modes }], { scripts: [{ result: { text: 'coder' } }, { result: { text: 'reviewer' } }, { result: { text: 'resumed' } }] })
    const opened: ExternalAgentOpenRequest[] = []
    let disposed = 0
    const originalOpen = provider.openSession.bind(provider)
    provider.openSession = async request => {
      opened.push(request)
      const session = await originalOpen(request)
      return { ref: session.ref, supportedModes: session.supportedModes, runTurn: session.runTurn.bind(session), dispose: async () => { disposed += 1; await session.dispose() } }
    }
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const consumer = new ExternalAgentPrimaryConsumer(registry)
    const makeRequest = (model: string, turn: string) => ({ session: sessionId('primary-cursor'), route: route('cursor', model), turn: turnId(turn), prompt: 'go', permissionMode: 'approval-required' as const, signal: new AbortController().signal, host: host() })
    await consumer.runTurn(makeRequest('coder', 'one'))
    await consumer.selectRoute(route('cursor', 'reviewer'))
    expect(disposed).toBe(1)
    await consumer.runTurn(makeRequest('reviewer', 'two'))
    await consumer.selectRoute(route('cursor', 'coder'))
    expect(disposed).toBe(2)
    await consumer.runTurn(makeRequest('coder', 'three'))
    expect(opened).toHaveLength(3)
    expect(opened[2].resumeCursor?.value).toBe('fake-native-1')
    await consumer.dispose()
  })

  it('cancels and awaits an active background child during disposal', async () => {
    const provider = new FakeExternalAgentProvider('slow-worker', [{ id: 'coder', supportedModes: modes }], { scripts: [{ delayMs: 20, result: { text: 'late' } }] })
    const registry = new ExternalAgentProviderRegistry()
    registry.register(provider)
    const consumer = new ExternalAgentSubagentConsumer(registry)
    const job = consumer.startBackground({ jobId: jobId('slow-job'), parentSession: sessionId('parent'), route: route('slow-worker'), prompt: 'wait', permissionMode: 'approval-required', host: host() })
    await consumer.dispose()
    await expect(job.result).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('joins Settings rows and reports unloaded editors', async () => {
    const store = new MemoryExternalAgentSettingsStore()
    const provider = providerId('settings-provider')
    await store.saveDirectory({ provider, instanceId: 'a', displayName: 'A' })
    store.seed({ provider, instanceId: 'a', values: { executable: '/bin/agy' } }, { provider, instanceId: 'a', authenticated: true, accountLabel: 'account' })
    const editors = new ExternalAgentSettingsEditorRegistry()
    const dispose = editors.register({ provider, instanceId: 'a', snapshot: () => ({ provider, instanceId: 'a', title: 'A', status: { installed: true, authenticated: true, live: true, ready: true }, fields: [], actions: [] }), run: async () => 'ok' })
    const page = new ExternalAgentSettingsPageModel(store, editors)
    expect(page.snapshot().rows[0].credentials?.authenticated).toBe(true)
    dispose()
    expect(page.snapshot().rows[0].editor).toBeUndefined()
    await expect(page.runAction(provider, 'a', 'refresh-models')).rejects.toThrow(ExternalAgentSettingsEditorUnavailableError)
  })

  it('mediates roots, symlink escapes and attachment writes', async () => {
    const policy = { workspaceRoots: ['/workspace'], attachmentRoots: ['/attachments'], readTextFile: async (path: string) => path, writeTextFile: async () => undefined }
    const resolver: ExternalAgentFilesystemResolver = { realpath: async path => path === '/workspace/link' ? '/etc/passwd' : path }
    const handler = createExternalAgentFilesystemHandler(policy, resolver)
    await expect(handler('fs/read_text_file', { path: '/workspace/src/a.ts' })).resolves.toBe('/workspace/src/a.ts')
    await expect(handler('fs/read_text_file', { path: '/workspace/link' })).rejects.toThrow(ExternalAgentFilesystemPolicyError)
    await expect(handler('fs/write_text_file', { path: '/attachments/a.txt', content: 'x' })).rejects.toThrow(ExternalAgentFilesystemPolicyError)
    await expect(handler('terminal/create', {})).rejects.toThrow(ExternalAgentFilesystemPolicyError)
  })

  it('drops oldest bounded events and preserves multibyte boundaries', () => {
    const log = new BoundedEventLog({ maxEvents: 2, maxTextBytes: 5, maxPayloadBytes: 256 })
    log.push({ type: 'assistant-delta', text: '😀😀😀' })
    log.push({ type: 'assistant-delta', text: 'two' })
    log.push({ type: 'assistant-delta', text: 'three' })
    expect(log.events()).toHaveLength(2)
    expect(log.events()[0]).toEqual({ type: 'assistant-delta', text: 'two' })
    expect(log.droppedCount).toBe(1)
  })
})
