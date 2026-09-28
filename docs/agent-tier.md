# The agent tier

`gerrit-axi` is the second binary. It imports the core library and prints
records; nothing in it renders a table, and nothing in it reads one. Same
transport, same readiness oracle, same three-tier configuration, same exit
codes — a different output contract.

```text
gerrit-axi                             your dashboard: your turn, work in progress,
                                       outgoing, incoming, CCed on
gerrit-axi dashboard                   the same, by name
    --rows <n>                         rows shown per section (default 10, max 100)

gerrit-axi status                      your attention set, as records
gerrit-axi status mine                 your open changes
gerrit-axi status <change>...          specific change numbers
gerrit-axi status --query '<query>'    an arbitrary Gerrit query
    --limit <n>                        maximum changes to fetch (default 100)

gerrit-axi show <change>...            full review state, one record per change
    --messages <n|all>                 also emit that many cover messages (default 0)
    --comments                         also emit the inline comments
    --bots | --humans                  with --comments: only / never machine-generated
    --full                             whole message and comment bodies (see below)

gerrit-axi comments <change>...        inline review comments on every change named
    --bots | --humans                  only / never machine-generated
    --full                             whole comment bodies

gerrit-axi auth status                 whether the stored credential still works

gerrit-axi publish --stack --topic <t> each commit on HEAD becomes its own change, under topic <t>
gerrit-axi publish --squash            the commits on HEAD become one change
    --branch <b>                       the branch to propose against (default: the server's default)

gerrit-axi submit <change>             ask the server to submit one change

gerrit-axi message <change>            post one change-level message on the current patch set
    --file <path>                      read the text from a file instead of stdin

gerrit-axi setup hooks                 opt in: run the ambient view at every agent session start
    --remove                           take those hooks out again
gerrit-axi setup config                save this checkout's host, port and user to the config file
gerrit-axi dashboard --ambient         the view a session-start hook prints (see below)
```

Global options: `--json`, `--host`, `--user`, `--port`, `--project`,
`--rest-base`, `-h/--help`, `-v/-V/--version` (the bare version). As with
`gerrit`, every option is listed in `gerrit-axi --help` too, and
`gerrit-axi <command> --help` prints only that command's options, arguments and
examples. An option a command does not take is refused,
never dropped, and the error record lists the options it does take — see
[Failures](#failures).

## Records, not layout

Output is [TOON](https://toonformat.dev) on stdout, or strict JSON with `--json`.
Both carry the same keys.

```console
$ gerrit-axi show 200101 200102 200103
ok: true
op: show
count: 3
missing: []
changes[3]{change,subject,project,branch,topic,owner,status,wip,submit,submittable,blocked_on,patch_set,revision,ref,updated,created,url}:
  200101,Split the queue reader out of the daemon,acme/apps/widget-console,main,stack-of-three,ada,NEW,false,OK,true,"",4,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,refs/changes/01/200101/4,"2026-07-31T22:13:20.000Z","2026-07-20T08:26:40.000Z","https://gerrit.example.com/c/acme/apps/widget-console/+/200101"
  200102,Give the queue reader its own retry ceiling,acme/apps/widget-console,main,stack-of-three,ada,NEW,false,NOT_READY,false,"Xylophone-Gate,Zebu-Herding",2,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,refs/changes/02/200102/2,"2026-08-02T02:00:00.000Z","2026-07-21T12:13:20.000Z","https://gerrit.example.com/c/acme/apps/widget-console/+/200102"
  200103,Wire the retry ceiling to the managed configuration,acme/apps/widget-console,main,stack-of-three,ada,NEW,true,NOT_READY,false,Quokka-Review,1,cccccccccccccccccccccccccccccccccccccccc,refs/changes/03/200103/1,"2026-08-03T05:46:40.000Z","2026-07-22T16:00:00.000Z","https://gerrit.example.com/c/acme/apps/widget-console/+/200103"
labels[7]{change,label,status,blocking,by}:
  200101,Quokka-Review,OK,false,grace
  200101,Xylophone-Gate,OK,false,buildbot
  200102,Quokka-Review,OK,false,grace
  200102,Xylophone-Gate,NEED,true,null
  200102,Zebu-Herding,NEED,true,null
  200103,Quokka-Review,REJECT,true,alan
  200103,Xylophone-Gate,OK,false,buildbot
votes[6]{change,label,value,by,granted}:
  200101,Quokka-Review,2,grace,"2026-07-31T21:56:40.000Z"
  200101,Xylophone-Gate,1,buildbot,"2026-07-31T22:05:00.000Z"
  200102,Quokka-Review,2,grace,"2026-08-02T01:43:20.000Z"
  200103,Quokka-Review,1,grace,"2026-08-02T15:53:20.000Z"
  200103,Quokka-Review,-2,alan,"2026-08-03T03:00:00.000Z"
  200103,Xylophone-Gate,1,buildbot,"2026-08-02T18:40:00.000Z"
depends_on[2]{change,related,revision,ref,current}:
  200102,200101,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,refs/changes/01/200101/4,true
  200103,200102,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,refs/changes/02/200102/1,false
needed_by[2]{change,related,revision,ref,current}:
  200101,200102,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,refs/changes/02/200102/2,true
  200102,200103,cccccccccccccccccccccccccccccccccccccccc,refs/changes/03/200103/1,true
```

Four properties are the point of that shape, and each one replaces a thing a
shell script screen-scraping `gerrit`'s table had to do by hand:

- **One invocation, a whole list.** A watch following a nine-change stack makes
  one call and gets nine records. `status` and `show` both send a single
  `gerrit query`; the dashboard sends four, one per question the server answers
  in one query; `comments` needs one REST call per change, because that is what
  the endpoint offers.
- **Labels are keyed by name, never by column.** Per-change scalars live in
  `changes`; anything per-label lives in `labels` and `votes`, joined on
  `(change, label)`. `200102` above carries a label the other two do not, and it
  arrives as an extra row — no header changes, so nothing a consumer reads by
  name moves. `blocked_on` is the server's own blocking-label list, joined, for a
  watch that wants to diff one string; the `labels` table is the authority.
- **Readiness is the server's verdict, not arithmetic over votes.** `submit`,
  `submittable`, and each label's `status` come from `--submit-records` through
  core's `deriveReadiness`. No label name appears anywhere in the tier.
- **A change that is gone is data.** Numbers the server did not return come back
  under `missing`, so "abandoned, or no longer visible to you" is distinguishable
  from "the call failed".

`show` asks the server for the cover messages only when `--messages` will emit
them, because that detail costs work per row. The stack is always asked for: a
parent revision going stale is what a stack watch exists to notice.

## Next steps

A document ends with `help[]`, the next steps as complete commands, only where
the next step is not obvious: after a list (`status`), after a write (`publish`,
`message`, a `submit` the server did not report as merged), and whenever
something was held back. A detail view that answers whole, such as `show`, and a
confirmation, such as a merged `submit`, carry none, and the key is absent
rather than empty. A failure's `help[]` is the command that fixes or diagnoses it,
when one exists; it never says "see `--help`".

Three rules hold for every line. It is a complete command carrying the `--host`,
`--port`, `--user`, `--project` and `--rest-base` of the call it follows, so it
reaches the same server (`--json` is a format, not a disambiguator, and is not
carried). A value the caller has yet to choose is a placeholder, `<change>` or
`<path>`; a value the record already holds, such as the numbers a `publish`
created, is written concretely. And it never suggests what the tool does not do:
no line names a vote, a label or a reviewer, and `submit` is named only for a
change the server's own submit records mark submittable, never after the server
refused one.

After the `changes`, `labels` and `votes` tables, `status mine` on the stack
above ends with:

```text
help[2]: Run `gerrit-axi show <change>... --comments` for the full review state of a listed change,Run `gerrit-axi submit <change>` for a change the server marks submittable: 200101
```

`status` also carries `more`, the server's word that `--limit` cut the page
short; when it is true the last line of `help` repeats the call with the limit
raised tenfold. `help` is prose for whoever reads the log, not a field to branch
on.

## Long bodies

A cover message or inline comment can run to thousands of characters, and a
bot's usually does. Both tables carry the body cut to its first 1000 characters
by default, with the row saying so: `chars` is the whole body's length and
`truncated` is `true`. No marker is mixed into the text, so `message` is always
the body's own characters and a consumer can compare it. The cut is by
character, never through a surrogate pair. `--full`, on `show` and `comments`,
lifts it, and `help` names that call only when a body was actually cut:

```text
help[1]: Run `gerrit-axi comments 200103 --full` for the full text of 1 truncated body (longest 8432 chars)
```

`show --full` without `--messages` or `--comments` is refused: nothing it could
apply to is emitted.

## The dashboard

With no command, `gerrit-axi` prints content rather than usage: your open changes
grouped the way Gerrit's own dashboard groups them. Usage is for `--help`.

```console
$ gerrit-axi
ok: true
op: dashboard
user: ada
host: gerrit.example.com
total: 6
sections[5]{section,count,shown,more,query}:
  your_turn,1,1,false,"attention:self status:open"
  wip,1,1,false,"owner:self status:open is:wip"
  outgoing,2,2,false,"owner:self status:open NOT is:wip"
  incoming,2,2,false,"reviewer:self NOT owner:self NOT is:wip status:open"
  cced,0,0,false,"cc:self NOT is:wip status:open"
entries[6]{section,change,subject,owner,submit}:
  your_turn,184458,Stop the widget from re-entering the queue twice,ada,NOT_READY
  wip,200103,Wire the retry ceiling to the managed configuration,ada,NOT_READY
  outgoing,200102,Give the queue reader its own retry ceiling,ada,NOT_READY
  outgoing,200101,Split the queue reader out of the daemon,ada,OK
  incoming,300202,Let the queue reader name its own thread,alan,OK
  incoming,300201,Retire the legacy widget poller,grace,NOT_READY
help[1]: Run `gerrit-axi show 184458 --comments` for the full state of what awaits you
```

`sections` is the summary, one row per section whether or not anything matched:
`count` is how many changes it holds, `shown` how many rows of `entries` carry it,
and `more` whether any were held back, by the ten-row cap (`--rows` raises it, to
at most 100) or by the server. `query` is the Gerrit query that reproduces the
section on its own, ready for `status --query`. `entries` is keyed on
`(section, change)`: a change that is both your turn and your outgoing review
appears under each, as it does on Gerrit's dashboard, and `total` counts it once.
`submit` is the server's verdict, the same field `status` and `show` carry; the
dashboard says what is there, and `show` says where it stands.

`help` names the next step: the `show` for what awaits you, the `status --query`
for the rest of a truncated section (with a larger `--limit` when the server held
rows back), the `publish` when nothing of yours is open. Its lines follow the
rules in [Next steps](#next-steps).

It costs four `gerrit query` round trips, run one at a time: a query row carries
neither the attention set nor whether you are a reviewer or a CC, so the sections
cannot be split locally from one query. Work in progress and outgoing reviews do
share a call, since `wip` is on the row.

When no host can be resolved the dashboard fails like every other command, with
an error record on stdout and a non-zero exit — see [Failures](#failures).

## Session integration

An agent session learns gerrit-axi exists, and what awaits you, only if something
tells it. There are two ways to tell it, and you need one of them.

**A session-start hook.** `gerrit-axi setup hooks` registers
`gerrit-axi dashboard --ambient` to run when a session starts, in your user
config for Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/hooks.json`,
plus `hooks = true` under `[features]` in `~/.codex/config.toml`, which Codex needs
before it runs any hook) and OpenCode (a plugin,
`~/.config/opencode/plugins/axi-gerrit-axi.js`); `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` and `XDG_CONFIG_HOME` move them as they move each agent's own
config. Nothing is written there unless you run it. The hook names `gerrit-axi`
when that is this binary on your `PATH`, and its absolute path otherwise; running
setup again changes nothing, or repairs the path after a move. The record lists
each file and what happened to it.

Before it installs, setup checks what the hook will need and says what is
missing, as the human command that fixes it: a host or user that does not
resolve, or `gerrit auth login` for a credential that is missing or that the
server rejects. It never asks for, reads or stores a credential itself. In a
Gerrit checkout with no config file yet, it offers `gerrit-axi setup config`,
which writes that checkout's host, port and user to the config file so the
dashboard resolves outside it too; it never overwrites a config file that
exists.

`gerrit-axi setup hooks --remove` takes out exactly those hooks, recognised by
their command, and the plugin file if gerrit-axi wrote it. Every other hook stays,
and so does the Codex flag, which other tools' hooks rely on. A file setup cannot
parse, or a plugin it did not write, is reported under `failures` and left alone.

The ambient view loads into every session, so it is the dashboard's counts
without its rows:

```console
$ gerrit-axi dashboard --ambient
bin: ~/.local/bin/gerrit-axi
description: "Gerrit code review for agents: ..."
host: gerrit.example.com
user: ada
sections[5]{section,count}:
  your_turn,0
  wip,1
  outgoing,2
  incoming,2
  cced,0
help[2]: Nothing awaits your attention.,Run `gerrit-axi` for the changes in each section
```

It queries the server only in a checkout whose `origin` is a Gerrit remote.
Anywhere else it prints just `bin`, `description` and
one line on where to start, and nothing leaves the machine. It never fails: an
unreachable server is a `help` line, a missing credential adds a `Not signed in`
line naming `gerrit auth login`, and the exit code is 0.

**An installable skill.** [`skills/gerrit-axi/SKILL.md`](../skills/gerrit-axi/SKILL.md)
loads only when a task needs it, costs nothing per session, and works in any agent
that reads [Agent Skills](https://agentskills.io):

```sh
npx skills add slnkjthien/gerrit-axi --skill gerrit-axi
```

It carries no live state, which only the hook can show. `test/setup.test.js`
fails if it stops naming a command or names one that does not exist.

## Inline comments

Inline comments are where a reviewer actually reviews, and the SSH cover messages
do not carry them — so this is the only path that reaches them, and `bot` is
typed rather than implied:

```console
$ gerrit-axi comments 200103
ok: true
op: comments
count: 3
comments[3]{change,file,line,patch_set,author,bot,bot_kind,unresolved,severity,id,in_reply_to,updated,message,chars,truncated}:
  200103,/PATCHSET_LEVEL,null,1,review-assistant,true,ai-review,false,null,stk0001,null,"2026-08-03T07:41:02.000Z",Reviewed patch set 1. Found 1 issue.,36,false
  200103,src/main/java/com/acme/widget/RetryCeiling.java,18,1,review-assistant,true,ai-review,true,null,stk0002,null,"2026-08-03T07:41:03.000Z","[issue] The managed value is read before the provider is bound.",63,false
  200103,src/main/java/com/acme/widget/RetryCeiling.java,18,1,alan,false,null,true,null,stk0003,stk0002,"2026-08-03T09:02:55.000Z","Right, and the parent change has to land first.",47,false
help[1]: Run `gerrit-axi show 200103 --messages all` for the cover messages and where each change stands
```

`bot` is Gerrit's own `autogenerated:` tag convention and `bot_kind` is the
suffix the bot declared, so a reviewer nobody has heard of is classified the
first time it posts — see [Tier 1](configuration.md#tier-1--derived-from-the-server). `severity`
is `null` unless [tier-3 patterns](configuration.md#tier-3--genuinely-local-convention) are
configured. `chars` and `truncated` are the body's size and whether it was cut to
its preview, as [Long bodies](#long-bodies) describes. `gerrit-axi show
--comments` adds this same table to a `show`, so one invocation can answer a
whole watch.

## Publishing and submitting

`publish` turns the commits on HEAD — everything since it left the server's
branch — into changes, with one push to `refs/for/<branch>`. The shape is named
on every call, never guessed:

- `--stack --topic <name>` makes each commit its own change, parent chain intact,
  all under the topic. The push sets the topic; nothing else does.
- `--squash` makes them one change: HEAD's tree on top of the base, carrying the
  oldest commit's message. The same branch always squashes to the same commit, so
  publishing it again changes nothing, and the server says "no new changes".

The branch defaults to the one the server's HEAD names; `--branch` picks another.
The base is read off the server rather than a remote-tracking ref, so a stale
fetch cannot make merged commits look new. The server's tip must already be in
the local repository, though; `git fetch` first if it is not.

**A Change-Id is the change's identity, and it is never regenerated.** Pushing the
same Change-Id again adds a patch set to the same change; a different one creates
a different change and orphans the first one's review. So every Change-Id a
commit already carries is pushed verbatim. A commit that needs one and has none —
every commit of a stack, or the oldest commit of a squash — gets one stamped into
its message, and the local branch is rewritten to keep it, since an id that
existed only in the push would be a different one next time. The rewrite changes
messages only, never a tree, so the working tree and index are untouched, and
`rewritten_from` records where HEAD was.

```console
$ gerrit-axi publish --stack --topic stack-of-three
ok: true
op: publish
shape: stack
branch: main
topic: stack-of-three
base: e3b1f0c2a9d84c5b7f6e1a2d3c4b5a6978695a4b
commit: cccccccccccccccccccccccccccccccccccccccc
new_patch_sets: true
head: cccccccccccccccccccccccccccccccccccccccc
rewritten_from: null
count: 3
published[3]{commit,change_id,stamped,subject,change,patch_set,current}:
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,Iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,false,Split the queue reader out of the daemon,200101,4,true
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,Ibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,false,Give the queue reader its own retry ceiling,200102,2,true
  cccccccccccccccccccccccccccccccccccccccc,Icccccccccccccccccccccccccccccccccccccccc,false,Wire the retry ceiling to the managed configuration,200103,1,true
```

After `published` comes the same `changes` table `show` emits, read back from the
server after the push, then `help`: the `show` that follows the new changes, the
`status --query 'topic:...'` that lists a stack as the server does, and after a
squash that made a patch set, the `message` that says what it changed. `current`
is whether the commit just pushed is now that change's current patch set, and
`stamped` whether this publish had to give it its Change-Id.

`submit <change>` asks the server to submit one change. Whether it may is the
server's decision alone, so nothing is checked first, and a refusal comes back in
the server's own words as an error record:

```console
$ gerrit-axi submit 200102; echo "exit=$?"
ok: false
op: submit
error: "Gerrit refused to submit change 200102: Failed to submit 1 change due to the following problems:\nChange 200102: submit requirement 'Zebu-Herding' is unsatisfied"
code: SUBMIT_REFUSED
kind: transport
help[1]: Run `gerrit-axi show 200102` for the labels blocking it (blocked_on)
exit=5
```

On success the record carries the change's `status` as the server reports it,
normally `MERGED`, and no hint: a merge is a confirmation. A refusal's `help` is
the `show` that names what blocks the change; nothing suggests submitting again,
and nothing here can cast the vote that would unblock it. It takes one change
per call because the server already decides what goes in with it — the changes
it depends on, or the rest of its topic where the server submits topics whole —
and submits those together or not at all.

## Posting a change message

`message <change>` posts one change-level message — the kind `show --messages`
reads back — on the change's current patch set. It records no label: Gerrit's
`review` command posts a plain message when it is given a message and no label
flag, and that is the only way this tool ever runs it. The text is read from
stdin, or from `--file <path>`, and never from argv, which every process on the
machine can read and which a pipeline's findings would overflow anyway. An empty
text is refused rather than posted blank.

This is the write a pipeline uses when a squash has published its fixes as one
patch set carrying the original commit message, so that what actually changed is
said somewhere on the change:

```console
$ gerrit-axi message 200101 --file findings.md
ok: true
op: message
change: 200101
patch_set: 4
revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
project: acme/apps/widget-console
branch: main
subject: Split the queue reader out of the daemon
url: "https://gerrit.example.com/c/acme/apps/widget-console/+/200101"
chars: 68
help[1]: Run `gerrit-axi show 200101 --messages all` for the conversation including this message
```

The change is looked up first, so the message is addressed to the patch set the
server has and the record names it. A change the server does not return is a
`NOT_FOUND` error record; a refusal by Gerrit — a closed change, a missing
permission — is `MESSAGE_REFUSED`, in the server's words. Inline, line-anchored
comments, replies to threads, and reviewers are not part of this command.

## Failures

A failure writes a typed record to **stdout**, in the same format as the data
and with `ok: false`, writes nothing to stderr, and exits non-zero. A consumer
reads one stream and parses one document; the exit code and `ok` say whether it
holds data or the reason there is none, and there is never a sentence of prose
to tell from either:

```console
$ gerrit-axi comments 200103; echo "exit=$?"
ok: false
op: comments
error: "no such resource: /a/changes/200103/comments (HTTP 404)"
code: NOT_FOUND
kind: transport
remedy: Check the change number; a change you cannot see also reads as 404.
exit=5
```

`code` is the raiser's machine-readable error code and `kind` is the class the
exit code was chosen from (`usage`, `config`, `auth`, `transport`, `gerrit`,
`internal`). `remedy` appears only when the raiser supplied one, and `help` only
when a command fixes or diagnoses the failure and the remedy does not already
spell it: the call repeated with `--host <host>` when no host resolves, the
`show` whose `missing` tells a gone change from a failed call after a 404, the
commands themselves after an unknown command. Both are hints for whoever reads
the log — not fields to branch on.

A usage error is refused before git, ssh or the server is asked anything. An
option the command does not take is named together with the options it does
take, so the corrected call needs no `--help` first; a misspelling close to a
valid option is pointed at that option. A command called without what it needs
gets its template as `help`, such as `gerrit-axi show <change>...`.

```console
$ gerrit-axi show 200101 --comment; echo "exit=$?"
ok: false
op: show
error: "unknown option for show: --comment"
code: BAD_USAGE
kind: usage
remedy: "Did you mean --comments? Options for show: --messages, --comments, --bots, --humans, --full. Global options: --json, --host, --user, --port, --project, --rest-base, --help, --version."
exit=2
```
