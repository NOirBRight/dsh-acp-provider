# @deepseek-ai/dsh-acp-provider

Provider-neutral External Agent platform for DeepSeek Harness.

Providers register exact model routes, open provider-owned sessions, run complete native turns, and publish provider-neutral activity. Primary-session and subagent consumers use the same session contract; raw LLM routes remain distinct from external-agent:provider/model routes.

The package is dependency-free ESM TypeScript. ACP transport, subprocesses, authentication, filesystem mediation, and provider-specific Settings editors belong to provider packages.

## Install and verify

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

## Minimal provider usage

```ts
import { ExternalAgentProviderRegistry, BoundedEventLog, parseRouteSpecifier, sessionId, turnId } from "@deepseek-ai/dsh-acp-provider"
import { FakeExternalAgentProvider } from "@deepseek-ai/dsh-acp-provider/fake"

const registry = new ExternalAgentProviderRegistry()
const provider = new FakeExternalAgentProvider('acme', [{ id: 'coder', supportedModes: ['approval-required'] }])
const unregister = registry.register(provider)
const route = parseRouteSpecifier('external-agent:acme/coder')
const session = await registry.openSession({ route, session: sessionId('dsh-session'), permissionMode: 'approval-required' })
const log = new BoundedEventLog()
const controller = new AbortController()
const result = await session.runTurn({ turn: turnId('turn-1'), prompt: 'inspect the failing test', permissionMode: 'approval-required', signal: controller.signal }, {
  publish: event => log.push(event),
  requestPermission: async request => ({ kind: 'allow-once', optionId: request.options[0].optionId }),
  requestUserInput: async () => ({ answers: [] }),
})
await session.dispose()
await unregister()
```

## Runtime rules

- Provider and model resolution is exact; unknown routes and unsupported permission modes fail explicitly.
- Every turn receives an expiring host. Aborts and settlement reject later provider permission or question requests.
- Native allow_always options retain their exact id and carry only a native session or thread scope. DSH never replays them from old logs.
- Full access requires explicit confirmation and a value-free audit record before the provider starts.
- Native tool activity is already-executed work; consumers publish it and never execute it again as a DSH tool call.
- Host filesystem callbacks remain DSH-owned; providers that expose ACP file methods must supply an operation-aware canonical-path resolver.
- Effectful turns have no automatic retry. Event and interaction payloads have configurable byte and count bounds.

## DSH integration

The bridge/ directory contains an out-of-tree composition probe and adapter contract. It fails loudly when the installed DSH checkout does not expose the required route, turn-driver, session-event, interaction, and Settings hooks; it does not pretend that an unavailable host seam is integrated.

Concrete providers are separate packages. The Antigravity ACP provider uses the official @agentclientprotocol/sdk, an explicitly configured Google executable pair, a private OAuth profile, and host-owned filesystem mediation.
