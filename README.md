# @deepseek-ai/dsh-acp-provider

Provider-neutral External Agent platform for DeepSeek Harness.

Providers register exact model routes and execute native turns. ExternalAgentTurnRunner owns the sessions used by a host adapter: reuse, model selection, cursor persistence, cancellation, replacement, and disposal all use the registry. Native activity describes observed work, never DSH-owned tool execution.

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
import { ExternalAgentProviderRegistry, ExternalAgentTurnRunner, BoundedEventLog, parseRouteSpecifier, sessionId, turnId } from "@deepseek-ai/dsh-acp-provider"
import { FakeExternalAgentProvider } from "@deepseek-ai/dsh-acp-provider/fake"

const registry = new ExternalAgentProviderRegistry()
const provider = new FakeExternalAgentProvider('acme', [{ id: 'coder', supportedModes: ['approval-required'] }])
const unregister = registry.register(provider)
const route = parseRouteSpecifier('external-agent:acme/coder')
const runner = new ExternalAgentTurnRunner(registry)
const log = new BoundedEventLog()
const controller = new AbortController()
const result = await runner.runTurn({ route, session: sessionId('dsh-session'), permissionMode: 'approval-required' }, { turn: turnId('turn-1'), prompt: 'inspect the failing test', permissionMode: 'approval-required', signal: controller.signal }, {
  publish: event => log.push(event),
  requestPermission: async request => ({ kind: 'allow-once', optionId: request.options[0].optionId }),
  requestUserInput: async () => ({ answers: [] }),
})
await runner.dispose()
await unregister()
```

Question callbacks keep every response string in `ExternalAgentUserInputAnswers.answers`. An optional `custom` identifies the free-text response already included in that array, so adapters do not reinterpret text matching an option label or id as a selection.

## Runtime rules

- Provider and model resolution is exact; unknown routes and unsupported permission modes fail explicitly.
- Every turn receives an expiring host. Aborts and settlement reject later provider permission or question requests.
- Native allow_always options retain their exact id and carry only a native session or thread scope. DSH never replays them from old logs.
- Full access requires explicit confirmation and a value-free audit record before the provider starts; its handoff proof is valid for one provider open only.
- Native tool activity is already-executed work; consumers publish it and never execute it again as a DSH tool call. File locations retain their path and optional line number.
- Host filesystem callbacks remain DSH-owned; providers that expose ACP file methods must supply an operation-aware canonical-path resolver. Write resolution falls back to the canonical parent only when the target is absent.
- Effectful turns have no automatic retry. The turn runner serializes preparation and execution per DSH session, blocks new work during reset, and retains the native cursor when disposing a failed transport. runTurn.model carries the exact selected model through managed wrappers; providers reconfigure before prompting.
- Bindings are saved before the first prompt and whenever a result changes the native reference. Failed writes fail the turn and release its transport. Ownership and usage fields are explicit in canonical events; payload limits still apply.
- Full-access reuse repeats authorization and audit through the registry. A host may supply prior explicit authority without displaying a second approval prompt; it must not infer authority from model or user text.

## DSH integration

The supported Antigravity path is a DSH LLM adapter using ExternalAgentTurnRunner, not a second DSH loop. Give the runner the same registry that owns provider registration, connect its persistence callbacks to native bindings, call release when a DSH session is disposed, and await reset before replacing or signing out a provider. dispose permanently closes the runner. A binding without a resume cursor, an unavailable native context, or unreadable binding storage fails closed; none silently creates a new context.

bridge/ is a retired composition experiment requiring host hooks that the supported LLM-adapter path does not use. The exported primary/subagent consumers are standalone examples, not the required DSH integration route. Their existing lifecycle rules remain covered; new providers should not copy or extend that experimental composition.

The Node-only activity-store export owns versioned append-only history and filesystem safety; each adapter supplies its existing event decoder. Browser code must not import this subpath. History remains readable without a native runtime.

Concrete providers are separate packages. The Antigravity ACP provider uses the official @agentclientprotocol/sdk, an explicitly configured Google executable pair, a private OAuth profile, and host-owned filesystem mediation.
