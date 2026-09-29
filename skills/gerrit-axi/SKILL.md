---
name: gerrit-axi
description: "Work with Gerrit code review through the gerrit-axi CLI: what awaits you, where a change stands (labels, votes, what blocks submit), inline review comments with bots split from humans, publishing a branch as a stack or one change, posting a change message, and submitting. Use whenever a task touches a Gerrit change or a checkout whose origin is a Gerrit remote. It cannot vote."
user-invocable: false
---

# gerrit-axi

Gerrit code review for agents: records on stdout (TOON, or JSON with `--json`),
a typed error record with `ok: false` on failure, and a `help[]` of next steps as
complete commands.

The binary has to be installed first (see the project README's Install
section); it is not on npm, so `npx` will not find it. It talks to Gerrit over ssh, so the
user's SSH key must be registered there. REST calls (inline comments, submit)
also need a stored token: if a record says the user is not signed in, ask them
to run `gerrit auth login` themselves. Never handle a token yourself.

## Workflow

1. Run `gerrit-axi` with no arguments, inside the checkout, for the dashboard:
   your turn, work in progress, outgoing, incoming, CCed on.
2. Run `gerrit-axi show <change>... --comments` for the full state of one or
   more changes; a whole stack goes in one call.
3. Follow the `help[]` lines each record ends with.

Host, port, user and project come from the checkout's `origin` remote, then
`GERRIT_HOST`/`GERRIT_USER`/`GERRIT_PORT`, then the config file. Outside a
Gerrit checkout, pass `--host <host>` after the command.

## Commands

```text
gerrit-axi                           the dashboard (also `gerrit-axi dashboard`)
gerrit-axi status [mine|<change>...] changes awaiting you, yours, or those named
gerrit-axi status --query '<query>'  any Gerrit query; spell negation NOT, never a leading -
    --fields <a,b>                   add columns to status rows, labels/votes, or all
gerrit-axi show <change>...          review state: changes, labels, votes
gerrit-axi comments <change>...      inline comments (--bots | --humans)
gerrit-axi auth status               whether the stored credential still works
gerrit-axi publish --stack --topic <t>   each commit on HEAD becomes a change
gerrit-axi publish --squash          the commits on HEAD become one change
gerrit-axi submit <change>           ask the server to submit one change
gerrit-axi message <change>          post one change message, text on stdin or --file
gerrit-axi setup hooks               opt in to a dashboard summary at every session start
```

Run `gerrit-axi --help` for every option.

## Rules

- It cannot vote, add reviewers, or set labels, and no workaround exists: ask
  the user when a change needs a vote.
- `submit` only a change the server marks submittable; a refusal comes back in
  the server's own words. A change that has already merged is a success with
  `already_merged: true`.
- `status` rows are short (`change`, `subject`, `status`, `submit`); use `show`
  for labels, votes and what blocks a change, or `status --fields` to add columns.
- `publish` keeps every Change-Id a commit already has. Never edit or strip one:
  a new Change-Id makes a new change and orphans the review.
- Bodies over 1000 characters are cut, with `truncated: true` on the row; add
  `--full` for the whole text.
