# Agent Note: DSH composition bridge

Status: retired experiment. The supported composition uses the DSH LLM adapter with ExternalAgentTurnRunner; this probe does not describe the current host integration. See the package README. The experimental code is retained as a standalone probe, not a required provider entry point.

## Decision

Keep DSH composition in bridge/ as an out-of-tree adapter contract. The bridge probes the installed host before mounting and throws when required route, turn-driver, session-event, or interaction capabilities are absent.

## Current behavior

createBridge() can register external-agent routes, dispatch primary turns, fold stored session events, delegate scoped approval options with warnings and question interactions, and dispose quiescently when the host implements BridgeHost. The Cordis patch is opt-in and contributes no routes by default. Settings contribution and routable reporting remain outside BridgeHost.

Against the current DSH checkout, the host probe reports missing required capabilities. The blocked-composition test asserts the failure, so the bridge cannot be mistaken for a complete in-tree DSH integration.

## Alternatives considered

- Importing DSH internals would violate the standalone package boundary and make the bridge depend on unstable private APIs.
- Synthesizing an LLM adapter, DSH tool calls, or a second subagent loop would duplicate ownership and break native provider semantics.
- Omitting the probe would allow a partial mount that cannot drive an external turn or persist its events.

## Verification

The bridge TypeScript build and node test suite cover host capability probing, exact route dispatch, abort and error mapping, activity projection, delegation, disposal, and the blocked current-DSH composition path.
