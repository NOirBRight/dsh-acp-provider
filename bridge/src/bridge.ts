/**
 * Out-of-tree DSH integration bridge. Mounts external routes against a
 * BridgeHost: explicit-kind directory contribution, primary turn-driver
 * dispatch without a synthetic LlmAdapter or subagent start, session
 * event projection, approval and question delegation, and disposal.
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
  project<T>(sessionId: string, init: T, fold: (state: T, event: BridgeSessionEvent) => T): T
  follow(sessionId: string, listener: (event: BridgeSessionEvent) => void): () => void
  requestApproval(request: BridgeApprovalRequest): Promise<BridgeApprovalOutcome>
  askUser(question: BridgeQuestion, options?: { signal?: AbortSignal }): Promise<string>
  dispose(): void
}

/** Fail loud on a route the directory could not present honestly. */
function assertRoute(route: BridgeRoute): void {
  if (route.id.length === 0) throw new TypeError('dsh-bridge: route id must be non-empty');
  if (route.displayName.length === 0) {
    throw new TypeError('dsh-bridge: route "' + route.id + '" displayName must be non-empty');
  }
  if (route.kind !== 'model' && route.kind !== 'external-turn') {
    throw new TypeError('dsh-bridge: route "' + route.id + '" has unknown kind ' + JSON.stringify(route.kind));
  }
  if (route.kind === 'external-turn' && route.models.length === 0) {
    throw new TypeError('dsh-bridge: external-turn route "' + route.id + '" must advertise at least one model');
  }
}

class BridgeImpl implements Bridge {
  readonly routes: readonly BridgeRoute[];
  private readonly byId: ReadonlyMap<string, BridgeRoute>;
  private readonly disposers: Array<() => void> = [];
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
    if (route === undefined || route.kind !== 'external-turn') return { handled: false };
    if (request.signal?.aborted === true) {
      return { handled: true, result: { stopReason: 'aborted', outputText: '' } };
    }
    try {
      return { handled: true, result: await this.config.runner.run(request) };
    } catch (error: unknown) {
      return {
        handled: true,
        result: {
          stopReason: 'error',
          outputText: '',
          diagnostic: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  project<T>(sessionId: string, init: T, fold: (state: T, event: BridgeSessionEvent) => T): T {
    this.assertLive();
    let state = init;
    for (const event of this.host.sessions.read(sessionId)) state = fold(state, event);
    return state;
  }

  follow(sessionId: string, listener: (event: BridgeSessionEvent) => void): () => void {
    this.assertLive();
    return this.host.sessions.onEvent((seenId, event) => {
      if (seenId === sessionId) listener(event);
    });
  }

  requestApproval(request: BridgeApprovalRequest): Promise<BridgeApprovalOutcome> {
    this.assertLive();
    return this.host.interaction.requestApproval(request);
  }

  askUser(question: BridgeQuestion, options?: { signal?: AbortSignal }): Promise<string> {
    this.assertLive();
    return this.host.interaction.askUser(question, options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwind();
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
