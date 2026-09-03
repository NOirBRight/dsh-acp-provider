# dsh-bridge

Optional out-of-tree DSH integration bridge for External Agent routes.
Host-adapter package: it can be mounted into DSH later, but DSH package
imports stay peer conveniences only. Compiles standalone; the standalone
repo has no DSH checkout, so DSH imports are peer conveniences only and the
test suite runs against a fake host.

Executable against a BridgeHost. Blocked against current DSH: current
DSH exposes no honest extension point for any of the five capabilities,
so the bridge ships the minimal integration contract plus a probe that
fails loud against a DSH-shaped host. This package is the smallest host
contract required upstream; it does not duplicate the provider seam
(the other worktree owns spawning and CLI mapping).

## What it does

Given a BridgeHost and a deployment runner, the bridge:

- contributes routes to the model directory with an explicit
  BridgeRouteKind ('model' | 'external-turn');
- dispatches as the primary turn driver for external-turn routes only,
  without a synthetic LlmAdapter and without ctx.subagents.start;
- projects session events (read/fold and per-session follow);
- delegates approval and user questions agentlessly to the host;
- unwinds every registration through dispose.

## The honest gap

Verified read-only against the DSH source (0.1.1-rc.1):

- routes have no kind. LlmProviderInfo (packages/llm/llm/src/types.ts)
  is { id, name } only; the configurable-provider directory adds
  settings routing, not a turn-driver discriminant. An external route
  registered as an adapter today is indistinguishable from a model
  route, so selection and catalog cannot route honest external turns.
- no primary turn-driver slot. The default driver is AgentLoop /
  ReactLoopAgent (packages/core/agent-loop); ctx.agents.setFactory
  rejects a second factory ('an agent factory is already registered',
  packages/core/agent/src/index.ts). There is no supported dispatch
  point that routes one selection to an external product.
- no agentless approval or question path. ApprovalService.request
  throws outside an open turn (packages/interaction/user-approval),
  and UserQuestionService.ask rejects DELEGATED_CALLER for owned
  children and NO_PROVIDER without a UI provider
  (packages/interaction/user-questions/src/index.ts).
- session log has no external-turn vocabulary. KNOWN_SESSION_EVENT_TYPES
  (packages/core/session/src/known-event-types.ts) admits no external
  event; an out-of-repo plugin event is outside the list by
  construction ('a registration surface for them is deferred until
  such a consumer exists'). The model-visible-means-logged rule then
  forbids new model-visible input without a session event.
- composition test is blocked too. probeBridgeHost reports all seven
  REQUIRED_HOST_PATHS missing against a DSH-shaped host, and
  createBridge throws 'host is missing ...' instead of mounting.
  There is no passing composition test against current DSH because
  there is nothing honest to compose with.

## Upstream hooks required (minimal)

1. LlmProviderInfo or the configurable-provider directory gains an
   explicit route kind (or a parallel external-route registry with
   kind + model catalog), read by session.models / session.selectModel.
2. A primary turn-driver dispatch slot consulted before the loop for
   external-kind selections (replacing a synthetic LlmAdapter).
3. An external-turn session event (or a real out-of-repo registration
   surface) so delegated prompts and results are log-reconstructable.
4. Agentless approval/question delegation for externally driven turns.
5. Session-scoped routable reporting that understands external kinds.

## Use

```ts
import { createBridge, probeBridgeHost } from 'dsh-bridge';

const probe = probeBridgeHost(host);
if (!probe.ok) throw new Error('blocked: missing ' + probe.missing.join(', '));
const bridge = createBridge(host, { routes, runner });
// ... bridge.drive / project / follow / requestApproval / askUser ...
bridge.dispose();
```

cordis.patch.yml mounts the bridge as one optional row (routes: [] by
default; loading it starts nothing). Config validation lives in code:
non-empty ids, known kinds, at least one model per external-turn
route, duplicate rejection.

## Layout

- src/contracts.ts: BridgeHost, route/turn/approval vocabulary.
- src/current-dsh.ts: probeBridgeHost + REQUIRED_HOST_PATHS.
- src/bridge.ts: createBridge (register, drive, project, follow,
  delegate, dispose).
- tests/bridge.test.js: 10 public-behavior tests against the fake
  host, including the blocked-DSH composition case.
- cordis.patch.yml: optional single-row mount.

## Status

Bridge contract executable against BridgeHost (typecheck + 10 tests
green). Blocked against current DSH: probeBridgeHost returns all
seven paths missing on a DSH-shaped host, which is the concrete
missing upstream extension.
