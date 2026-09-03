# Agent Note: external-agent platform (issue #1)

## Decision

The provider-neutral External Agent platform is implemented as @deepseek-ai/dsh-acp-provider. The package owns exact llm: and external-agent:provider/model routes, provider registration, provider-owned sessions, turn-scoped hosts, permission and user-input round trips, canonical bounded activity, full-access confirmation and audit, filesystem request contracts, and quiescent disposal.

Primary-session and subagent consumers share the session contract. Provider cursors are scoped by provider and route; primary route changes close the native session and retain only its resume cursor. Native tool activity is published and is never re-executed by DSH.

## Why this boundary

The platform has no ACP, subprocess, authentication, filesystem implementation, Settings UI, or DSH core dependency. Concrete providers can select their transport and credential policy while the host keeps route selection, interaction authority, audit, and lifecycle ownership.

## Alternatives considered

- Embedding ACP and process management in the platform would couple every provider to one transport and credential model.
- Adding a Cordis peer without importing Cordis would advertise a binding the package does not use.
- Keeping provider sessions parked across route changes would retain native permission state and grow unbounded session resources.

## Integration limit

The current DSH checkout does not expose the primary external-agent turn-driver, session-event, agentless interaction, and Settings mounting hooks. bridge/ contains an executable adapter contract and a blocked-composition probe; it fails loudly instead of presenting a partial in-tree integration.

## Verification

Platform typecheck, unit tests, and declaration build cover exact routing, managed-session lifetime, interaction expiry, bounded events, registry disposal, consumers, Settings snapshots, and filesystem containment.
