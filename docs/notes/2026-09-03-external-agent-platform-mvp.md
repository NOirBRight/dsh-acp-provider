# Agent Note: external-agent platform MVP (issue #1)

## Decision

Ship the provider-neutral seam as a standalone dependency-free package
(`@deepseek-ai/dsh-external-agent`, `src/index.ts`): registry with
duplicate rejection and idempotent disposers, exact route resolution
(`llm:` / `external-agent:` specifiers), `ManagedExternalAgentSession`
owning abort-before-run, advertised-mode checks, disposal, and turn-host
expiry, request/response permission and user-input round trips, canonical
activity events, and a bounded event log. A scripted `FakeExternalAgentProvider`
is the principal test double.

## Why this cut

Issue #1 spans platform, two consumers, Settings, and DSH host integration.
The seam is the part every later piece compiles against, and it is verifiable
without ACP, subprocesses, or DSH core. Consumers, Settings, and host
integration follow in later issues against this frozen surface.

## Deferred (not dropped)

- Primary-session and subagent consumers over the same interface.
- Settings External Agents page plus provider-owned editor containers.
- DSH host turn-driver extension dispatching `external-agent` routes.
- Native allow-always replay prohibition is documented; enforcement sits with
  the native session, so the consumer-side guard lands with the primary
  consumer (it owns interaction authority).
