# Architecture

One npm package, three internal modules, and a hard boundary around the first.

```text
src/core/   auth, transport, config resolution, typed models.  NO OUTPUT FORMATTING.
src/cli/    human-facing rendering and interactive prompts.    bin: gerrit
src/axi/    machine-facing records: TOON, or JSON.             bin: gerrit-axi
```

`src/cli/` and `src/axi/` are siblings. Neither imports the other, and neither
knows the other exists.

Two rules decide whether this design survives, and both are enforced by tests in
`test/layering.test.js`:

1. **`src/core/` returns data and never formats it.** No tables, no colour, no
   column widths, no `console.log`. Nothing under `src/core/` knows what a table
   looks like; it returns plain typed objects and `src/cli/` decides how they look.
2. **The second binary `import`s core; it does not spawn the CLI.** A wrapper is
   entitled to shell out to a CLI when that binary is foreign — compiled Go, say.
   Both of these layers are Node, so no subprocess boundary should ever exist
   between them. `src/core/index.js` is shaped as a library API over typed
   objects, not as something to be screen-scraped:

   ```js
   import {
     createSession, queryChanges, queryChangeDetails, listComments,
   } from 'gerrit-axi/core';

   const session = await createSession();                    // tier-2 resolution
   const changes = await queryChanges(session, { kind: 'attention' });
   const blocked = changes.filter((c) => c.readiness.blocking.length > 0);
   const bots = await listComments(session, 184458, { botsOnly: true });

   const [change] = await queryChangeDetails(session, [184458]);
   change.currentPatchSet.revision;                          // what the server has
   change.votes[0].votes[0].by;                              // who, and .grantedOn when
   change.messages.flatMap((m) => m.urls);                   // where CI posted its logs
   ```

`src/axi/` is that second binary, and [The agent tier](agent-tier.md) is what it
prints. It reaches Gerrit only through `src/core/`: `main.js` dispatches and turns
a thrown error into a record, `commands.js` calls core and assembles a document,
`records.js` projects core's typed models onto named fields, and `toon.js`
serialises. `setup.js` is the one module that writes an agent's configuration,
and only when `setup` is run. Its own tests read every table back by field name,
the way a consumer does.

That layout is why the human `gerrit` has no `--json`. A second output contract
inside the renderer would have to be kept in step with the tables beside it,
forever; a second binary over the same library has nothing to keep in step. So a
request for machine-readable output is a request for `gerrit-axi`, and
`test/layering.test.js` fails if `--json` appears under `src/cli/`.

Every edge of the process — the HTTP client, the subprocess runner, the
environment, the working directory — is a parameter rather than a global
reference. That is what lets the whole stack be driven from recorded fixtures.

## Transport

Three channels, each necessary:

- **SSH** — `ssh -p <port> -- <user>@<host> gerrit query --format=JSON
  --current-patch-set --all-approvals --submit-records ...` for change queries.
  Those three flags are what make the readiness oracle possible. Gerrit's SSH
  daemon parses the remote command itself, but host and port are data read off a
  git remote, so queries are screened for shell metacharacters before being sent
  in case they arrive somewhere with a real shell. For the same reason a user or
  host that begins with `-` is refused wherever it came from, since ssh would
  read it as an option rather than a destination.

  `gerrit show` adds `--comments` (the cover messages) and `--dependencies` (the
  stack, with its `isCurrentPatchSet` flag). Both are opt-in per call, and named
  through an allowlist rather than passed through, so that no caller-supplied
  string can become an element of the argv — and so a hundred-row list view never
  pays for a hundred message timelines.

  The same channel carries the one SSH write: `gerrit review --message <text>
  <change>,<patchset>`, built by `buildMessageArgs` in `src/core/message.js`,
  which has no parameter for any other option. The text travels as one
  single-quoted word — the `'\''` spelling that Gerrit's own tokeniser and a
  POSIX shell both read as literal — so nothing in it can become an option of
  `gerrit review` or a command on a host that turned out to have a shell.
- **REST** — `https://<host>/a/...` with Basic auth, for inline comments, which
  SSH cannot reach, and for the one write REST makes: `POST
  /a/changes/<n>/submit`. Every other request is a GET. Gerrit prefixes every REST
  JSON body with the XSSI guard line `)]}'`, which is stripped before parsing.
- **git over SSH** — `gerrit-axi publish` asks the same SSH endpoint for the
  branch tip with `git ls-remote`, then makes one `git push` of one refspec,
  `<commit>:refs/for/<branch>`, with an optional `%topic=`. The push is built in
  one function, `buildPushArgs` in `src/core/publish.js`, which has no parameter
  for any other push option. Branch and topic names are screened for the
  characters that would smuggle one in, and a configured `push.pushOption` is
  cleared, so the server receives only what was built.

HTTP 401, 403 and 404 are kept distinct: 401 means the credential is bad or
expired and is the only one that tells you to re-run `auth login`; 403 means you
authenticated but may not read that resource; 404 means no such change (or one you
cannot see).
