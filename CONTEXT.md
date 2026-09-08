# Native Agents on DSH

Native agents own their execution and conversation state; DSH owns the visible conversation and interaction authority.

## Language

**Native agent**:
A foreign runtime that owns a complete turn and its tools, rather than supplying tokens for DSH-owned tool execution.
_Avoid_: LLM route, proxy

**Native turn**:
One prompt and its resulting native execution, with a completed, cancelled, or failed outcome. A DSH turn can contain more than one native turn when an approved plan continues.
_Avoid_: Token request, DSH turn

**Native binding**:
The association between a DSH conversation and the native agent conversation that owns its context. A resume cursor identifies that native conversation; a binding without one does not promise resumability.
_Avoid_: Ready flag, cached connection

**Native activity**:
Observed work and trajectory relationships reported by a native agent. Displaying it does not authorize or re-execute its tools.
_Avoid_: DSH tool call, executable transcript
