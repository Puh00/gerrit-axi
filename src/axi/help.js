// SPDX-License-Identifier: Apache-2.0

/**
 * The help text: the full usage for `gerrit-axi --help`, and one concise page per
 * command for `gerrit-axi <command> --help`.
 *
 * Both list every option a command takes, from `COMMAND_OPTIONS` in args.js;
 * test/axi.test.js holds each page to that catalogue. A command page names its
 * own options, its arguments and a few examples, and points at the full usage
 * for the global options rather than repeating their descriptions.
 */

export const USAGE = `gerrit-axi - Gerrit for agents: your dashboard, review state as records, watch, publish, ready, message, and submit

usage: gerrit-axi [<command>] [options]
       gerrit-axi <command> --help     that command's options and examples

With no command it prints your dashboard: this binary and one line on what it
is, then the changes awaiting your attention, your work in progress, your
outgoing reviews, the reviews you were asked for and the changes you are CCed
on, grouped as Gerrit's own dashboard groups them, with a count per section and
the next step to run.

Records go to stdout: TOON by default, strict JSON with --json. A failure writes
a typed error record to stdout in that same format, with ok: false, writes
nothing to stderr, and exits non-zero, so a caller reads one stream and the
exit code says what it holds. An option a command does not take is refused
before anything is asked of git or the server (exit 2), and the record's remedy
lists the options that command does take, naming the nearest when a misspelling
is close.

A record ends with help[] -- the next steps, as complete commands carrying this
call's --host and its siblings -- only where the next step is not obvious: after
a list, after publish, submit, message or watch, and whenever something was held
back.
A detail view or a confirmation carries none. A failure's help[] is the command
that fixes or diagnoses it, when there is one.

commands, and the options each one takes:
  dashboard                   the home view above, by name
      --rows <n>              rows shown per section (default 10, max 100)
      --ambient               what a session-start hook prints: this binary,
                              one line on what it is, and a count per section,
                              asked of the server only in a Gerrit checkout;
                              never fails, exit 0
  status                      changes awaiting your attention ("your turn")
  status mine                 your open changes
  status <change>...          specific change numbers
  status --query '<query>'    an arbitrary Gerrit query
      --limit <n>             maximum changes to fetch (default 100)
      --fields <a,b>          columns to add to the default change, subject,
                              status, submit: any changes column of show,
                              labels or votes for that table, or all
  show <change>...            full review state, one record per change
      --messages <n|all>      also emit that many cover messages (default 0)
      --comments              also emit the inline comments
      --bots | --humans       with --comments: only / never machine-generated
      --full                  whole message and comment bodies; without it a
                              body over 1000 characters is cut to its first
                              1000, its row says chars (the total) and
                              truncated: true, and help[] names this option
  comments <change>...        inline review comments on every change named
      --bots | --humans       only / never machine-generated
      --full                  whole comment bodies, as for show
  auth status                 whether the stored credential still works
  publish --stack --topic <t> every commit on HEAD since it left the server's
                              branch becomes its own change, under topic <t>
  publish --squash            those commits become one change
      --wip                  publish as work in progress; verify by readback
      --branch <b>            the branch to propose against (default: the
                              server's default branch)
  ready <change>             activate a work-in-progress change over SSH
      --patch-set <n>         refuse if the current patch set differs
      --revision <sha>        refuse if the current revision differs
  submit <change>             ask the server to submit one change; a refusal is
                              reported in the server's own words, and a change
                              already merged is a success, already_merged: true
  message <change>            post one change-level message on the change's
                              current patch set; the text is read from stdin
      --file <path>           ...or from this file. Never from argv. No label,
                              no vote: the record names the patch set it landed on
  watch <change>...           wait until a vote, a patch set, a cover message, an
                              inline comment or the status changes on any change
                              named, then print one record of what and who
      --interval <secs>       seconds between polls (default 60, at least 15)
      --timeout <secs>        give up after this long: the same record with
                              changed: false, and exit 6 (default: wait on)
      --since <baseline>      compare against an earlier record's baseline, or a
                              file holding only that baseline, so a restarted
                              watch neither misses nor repeats a change
  setup hooks                 opt in to session integration: register
                              'gerrit-axi dashboard --ambient' as a session-start
                              hook for Claude Code, Codex and OpenCode, in your
                              user config; repeating it changes nothing, and it
                              repairs a moved binary. It first checks the
                              connection and sign-in, and names the human command
                              that fixes what is missing
      --remove                take out only those hooks, leaving every other
                              hook and Codex's shared hooks flag alone
  setup config                save the host, port and user this checkout's origin
                              resolves to in the config file; never overwrites one

global options:
  --json          strict JSON instead of TOON
  --host <h>      override the resolved Gerrit host
  --user <u>      override the resolved Gerrit username
  --port <p>      override the Gerrit SSH port
  --project <p>   override the resolved project
  --rest-base <u> override the REST base URL (e.g. https://gerrit.example.com)
  -h, --help      show this help; after a command, only that command's help
  -v, -V, --version
                  print the bare version

Every read answers about a whole list of changes in one invocation. Per-change
scalars arrive in the 'changes' table; anything per-label arrives in 'labels' and
'votes', keyed by change number and label name, so a label the server gains adds
a row and moves no column. show carries all three; status carries a short
'changes' row unless --fields asks for more.

Host, port, user and project are resolved from the 'origin' git remote of the
current directory first, then from GERRIT_HOST / GERRIT_USER / GERRIT_PORT, then
from the config file. There is no built-in default host.

Exit codes: 0 success, 1 other error, 2 usage, 3 configuration, 4 authentication,
5 transport, 6 watch reached --timeout with nothing changed.

publish keeps every Change-Id a commit already carries, verbatim: the same
Change-Id is what makes a push a new patch set of the same change. A commit
without one gets one stamped into its message, and the local branch is rewritten
to keep it (messages only; the working tree is untouched).

It publishes, posts a change message, and submits, and it cannot vote: no command
records a label, and whether a change may be submitted is decided by the server
alone.`;

/**
 * One page per command, keyed as `COMMAND_OPTIONS` is.
 *
 * @type {Record<string, string>}
 */
export const COMMAND_HELP = {
  dashboard: `gerrit-axi dashboard - your Gerrit dashboard; also what a bare gerrit-axi prints

usage: gerrit-axi [dashboard] [options]

This binary and one line on what it is, then the changes awaiting your
attention, your work in progress, your outgoing reviews, the reviews you were
asked for and the changes you are CCed on, with a count per section. Takes no
arguments.

options:
  --rows <n>              rows shown per section (default 10, max 100)
  --ambient               what a session-start hook prints: this binary, one
                          line on what it is, and a count per section, asked of
                          the server only in a Gerrit checkout; never fails,
                          exit 0

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi
  gerrit-axi dashboard --rows 25
  gerrit-axi dashboard --ambient
  gerrit-axi --json`,
  status: `gerrit-axi status - one short row per change: what it is and whether it can submit

usage: gerrit-axi status [mine | <change>... | --query '<query>'] [options]

arguments (at most one form):
  (none)                  changes awaiting your attention ("your turn")
  mine                    your open changes
  <change>...             these change numbers
  --query '<query>'       an arbitrary Gerrit query, as one argument

options:
  --limit <n>             maximum changes to fetch (default 100)
  --fields <a,b>          add to the default columns (change, subject, status,
                          submit): project, branch, topic, owner, wip,
                          submittable, blocked_on, patch_set, revision, ref,
                          updated, created, url; labels or votes for that
                          table; all for every column and both tables

A row always has the default columns; show <change>... is the full review state.

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi status
  gerrit-axi status mine
  gerrit-axi status --query 'status:open project:<project>' --limit 20
  gerrit-axi status mine --fields owner,blocked_on,labels`,
  show: `gerrit-axi show - full review state, one record per change

usage: gerrit-axi show <change>... [options]

arguments:
  <change>...             one or more change numbers (required)

options:
  --messages <n|all>      also emit the newest n cover messages, or all
                          (default 0)
  --comments              also emit the inline comments
  --bots | --humans       with --comments: only / never machine-generated
  --full                  whole message and comment bodies; without it a body
                          over 1000 characters is cut to its first 1000 and its
                          row says chars and truncated: true

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi show 12345
  gerrit-axi show 12345 12346 --messages 3
  gerrit-axi show 12345 --comments --humans --full`,
  comments: `gerrit-axi comments - the inline review comments on every change named

usage: gerrit-axi comments <change>... [options]

arguments:
  <change>...             one or more change numbers (required)

options:
  --bots | --humans       only / never machine-generated (default: both)
  --full                  whole comment bodies; without it a body over 1000
                          characters is cut to its first 1000

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi comments 12345
  gerrit-axi comments 12345 12346 --humans
  gerrit-axi comments 12345 --full`,
  auth: `gerrit-axi auth - whether the stored credential still works

usage: gerrit-axi auth [status]

arguments:
  status                  the only subcommand, and the default. Storing or
                          removing a credential is 'gerrit auth login' and
                          'gerrit auth logout', in the human CLI

Takes no options of its own.

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi auth status
  gerrit-axi auth status --json`,
  ready: `gerrit-axi ready - activate a work-in-progress change without a new patch set

usage: gerrit-axi ready <change> [--patch-set <n>] [--revision <sha>]

Exactly one change number is required.
Uses SSH only: gerrit review --json, with no HTTP token.
The REST alternative (POST /a/changes/<id>/ready with an HTTP token) is outside
this command's scope and could follow in a separate PR.
An already-active open change succeeds without writing. Closed changes are refused.

options:
  --patch-set <n>         expected current patch set number
  --revision <sha>        expected full lowercase commit object ID

Guards are checked before writing. Readback must confirm an active change on the
same patch set and revision. These checks are not an atomic concurrency lock.
No votes or email notifications are requested.

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi ready 12345 --patch-set 2
  gerrit-axi ready 12345 --json`,
  publish: `gerrit-axi publish - push the commits on HEAD for review, as changes

usage: gerrit-axi publish --stack --topic <t> [--branch <b>] [--wip]
       gerrit-axi publish --squash [--branch <b>] [--wip]

Publishes every commit on HEAD since it left the server's branch. Takes no
arguments; exactly one of --stack or --squash is required.

options:
  --stack                 each commit becomes its own change
  --topic <t>             the topic the stack's changes share (required with
                          --stack, refused with --squash)
  --wip                   publish as work in progress; verify by readback
  --squash                the commits become one change
  --branch <b>            the branch to propose against (default: the server's
                          default branch)

A Change-Id a commit already carries is pushed verbatim, so a republish is a new
patch set of the same change; a commit without one gets one stamped into its
message and the local branch is rewritten to keep it (messages only).

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi publish --stack --topic retry-backoff
  gerrit-axi publish --squash
  gerrit-axi publish --squash --branch release-2`,
  submit: `gerrit-axi submit - ask the server to submit one change

usage: gerrit-axi submit <change>

arguments:
  <change>                exactly one change number (required); the server
                          submits whatever must go with it

Takes no options of its own. A refusal is reported in the server's own words;
whether a change may be submitted is the server's decision alone. A change that
has already merged is a success with already_merged: true, so submitting twice
is a no-op.

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi submit 12345
  gerrit-axi submit 12345 --json`,
  message: `gerrit-axi message - post one change-level message on a change's current patch set

usage: gerrit-axi message <change> [--file <path>]

arguments:
  <change>                exactly one change number (required)

options:
  --file <path>           read the text from this file; without it the text is
                          read from stdin. Never from argv

No label, no vote: the record names the patch set the message landed on.

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  echo 'Rebased onto the fix; ready for another look.' | gerrit-axi message 12345
  gerrit-axi message 12345 --file reply.txt`,
  watch: `gerrit-axi watch - wait for something to happen on any of the changes named

usage: gerrit-axi watch <change>... [options]

arguments:
  <change>...             one or more change numbers (required)

Polls every --interval seconds, one gerrit query for all of them, and exits with
one record as soon as any has a vote added, changed, removed or reset by a new
patch set, a new patch set, new cover messages or inline comments, or a new
status such as MERGED or ABANDONED: the changes table says which, and deltas
says what and who. The record's baseline is where it stopped; pass it back with
--since, or save it to a file and pass that.

options:
  --interval <secs>       seconds between polls (default 60, at least 15)
  --timeout <secs>        give up after this long with changed: false and exit
                          6 (default: wait until something changes)
  --since <baseline>      compare against this baseline from an earlier record,
                          or a file holding only that baseline, at once

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi watch 12345 12346
  gerrit-axi watch 12345 --timeout 3600 --json | jq -r .baseline > last.baseline
  gerrit-axi watch 12345 --since last.baseline`,
  setup: `gerrit-axi setup - opt in to session integration, in your own user config

usage: gerrit-axi setup hooks [--remove]
       gerrit-axi setup config

arguments:
  hooks                   register gerrit-axi's ambient dashboard as a
                          session-start hook for Claude Code, Codex and
                          OpenCode; repeating it changes nothing, and it repairs
                          a moved binary. It first checks the connection and
                          sign-in, and names the human command that fixes what
                          is missing
  config                  save the host, port and user this checkout's origin
                          resolves to in the config file; never overwrites one

options:
  --remove                with hooks: take out only gerrit-axi's own hooks,
                          leaving every other hook and Codex's shared hooks
                          flag alone

Nothing is written to an agent's configuration unless you run this.

global options: --json, --host <h>, --user <u>, --port <p>, --project <p>,
  --rest-base <u> (see gerrit-axi --help)

examples:
  gerrit-axi setup hooks
  gerrit-axi setup hooks --remove
  gerrit-axi setup config`,
};
