# @deepseek-ai/dsh-external-agent

Provider-neutral External Agent platform seam for DSH (issue #1 MVP).

Independently installed provider plugins register models, open native
sessions, run complete native turns, and emit provider-neutral activity.
DSH-side primary-session and subagent consumers share the same provider
interface. Raw LLM routes and external-agent routes stay distinct; model
selection is explicit (`llm:model`, `external-agent:provider/model`) with
exact resolution and no silent fallback.

Dependency-free ESM TypeScript. No ACP, subprocess, auth, filesystem,
UI, or DSH core imports.

## Install / checks

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

## Use

```ts
import {
  ExternalAgentProviderRegistry,
  FakeExternalAgentProvider,
  BoundedEventLog,
  parseRouteSpecifier,
} from "@deepseek-ai/dsh-external-agent";

const registry = new ExternalAgentProviderRegistry();
const provider = new FakeExternalAgentProvider("acme", [
  { id: "coder", supportedModes: ["approval-required", "auto-accept-edits"] },
]);
const unregister = registry.register(provider); // throws DuplicateProviderError on clash
const route = parseRouteSpecifier("external-agent:acme/coder");
await registry.resolveExternalRoute("acme", "coder"); // exact, throws RouteResolutionError

const session = provider.openSession({ model: "coder" });
const log = new BoundedEventLog({ maxEvents: 500 });
const controller = new AbortController();
const result = await session.runTurn({
  prompt: "fix the failing test",
  mode: "approval-required",
  signal: controller.signal, // pre-aborted => { status: "cancelled" }, no execution
  onEvent: (event) => log.push(event),
  onPermission: async () => "allowed-once", // fail closed on abort/settle
  onUserInput: async () => ({ status: "unavailable" }),
});
await session.dispose(); // idempotent
unregister(); // HMR / shutdown removal
```

## Rules the seam enforces

- One provider name per registry; disposal removes exactly its own row.
- Unknown provider/model/mode is an explicit error, never a fallback.
- One turn owns its host; retained hosts throw `HostExpiredError` after settle.
- Aborted turns fail closed: pending permission/input rejects, never approves.
- `allow-always` appears only when the native provider offers it, carries a
  `session`/`thread` scope label, and is enforced by the native session —
  DSH records it but never replays it onto a replacement session.
- Full access selects the highest native permission mode; it does not answer
  user questions or bypass host filesystem policy.
- Native tool activity is already-executed work; consumers must never
  translate it into a DSH tool call.
- Zero automatic retries for effectful turns; transport failures propagate.
- `BoundedEventLog` truncates strings at code-point boundaries and drops
  oldest-first past the cap.

## What is out of scope

Concrete providers (Antigravity/Cursor/Claude Code live in separate repos),
ACP transports, auth, filesystem mediation, Settings UI, DSH Session
projection, thread browsing/rollback, and out-of-band events after a turn.
