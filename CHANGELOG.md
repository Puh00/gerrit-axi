<!-- markdownlint-configure-file { "MD024": { "siblings_only": true } } -->

# Changelog

What changed for someone using `gerrit` or `gerrit-axi`, newest release first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/). Each release's section
here is its GitHub Release notes, above the list of pull requests it merged.

## [Unreleased]

### Added

- `gerrit-axi publish --wip` publishes changes as work in progress and verifies each published revision's state by readback, including pushes answered with "no new changes".
- `gerrit-axi ready <change>` activates an open work-in-progress change over SSH without a new patch set or an HTTP token.
  Optional `--patch-set` and `--revision` guards refuse stale validation before writing, and readback verifies the same patch set and revision are active.
  An already-active change succeeds without writing; closed changes are refused.
  `--rest` selects the dedicated HTTP endpoint and REST reads with a stored token, without SSH fallback.
  REST uses Gerrit's notification behavior; SSH requests no email.
- `gerrit-axi wip <change>` marks an existing change work in progress over REST without a new patch set.
  It accepts the same guards and verifies the resulting state by readback; an already-WIP open change is a no-op.

## [0.5.0]

### Added

- `gerrit-axi watch <change>...` polls the changes named and exits with one
  record as soon as any of them changes: a vote added, changed or removed, a
  vote reset by a new patch set, a new patch set, new cover messages or inline
  comments, or a status such as `MERGED` or `ABANDONED`, each with who did it.
  `--timeout <secs>` gives up with `changed: false` and exit 6; `--since` takes
  an earlier record's `baseline`, or a file holding only it, so a restarted
  watch neither misses nor repeats a change.
  `--interval` sets the poll interval (default 60 seconds, at least 15).
- `gerrit-axi publish --stack` lists under `left_behind` the topic's open
  changes on the branch whose commits are no longer on HEAD, such as one whose
  commit was dropped before publishing again, with a `help` line to review and
  abandon them. Nothing is abandoned. If the server cannot be asked, the publish
  still succeeds and `left_behind_warning` says why.

### Fixed

- `needed_by` in `gerrit-axi show` fills `current`, which was always `null`:
  `false` marks an outdated patch set of the dependent, `true` its current one.
  `gerrit show` now marks an outdated dependent as superseded.

## [0.4.0]

### Changed

- `gerrit-axi status` rows carry only `change`, `subject`, `status` and `submit`,
  with no `labels` or `votes` table. `--fields <a,b>` adds any column `show`
  carries, `labels` or `votes` for that table, or `all` for the 0.3.0 shape; an
  unknown name is refused with the ones there are.

### Added

- A bare `gerrit-axi`, and `gerrit-axi dashboard`, open with the `bin` and
  `description` the ambient view already printed.

### Fixed

- `gerrit-axi submit` on a change that has already merged succeeds with
  `already_merged: true` and exit 0, instead of `SUBMIT_REFUSED` and exit 5. A
  genuine refusal is still `SUBMIT_REFUSED`.

## [0.3.0]

### Added

- Running `gerrit-axi` with no command shows your dashboard: your turn, work in
  progress, outgoing, incoming and CCed on, with per-section counts and the query
  behind each. `gerrit-axi dashboard --rows <n>` shows more rows per section.
- `gerrit-axi message <change>` posts one change-level message on the current patch
  set, read from stdin or `--file`. It records no vote.
- `gerrit-axi` records end with `help[]`, the next steps as complete commands that
  reach the same server, where the next step is not obvious.
- Long message and comment bodies are cut to their first 1000 characters, with
  `chars` and `truncated` on the row; `--full` on `show` and `comments` prints them
  whole.
- `status` reports `more` when `--limit` cut the page short.
- `gerrit-axi <command> --help` prints only that command's options, arguments and
  examples.
- `gerrit-axi setup hooks` opts in to a session-start hook for Claude Code, Codex
  and OpenCode that prints `gerrit-axi dashboard --ambient`, a count of what awaits
  you; `--remove` takes it out again. `gerrit-axi setup config` saves the current
  checkout's host, port and user to the config file.
- An installable Agent Skill, `skills/gerrit-axi/SKILL.md`.
- The README is short, with the agent tier, configuration and architecture moved to
  `docs/` and the tests to `CONTRIBUTING.md`; release notes now come from this file.

### Fixed

- A `gerrit-axi` failure writes its error record to stdout, where an agent reads,
  instead of stderr; stderr stays empty. Exit codes and the record's fields are
  unchanged.
- An unknown option is refused by name, with the options that command does take
  and a "did you mean" for a near miss, before git or the server is asked anything.
  An unknown `--name=value` no longer reads as an option that takes no value.
- `gerrit-axi --version`, `-V` and the newly accepted `-v` print the bare version
  number, without loading the rest of the tool.

## [0.2.0]

### Added

- `gerrit-axi publish` pushes the commits on HEAD as changes, either
  `--stack --topic <t>`, one change per commit, or `--squash`, one change. An
  existing Change-Id is pushed as it is, and a missing one is stamped and kept on
  the local branch.
- `gerrit-axi submit <change>` asks the server to submit a change, and reports a
  refusal in the server's words. Neither binary can vote.
- Each version tag has a GitHub Release with an installable tarball built by CI.

### Fixed

- A user or host beginning with `-`, from any source including the `origin`
  remote, is refused rather than passed to ssh, which would read it as an option.

[0.5.0]: https://github.com/slnkjthien/gerrit-axi/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/slnkjthien/gerrit-axi/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/slnkjthien/gerrit-axi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/slnkjthien/gerrit-axi/releases/tag/v0.2.0
