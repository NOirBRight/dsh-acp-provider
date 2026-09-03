import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, probeBridgeHost, REQUIRED_HOST_PATHS } from '../lib/index.js';

/** Minimal in-memory BridgeHost: the fake the bridge mounts against. */
function fakeHost(overrides = {}) {
  const routes = new Map();
  const listeners = new Set();
  const events = new Map();
  let primary = undefined;
  const host = {
    directory: {
      register(route) {
        if (routes.has(route.id)) throw new Error('duplicate ' + route.id);
        routes.set(route.id, route);
        return () => { routes.delete(route.id); };
      },
      list() { return [...routes.values()]; },
    },
    drivers: {
      setPrimary(driver) {
        if (primary !== undefined) throw new Error('primary already set');
        primary = driver;
        return () => { primary = undefined; };
      },
    },
    sessions: {
      read(sessionId) { return events.get(sessionId) ?? []; },
      onEvent(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    interaction: {
      async requestApproval(request) {
        host.lastApproval = request;
        return 'allowed-once';
      },
      async askUser(question, options) {
        host.lastQuestion = { question, signal: options?.signal };
        return 'answer';
      },
    },
    emit(sessionId, event) {
      const list = events.get(sessionId) ?? [];
      list.push(event);
      events.set(sessionId, list);
      for (const listener of listeners) listener(sessionId, event);
    },
    get primary() { return primary; },
    lastApproval: undefined,
    lastQuestion: undefined,
    ...overrides,
  };
  return host;
}

const ROUTES = [
  { id: 'codex', displayName: 'Codex', kind: 'external-turn', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  { id: 'deepseek', displayName: 'DeepSeek', kind: 'model', models: [{ id: 'deepseek-chat', name: 'Chat' }] },
];

const runner = {
  async run(request) {
    return { stopReason: 'completed', outputText: 'did:' + request.prompt };
  },
};

describe('directory contribution with explicit route kind', () => {
  it('registers every route and lists them back with kind intact', () => {
    const host = fakeHost();
    const bridge = createBridge(host, { routes: ROUTES, runner });
    assert.deepEqual(host.directory.list(), ROUTES);
    assert.equal(host.directory.list()[0].kind, 'external-turn');
    assert.equal(host.directory.list()[1].kind, 'model');
    bridge.dispose();
    assert.deepEqual(host.directory.list(), []);
  });

  it('rejects an external-turn route with no models', () => {
    const host = fakeHost();
    assert.throws(
      () => createBridge(host, { routes: [{ id: 'x', displayName: 'X', kind: 'external-turn', models: [] }], runner }),
      /at least one model/,
    );
  });

  it('rejects duplicate route ids', () => {
    const host = fakeHost();
    assert.throws(
      () => createBridge(host, { routes: [ROUTES[0], ROUTES[0]], runner }),
      /duplicate route/,
    );
  });
});

describe('primary turn-driver dispatch', () => {
  it('drives external-turn routes through the runner, leaves model routes alone', async () => {
    const host = fakeHost();
    const bridge = createBridge(host, { routes: ROUTES, runner });
    const external = await host.primary.drive({ sessionId: 's1', routeId: 'codex', model: 'gpt-5', prompt: 'hi' });
    assert.deepEqual(external, { handled: true, result: { stopReason: 'completed', outputText: 'did:hi' } });
    // Same drive path via the bridge handle.
    const viaBridge = await bridge.drive({ sessionId: 's1', routeId: 'codex', model: 'gpt-5', prompt: 'hi' });
    assert.deepEqual(viaBridge, external);
    // Model-kind and unknown routes are not driven: no LlmAdapter, no subagent start.
    assert.deepEqual(
      await bridge.drive({ sessionId: 's1', routeId: 'deepseek', model: 'deepseek-chat', prompt: 'hi' }),
      { handled: false },
    );
    assert.deepEqual(
      await bridge.drive({ sessionId: 's1', routeId: 'nope', model: 'm', prompt: 'hi' }),
      { handled: false },
    );
    bridge.dispose();
  });

  it('maps an aborted signal to an aborted turn without calling the runner', async () => {
    let called = 0;
    const host = fakeHost();
    const bridge = createBridge(host, {
      routes: ROUTES,
      runner: { async run() { called += 1; return { stopReason: 'completed', outputText: '' }; } },
    });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(
      await bridge.drive({ sessionId: 's1', routeId: 'codex', model: 'gpt-5', prompt: 'hi', signal: controller.signal }),
      { handled: true, result: { stopReason: 'aborted', outputText: '' } },
    );
    assert.equal(called, 0);
    bridge.dispose();
  });

  it('maps a runner throw to an error turn', async () => {
    const host = fakeHost();
    const bridge = createBridge(host, {
      routes: ROUTES,
      runner: { async run() { throw new Error('boom'); } },
    });
    assert.deepEqual(
      await bridge.drive({ sessionId: 's1', routeId: 'codex', model: 'gpt-5', prompt: 'hi' }),
      { handled: true, result: { stopReason: 'error', outputText: '', diagnostic: 'boom' } },
    );
    bridge.dispose();
  });
});

describe('session event projection', () => {
  it('folds stored events and follows only the subscribed session', () => {
    const host = fakeHost();
    const bridge = createBridge(host, { routes: ROUTES, runner });
    host.emit('s1', { type: 'user/message', seq: 0, data: {} });
    host.emit('s1', { type: 'assistant/message', seq: 1, data: {} });
    host.emit('s2', { type: 'user/message', seq: 0, data: {} });
    const count = bridge.project('s1', 0, (n) => n + 1);
    assert.equal(count, 2);
    const seen = [];
    const stop = bridge.follow('s1', (event) => seen.push(event));
    host.emit('s1', { type: 'step/end', seq: 2, data: {} });
    host.emit('s2', { type: 'step/end', seq: 1, data: {} });
    assert.deepEqual(seen, [{ type: 'step/end', seq: 2, data: {} }]);
    stop();
    bridge.dispose();
  });
});

describe('approval and question delegation', () => {
  it('forwards agentless approval and questions to the host', async () => {
    const host = fakeHost();
    const bridge = createBridge(host, { routes: ROUTES, runner });
    assert.equal(await bridge.requestApproval({ sessionId: 's1', toolName: 'run', reason: 'why' }), 'allowed-once');
    assert.deepEqual(host.lastApproval, { sessionId: 's1', toolName: 'run', reason: 'why' });
    assert.equal(await bridge.askUser({ id: 'q1', question: 'proceed?' }), 'answer');
    assert.equal(host.lastQuestion.question.id, 'q1');
    bridge.dispose();
  });
});

describe('disposal', () => {
  it('unregisters routes and the driver; use after dispose throws', async () => {
    const host = fakeHost();
    const bridge = createBridge(host, { routes: ROUTES, runner });
    bridge.dispose();
    bridge.dispose();
    assert.deepEqual(host.directory.list(), []);
    assert.equal(host.primary, undefined);
    await assert.rejects(bridge.drive({ sessionId: 's', routeId: 'codex', model: 'm', prompt: 'p' }), /disposed/);
    assert.throws(() => bridge.project('s', 0, (n) => n), /disposed/);
  });
});

describe('current-DSH composition gap', () => {
  it('a DSH-shaped host exposes none of the bridge surface', () => {
    // Shaped after the real seams: adapter registry, agent factory,
    // session store, approval waterfall. None of them is the bridge
    // directory / primary-driver / agentless-interaction surface.
    const dshShaped = {
      llm: { registerAdapter() {}, listProviders() { return []; } },
      agents: { create() {}, get() {} },
      sessions: { get() {} },
      approval: {},
    };
    const probe = probeBridgeHost(dshShaped);
    assert.equal(probe.ok, false);
    assert.deepEqual([...probe.missing], [...REQUIRED_HOST_PATHS]);
    assert.throws(() => createBridge(dshShaped, { routes: ROUTES, runner }), /host is missing/);
  });
});
