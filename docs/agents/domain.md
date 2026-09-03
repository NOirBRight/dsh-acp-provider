# Domain Docs

This is a single-context repository. Engineering skills consume its domain documentation using the following rules.

## Before exploring

Read the root `CONTEXT.md` when it exists and the relevant ADRs under `docs/adr/`. If either location is absent, proceed silently; domain documentation is created only when resolved terminology or decisions need a durable home.

## Layout

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use terms as defined in `CONTEXT.md` in issues, designs, hypotheses and tests. If a required concept is missing, reconsider whether the term belongs to this domain or record the gap for domain modeling.

## ADR conflicts

Surface any conflict with an existing ADR explicitly rather than silently overriding it.
