/**
 * Out-of-tree DSH integration bridge. Mounts external routes against a
 * BridgeHost: explicit-kind directory contribution, primary turn-driver
 * dispatch without a synthetic LlmAdapter or subagent start, stored session
 * projection, approval and question delegation, and disposal.
 *
 * @module dsh-bridge/bridge
 */

import type {
  BridgeApprovalOutcome,
  BridgeApprovalRequest,
  BridgeDriveOutcome,
  BridgeHost,
  BridgeQuestion,
  BridgeRoute,
  BridgeRunner,
  BridgeSessionEvent,
  BridgeSessionId,
  BridgeTurnRequest,
} from './contracts.ts';
import { missingPaths } from './current-dsh.ts';

/** Deployment configuration: routes to contribute plus the runner. */
export interface BridgeConfig {
  readonly routes: readonly BridgeRoute[]
  readonly runner: BridgeRunner
}

/** Live bridge handle. Everything unwinds through dispose. */
export interface Bridge {
  readonly routes: readonly BridgeRoute[]
  drive(request: BridgeTurnRequest): Promise<BridgeDriveOutcome>
  project<T>(sessionId: BridgeSessionId, init: T, fold: (state: T, event: BridgeSessionEvent) => T): T
  requestApproval(request: BridgeApprovalRequest): Promise<BridgeApprovalOutcome>
  askUser(question: BridgeQuestion, options?: { signal?: AbortSignal }): Promise<string>
  dispose(): Promise<void>
}

/** Fail loud on a route the directory could not present honestly. */
function assertRoute(route: BridgeRoute): void {
  if (route.id.length === 0) throw new TypeError('dsh-bridge: route id must be non-empty');
  if (route.displayName.length === 0) {
    throw new TypeError('dsh-bridge: route "' + route.id + '" displayName must be non-empty');
  }
  if (route.kind !== 'llm' && route.kind !== 'external-agent') {
    throw new TypeError('dsh-bridge: route "' + route.id + '" has unknown kind ' + JSON.stringify(route.kind));
  }
  if (route.kind === 'external-agent' && route.models.length === 0) {
    throw new TypeError('dsh-bridge: external-agent route "' + route.id + '" must advertise at least one model');
  }
}

class BridgeImpl implements Bridge {
  readonly routes: readonly BridgeRoute[];
  private readonly byId: ReadonlyMap<string, BridgeRoute>;
  private readonly disposers: Array<() => void> = [];
  private readonly active = new Set<{ readonly controller: AbortController; readonly promise: Promise<unknown> }>();
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly host: BridgeHost, private readonly config: BridgeConfig) {
    const missing = missingPaths(host);
    if (missing.length > 0) {
      throw new TypeError('dsh-bridge: host is missing ' + missing.join(', '));
    }
    const seen = new Set<string>();
    for (const route of config.routes) {
      assertRoute(route);
      if (seen.has(route.id)) throw new TypeError('dsh-bridge: duplicate route "' + route.id + '"');
      seen.add(route.id);
    }
    this.routes = [...config.routes];
    this.byId = new Map(config.routes.map(route => [route.id, route]));
    try {
      for (const route of config.routes) this.disposers.push(host.directory.register(route));
      this.disposers.push(host.drivers.setPrimary({ drive: request => this.drive(request) }));
    } catch (error: unknown) {
      this.unwind();
      throw error;
    }
  }

  async drive(request: BridgeTurnRequest): Promise<BridgeDriveOutcome> {
    this.assertLive();
    const route = this.byId.get(request.routeId);
    if (route === undefined || route.kind !== 'external-agent') return { handled: false };
    if (!route.models.some(model => model.id === request.model)) {
      return { handled: true, result: { stopReason: 'error', outputText: '', diagnostic: 'dsh-bridge: model "' + request.model + '" is not advertised by route "' + route.id + '"' } };
    }
    if (request.signal?.aborted === true) {
      return { handled: true, result: { stopReason: 'aborted', outputText: '' } };
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    const promise = Promise.resolve().then(() => this.config.runner.run({ ...request, signal: controller.signal }));
    const active = { controller, promise };
    this.active.add(active);
    try {
      return { handled: true, result: await promise };
    } catch (error: unknown) {
      return {
        handled: true,
        result: {
          stopReason: controller.signal.aborted ? 'aborted' : 'error',
          outputText: '',
          ...(controller.signal.aborted ? {} : { diagnostic: error instanceof Error ? error.message : String(error) }),
        },
      };
    } finally {
      request.signal?.removeEventListener('abort', abort);
      this.active.delete(active);
    }
  }

  project<T>(sessionId: BridgeSessionId, init: T, fold: (state: T, event: BridgeSessionEvent) => T): T {
    this.assertLive();
    let state = init;
    for (const event of this.host.sessions.read(sessionId)) state = fold(state, event);
    return state;
  }

  requestApproval(request: BridgeApprovalRequest): Promise<BridgeApprovalOutcome> {
    this.assertLive();
    return this.host.interaction.requestApproval(request);
  }

  askUser(question: BridgeQuestion, options?: { signal?: AbortSignal }): Promise<string> {
    this.assertLive();
    return this.host.interaction.askUser(question, options);
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeQuiescently();
    return this.disposePromise;
  }

  private async disposeQuiescently(): Promise<void> {
    let unwindError: unknown;
    try { this.unwind(); } catch (error) { unwindError = error; }
    for (const active of this.active) active.controller.abort();
    await Promise.all([...this.active].map(active => active.promise.catch(() => undefined)));
    if (unwindError !== undefined) throw unwindError;
  }

  private unwind(): void {
    let first: unknown;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (error: unknown) {
        if (first === undefined) first = error;
      }
    }
    if (first !== undefined) throw first;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('dsh-bridge: bridge is disposed');
  }
}

/**
 * Mount the bridge on a host that provides the full surface.
 * @param host - host implementing every REQUIRED_HOST_PATHS entry.
 * @param config - routes to contribute plus the deployment runner.
 * @returns the live bridge; the caller owns dispose.
 * @throws TypeError when the host surface or a route is incomplete.
 */
export function createBridge(host: BridgeHost, config: BridgeConfig): Bridge {
  return new BridgeImpl(host, config);
}
