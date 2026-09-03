# Agent Note: dsh-bridge (External Agent DSH integration bridge)

Date: 2026-09-04. Branch: agent/platform-dsh-bridge.
Scope: bridge/ only (standalone package; DSH checkout read-only).

## Outcome

Executable contract, blocked composition. The bridge compiles clean
(tsc exit 0) and its 10 public-behavior tests pass against a fake
host. Against current DSH (0.1.1-rc.1, read-only audit) the probe
reports all seven REQUIRED_HOST_PATHS missing on a DSH-shaped host,
so createBridge throws instead of mounting. There is no passing
composition test against current DSH, and per the brief none was
faked: the blocked-DSH test asserts the throw.

## What was built

- bridge/src/contracts.ts: BridgeHost plus route kind, turn,
  approval, and question vocabulary. No DSH imports.
- bridge/src/current-dsh.ts: probeBridgeHost structural probe.
- bridge/src/bridge.ts: createBridge (register, drive, project,
  follow, delegate, dispose). No synthetic LlmAdapter, no
  ctx.subagents.start; the deployment runner owns the product.
- bridge/src/plugin.ts: optional Cordis function-plugin entry
  (name/inject/apply, no default export). apply() validates config,
  probes, and fails loud with the upstream hook when the surface is
  absent. No hard inject: the bridge surface is not a DSH service.
- bridge/cordis.patch.yml: one optional row, routes [] by default.
- bridge/tests/bridge.test.js: fake-host suite (directory kinds,
  dispatch, abort/error mapping, projection, delegation, disposal,
  blocked-DSH composition).
- bridge/README.md: honest gap report with file:line-level hooks.

## Upstream gaps (concrete, verified read-only)

1. Routes have no kind: LlmProviderInfo is { id, name } only
   (packages/llm/llm/src/types.ts); directory adds settings routing.
2. No primary turn-driver slot: AgentLoop owns driving; setFactory
   rejects a second factory (packages/core/agent/src/index.ts).
3. No external-turn session event: KNOWN_SESSION_EVENT_TYPES admits
   none, and out-of-repo registration is explicitly deferred
   (packages/core/session/src/known-event-types.ts).
4. No agentless approval/question path: request() throws outside an
   open turn; ask() rejects DELEGATED_CALLER / NO_PROVIDER
   (packages/interaction/user-approval,
   packages/interaction/user-questions/src/index.ts).
5. routable reporting (packages/host/apiproxy/src/api-proxy.ts
   routeServed) reads adapter registration only.

## Verification

- tsc -p tsconfig.json: exit 0 (run with workdir=bridge/).
- node --test tests/bridge.test.js: 10 pass, 0 fail.
- npm test is NOT green in a bare checkout: no local typescript
  install, so the tsc shim fails before tests run. With tsc on PATH
  (or npm install), build passes and the suite runs.
- DSH checkout untouched by this change: no bridge/ leftover, no
  .gitignore delta (verified via git status/diff in that checkout).
  Pre-existing DSH worktree modifications are not mine.

## Deliberate simplifications

- .ts extension imports (DSH convention) need
  allowImportingTsExtensions + rewriteRelativeImportExtensions in
  the bridge tsconfig; kept, documented by the passing build.
- No DSH peerDependencies declared: zero runtime imports means
  nothing to peer on; adding peers would fake a binding that does
  not exist yet.
- Live plugin handle is module state (single mount); matches the
  single-row patch and keeps disposal trivial.
