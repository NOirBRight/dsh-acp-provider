# Agent Note: DSH composition bridge

## Decision

Keep DSH composition in bridge/ as an out-of-tree adapter contract. The bridge probes the installed host before mounting and throws when required route, turn-driver, session-event, interaction, or Settings capabilities are absent.

## Current behavior

createBridge() can register external-agent providers, dispatch primary turns, project provider activity, delegate subagent jobs, and dispose quiescently when the host implements BridgeHost. The Cordis patch is opt-in and contributes no routes by default.

Against the current DSH checkout, the host probe reports missing required capabilities. The blocked-composition test asserts the failure, so the bridge cannot be mistaken for a complete in-tree DSH integration.

## Alternatives considered

- Importing DSH internals would violate the standalone package boundary and make the bridge depend on unstable private APIs.
- Synthesizing an LLM adapter, DSH tool calls, or a second subagent loop would duplicate ownership and break native provider semantics.
- Omitting the probe would allow a partial mount that cannot drive an external turn or persist its events.

## Verification

The bridge TypeScript build and node test suite cover host capability probing, exact route dispatch, abort and error mapping, activity projection, delegation, disposal, and the blocked current-DSH composition path.
