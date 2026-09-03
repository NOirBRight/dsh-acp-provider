# Issue tracker: GitHub

Issues and specs for this repository live in [NOirBRight/dsh-acp-provider GitHub Issues](https://github.com/NOirBRight/dsh-acp-provider/issues). Use the `gh` CLI for all operations.

## Conventions

- Create an issue: `gh issue create --repo NOirBRight/dsh-acp-provider --title "..." --body "..."`.
- Read an issue: `gh issue view --repo NOirBRight/dsh-acp-provider <number> --comments`.
- List issues: `gh issue list --repo NOirBRight/dsh-acp-provider --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment --repo NOirBRight/dsh-acp-provider <number> --body "..."`.
- Apply or remove labels: `gh issue edit --repo NOirBRight/dsh-acp-provider <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue: `gh issue close --repo NOirBRight/dsh-acp-provider <number> --comment "..."`.

Commands may omit `--repo` when run inside this repository because `gh` infers the remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue. When a skill says to fetch a ticket, read the corresponding GitHub issue and its comments.
