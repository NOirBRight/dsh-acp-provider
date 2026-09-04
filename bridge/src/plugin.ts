/**
 * Cordis function-plugin entry for dsh-bridge. Optional mount only:
 * validates config, probes the host for the bridge surface, and mounts
 * the bridge when the host provides it. Against current DSH the probe
 * reports the missing surface and apply throws a blocked error naming
 * the exact upstream hook, instead of faking a seam.
 *
 * @module dsh-bridge/plugin
 */

import { createBridge } from './bridge.ts';
import type { Bridge, BridgeConfig } from './bridge.ts';
import { bridgeModelId, bridgeRouteId } from './contracts.ts';
import type { BridgeDriveOutcome, BridgeModel, BridgeRoute, BridgeTurnRequest } from './contracts.ts';
import { probeBridgeHost } from './current-dsh.ts';

/** Plugin name: matches the cordis.patch.yml row. */
export const name = 'dsh-bridge';

/**
 * Host services consulted opportunistically through ctx.get (never hard
 * required): the real mount surface is the BridgeHost directory /
 * drivers / sessions / interaction contract, which current DSH does
 * not provide. Declaring no hard inject keeps this plugin loadable
 * next to any composition; apply() probes and fails loud when the
 * surface is absent.
 */
export const inject: string[] = [];

/** Untrusted model configuration before ID branding. */
export type BridgeModelConfig = Omit<BridgeModel, 'id'> & { readonly id: string }
/** Untrusted route configuration before ID branding. */
export type BridgeRouteConfig = Omit<BridgeRoute, 'id' | 'models'> & { readonly id: string; readonly models: readonly BridgeModelConfig[] }
/** Deployment config: routes only. The runner is host-provided. */
export interface Config {
  readonly routes?: readonly BridgeRouteConfig[]
}

/** Host-supplied product runner slot the bridge drives through. */
export interface BridgeRunnerSlot {
  (request: BridgeTurnRequest): Promise<BridgeDriveOutcome>;
}

/** Live plugin state: the mounted bridge, disposed with the fiber. */
let live: Bridge | undefined;

/**
 * Validate one configured route at the earliest resolvable point.
 * @param route - candidate route from plugin config.
 */
function assertConfigRoute(route: BridgeRouteConfig): void {
  if (typeof route.id !== 'string' || route.id.length === 0) {
    throw new TypeError('dsh-bridge: config route id must be a non-empty string');
  }
  if (route.kind !== 'llm' && route.kind !== 'external-agent') {
    throw new TypeError('dsh-bridge: config route "' + route.id + '" needs kind "llm" or "external-agent"');
  }
}

/**
 * Mount the bridge when the host offers the surface; fail loud otherwise.
 * @param ctx - plugin context (probed structurally for the host surface).
 * @param config - deployment routes.
 */
export function apply(ctx: unknown, config: Config): void {
  const configuredRoutes = [...(config.routes ?? [])];
  for (const route of configuredRoutes) assertConfigRoute(route);
  const routes: BridgeRoute[] = configuredRoutes.map(route => ({ ...route, id: bridgeRouteId(route.id), models: route.models.map(model => ({ ...model, id: bridgeModelId(model.id) })) }));
  const host = ctx as Record<string, unknown>;
  const probe = probeBridgeHost(host);
  if (!probe.ok) {
    throw new Error(
      'dsh-bridge: blocked against this host: missing ' + probe.missing.join(', ') + '. ' +
      'Upstream hook required: explicit route-kind directory plus primary turn-driver dispatch ' +
      '(see README.md). No providers were mounted and no process was started.',
    );
  }
  const slot = (host as { bridgeRunner?: unknown }).bridgeRunner;
  if (typeof slot !== 'function') {
    throw new Error('dsh-bridge: host provides the surface but no bridgeRunner; refusing to mount without a runner.');
  }
  const runner = slot as BridgeRunnerSlot;
  const context = ctx as { effect(cb: () => () => void, label: string): unknown };
  const bridgeConfig: BridgeConfig = {
    routes,
    runner: {
      run: (request) => runner(request).then((o) => {
        if (o.handled) return o.result;
        throw new Error(`dsh-bridge: runner declined route "${request.routeId}"`);
      }),
    },
  };
  live = createBridge(host as never, bridgeConfig);
  const mounted = live;
  context.effect(() => () => { mounted.dispose(); live = undefined; }, 'dsh-bridge.dispose()');
}
