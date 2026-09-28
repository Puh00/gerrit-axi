# gerrit-axi

A Gerrit CLI. It answers the questions a reviewer actually asks — *whose turn is
it*, *what is blocking this change*, and *where does this one change stand* — and
prints the review comments, inline and cover, including the machine-generated
ones. For an agent, it also publishes changes, posts a change message, and
submits them.

Two binaries over one library: `gerrit` renders for a person, `gerrit-axi` emits
records for an agent. They are siblings, not wrappers — see
[The agent tier](docs/agent-tier.md).

**It cannot vote.** `gerrit`, for a person, is read-only: every operation is a
query. `gerrit-axi`, for an agent, adds exactly three writes — `publish`, one push
to `refs/for/<branch>`; `message`, one change-level message with no label; and
`submit`, one REST call the server may refuse — and nothing else: it never votes,
writes an inline comment, sets reviewers, or abandons. Submitting cannot get round
the votes, because Gerrit evaluates its submit rules on the server and refuses a
change they do not support. Voting is what would get round them: a tool that can
record an approval lets an agent manufacture one and then submit against it. So
no path to a vote exists, and `npm test` fails if a REST call to the review
endpoint or a label option on a push appears anywhere in the code, or if
`gerrit review` — the SSH command that posts a message, and that could vote — is
spelled anywhere but in the one module that builds it, or there with any option
but `--message`. Those three are the only writes to Gerrit by design. The
binding control is the label permissions your server grants the account an agent
uses; this is defence in depth behind them.

```console
$ gerrit status
projects under acme/
CHANGE  PROJECT              BRANCH       UPDATED     SUBMIT     BLOCKED-ON                    SUBJECT
184431  apps/widget-daemon   release/7.2  2026-07-31  OK         -                             Bump the retry ceiling to 5
184458  apps/widget-console  main         2026-07-30  NOT_READY  Zebra-Check                   Stop the widget from re-ent…
184402  tools/hammer         main         2026-07-21  NOT_READY  Release-Gate,Widget-Approval  WIP Rewrite the hammer in a…
```

Those label names are examples. The tool has no idea what your server calls its
labels, and that is the point — see [Configuration](docs/configuration.md).

## Install

Node 20 or newer. No runtime dependencies.

Each version tag has a
[GitHub Release](https://github.com/slnkjthien/gerrit-axi/releases) whose
tarball CI builds from the tagged commit. Download one by version and install the
file (npm 12 refuses a remote tarball URL by default, `allow-remote=none`):

```sh
curl -LO https://github.com/slnkjthien/gerrit-axi/releases/download/v<version>/gerrit-axi-<version>.tgz
npm install -g ./gerrit-axi-<version>.tgz
gerrit-axi --version    # prints: <version>
```

That installs both binaries: `gerrit` for a person, `gerrit-axi` for an agent.
To work on the tool itself, run `npm link` in a clone instead.

You also need:

- an **OpenSSH client**, and an SSH key registered with your Gerrit
  (`ssh -p 29418 <you>@<host> gerrit version` should work), and
- a **Gerrit authentication token** for the REST calls — see
  [Authentication](#authentication), and
- **git**, for `gerrit-axi publish`.

## Commands

```text
gerrit status                      your attention set — the changes where it is your turn
gerrit status mine                 your open changes
gerrit status <change>...          specific change numbers
gerrit status --query '<query>'    an arbitrary Gerrit query
    --labels                       one column per label the server reports
    --patch-set                    add the current patch set number and revision
    --limit <n>                    maximum changes to fetch (default 100)

gerrit show <change>...            one change's review state, in full
    --messages <n|all>             how many cover messages to show (default 10)

gerrit comments <change>           inline review comments
gerrit comments <change> --bots    only machine-generated comments
gerrit comments <change> --humans  only comments that are not machine-generated

gerrit auth login [--stdin]        verify a Gerrit auth token and store it
gerrit auth status                 report whether a stored credential still works
gerrit auth logout                 remove the stored credential
```

Every command's options are listed in `gerrit --help` as well as in
`gerrit <command> --help`, so nothing is discoverable only by knowing it exists.
Global options: `--host`, `--user`, `--port`, `--rest-base`, `--no-color`,
`-h/--help`, `-V/--version`.

Exit codes: `0` success, `1` other error, `2` usage, `3` configuration, `4`
authentication, `5` transport. `gerrit-axi` uses the same ones.

The `gerrit` command has no `--json`, and will not grow one. Machine-readable
output is what the second binary is for.

### Where does this change stand

`gerrit status` is the list view; `gerrit show` is the detail view for one
change. It exists as one command rather than three because the three facts it
prints are asked for together — *is my push on the server, who has voted and how
long ago, and what did CI say and where do I read it*:

```console
$ gerrit show 184458
184458  Stop the widget from re-entering the queue twice
  project     acme/apps/widget-console  (main)
  owner       ada
  status      NEW  ·  submit NOT_READY
  blocked on  Zebra-Check
  updated     2026-08-10  (1h ago)
  patch set   3  aaaa111122223333444455556666777788889999
  ref         refs/changes/58/184458/3
  uploaded    ada  2026-08-10 09:12  (3h ago)
  depends on  184400  dddd111122  superseded -- that change has a newer patch set
  url         https://gerrit.example.com/c/acme/apps/widget-console/+/184458

  votes
    LABEL            VOTE  WHO       WHEN                        SUBMIT
    Release-Gate       +1  buildbot  2026-08-10 09:20  (2h ago)  OK
    Widget-Approval    +1  grace     2026-08-10 10:04  (1h ago)  OK
    Zebra-Check         ·  -         -                           NEED

  messages (the last 2 of 9, oldest first; --messages all for every one)
    2026-08-10 09:20  (2h ago)  [ps3]  <buildbot>
        Patch Set 3: Release-Gate+1

        Build Successful

        https://ci.example.com/job/widget-console/412/ : SUCCESS

    2026-08-10 10:04  (1h ago)  [ps3]  <grace>
        Patch Set 3: Widget-Approval+1

        Reads fine to me now.
```

Three things worth knowing about that output:

- **The revision is printed whole, and the ref beside it.** That line is there to
  be compared against a local `git rev-parse HEAD` after a push. Dependency
  revisions are abbreviated, because those are for recognising rather than
  comparing.
- **`depends on` says whether the revision it names is still that change's
  current patch set.** A stack built on a superseded parent revision is the thing
  you want to find out about before re-reviewing it, not after.
- **Cover messages are printed exactly as the server wrote them**, URLs and all.
  A cover message is Gerrit's change-level conversation — vote summaries, CI
  results, "Uploaded patch set N" — and is a different thing from the inline
  comments `gerrit comments` prints, which belong to a file and a line and come
  over a different transport. `[psN]` is read out of the message's own first
  line, which is a convention of Gerrit's message text rather than a field, so a
  message that does not say gets no marker.

## Authentication

Gerrit answers `WWW-Authenticate: Basic realm="Gerrit Code Review"`. The credential
is **HTTP Basic carrying a Gerrit authentication token** — not an OAuth bearer
token.

Generate one at `https://<your-gerrit-host>/settings/#HTTPCredentials`, then:

```console
$ gerrit auth login
Generate a Gerrit authentication token at:
    https://gerrit.example.com/settings/#HTTPCredentials

Do NOT paste your LDAP/domain password.
Some servers accept one (git_basic_auth_policy = HTTP_LDAP), and that is precisely
why we refuse it: a Gerrit token is revocable and scoped to Gerrit, a domain
password is neither. Only a token will be stored.

Gerrit auth token for ada@gerrit.example.com (input hidden):
authenticated as Ada Lovelace <ada@example.com>
credential stored in the login keyring (encrypted at rest)
```

Non-interactively — for example from a script or an agent — pass the token on
stdin. `auth login` never blocks on a prompt nobody can answer; with no TTY and no
`--stdin` it fails immediately and tells you this:

```sh
read -rs T && printf %s "$T" | gerrit auth login --stdin && unset T
```

### What the tool does with your credential

- **A domain password is refused, on purpose.** Some servers accept one — where
  `git_basic_auth_policy` is `HTTP_LDAP`, Gerrit *will* authenticate a domain
  password — which is exactly why storing one is a bad trade: a Gerrit token is
  revocable and scoped, a domain password is neither.
- **The credential never appears in argv.** `ps` is world-readable. Every
  authenticated HTTP call passes the credential in a request header of an
  in-process HTTP client — nothing is ever shelled out with a credential on a
  command line — and the keyring and GPG helpers receive it on stdin.
- **It is verified before it is persisted.** `auth login` authenticates against
  `/a/accounts/self` first; an unverified token is never written to disk.
- **Storage is the best available, and degrades loudly rather than silently:**

  | order | backend | at rest |
  | --- | --- | --- |
  | 1 | `secret-tool` (libsecret keyring) | encrypted |
  | 2 | `gpg --encrypt --default-recipient-self` | encrypted |
  | 3 | file under `$XDG_CONFIG_HOME/gerrit-axi/credentials/`, mode `0600` | **plaintext** |

  Every `login` reports which backend it used. When it falls back to the file it
  says the word *plaintext* and names the upgrade path; `gerrit auth status`
  repeats both. Directories are `0700`, files are `0600`.
- **The token is never echoed, logged, or included in any output or error
  message**, and no token — real or otherwise — appears in this repo or in any
  test fixture.

## Further reading

- [The agent tier](docs/agent-tier.md) — `gerrit-axi`'s records, next steps, the
  dashboard, session integration, inline comments, publishing, submitting, posting
  a change message, and failures.
- [Configuration](docs/configuration.md) — the three tiers: what is derived from
  the server, what from the repo, and the little that is configured.
- [Architecture](docs/architecture.md) — the core library, the two binaries over
  it, and the transport.
- [Contributing](CONTRIBUTING.md) — running the tests, and what they cover.
- [Changelog](CHANGELOG.md) — what changed in each release.

## Licence

Apache-2.0. `LICENSE` has the full text; `NOTICE` carries the copyright, which is
Spectralink Corporation's.
