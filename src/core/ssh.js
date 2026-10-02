// SPDX-License-Identifier: Apache-2.0

/**
 * SSH transport for `gerrit query`.
 *
 * Change queries go over SSH because that channel returns the submit records --
 * the server's own readiness verdict -- in one round trip, and because it needs
 * no HTTP credential. Only inline comments require REST.
 *
 * We always ask for `--current-patch-set --all-approvals --submit-records`; those
 * three flags are what make the readiness oracle possible. Anything beyond them
 * is opt-in per call, because it costs the server work on every row: see
 * `DETAIL_QUERY_FLAGS`.
 *
 * Gerrit's SSH daemon parses the remote command itself; there is no shell on the
 * far side. But `host` and `port` are data read off a git remote, so a query is
 * not guaranteed to arrive at Gerrit -- point the tool at a real sshd and the
 * remote command *would* hit a shell. `assertSafeQuery` therefore rejects shell
 * metacharacters, none of which Gerrit's query language needs.
 */

import { TransportError } from './errors.js';
import { runCommand } from './exec.js';

/**
 * Characters a Gerrit query never needs, and a shell would act on. Quotes are
 * deliberately allowed: Gerrit's own tokenizer needs them for phrase operands
 * like `message:"..."`, and without command separators or expansion characters a
 * stray quote can only mangle an argument, not introduce a command.
 */
const SHELL_METACHARACTERS = /[;&|`$<>\\\n\r\0]/;

/**
 * @param {string} query
 * @returns {string} the query, unchanged, when it is safe
 */
export function assertSafeQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TransportError('empty Gerrit query', { code: 'UNSAFE_QUERY' });
  }
  const bad = SHELL_METACHARACTERS.exec(query);
  if (bad) {
    throw new TransportError(
      `query contains a character that is not valid in a Gerrit query: ${JSON.stringify(bad[0])}`,
      {
        code: 'UNSAFE_QUERY',
        remedy: 'Gerrit query syntax needs none of  ;  &  |  `  $  <  >  \\',
      },
    );
  }
  return query;
}

/**
 * ssh reads any argv element that begins with `-` as an option, and some of its
 * options run a local command before any connection is attempted. The user and
 * host are data -- a git remote's userinfo, the environment, a config file, the
 * local login name -- so neither may begin with one.
 *
 * `resolveConfig` calls this for every connection it resolves, which is the
 * guard; `buildSshArgs` calls it again for a library caller that hands over a
 * connection of its own. The rejected value is never echoed: it is someone
 * else's text on its way to a terminal.
 *
 * @template {{host: string, user: string}} C
 * @param {C} conn
 * @param {Record<string, string>} [sources]  which tier supplied each field
 * @returns {C} the connection, unchanged, when it is safe
 */
export function assertSafeConnection(conn, sources = {}) {
  for (const [field, noun] of /** @type {const} */ ([['user', 'username'], ['host', 'host']])) {
    if (String(conn[field]).startsWith('-')) {
      const from = sources[field] ? ` (source: ${sources[field]})` : '';
      throw new TransportError(
        `the Gerrit ${noun}${from} begins with "-", which ssh would read as an option rather than a destination`,
        {
          code: 'UNSAFE_CONNECTION',
          remedy: 'Correct the value where it came from, or pass --user / --host to override it.',
        },
      );
    }
  }
  return conn;
}

/**
 * Detail a caller may ask for on top of the three flags every query sends.
 *
 * `comments` adds the change's cover messages -- the "Patch Set 7: ...", "Build
 * Successful <url>", "Uploaded patch set 8" timeline. (Gerrit would also attach
 * per-patch-set inline comments to this flag, but only alongside `--patch-sets`,
 * which we never ask for: REST serves inline comments, and asking twice would be
 * paying for the same data on every row.)
 *
 * `dependencies` adds `dependsOn` / `neededBy`, each carrying the revision it
 * refers to; a `dependsOn` entry also says whether that revision is still that
 * change's current patch set (see `fillNeededByCurrency` for `neededBy`).
 *
 * This is an allowlist, not a passthrough: a caller names a key here, never a
 * flag string, so nothing a caller supplies can become an element of argv.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DETAIL_QUERY_FLAGS = Object.freeze({
  comments: '--comments',
  dependencies: '--dependencies',
});

/**
 * @param {readonly string[]} include  keys of DETAIL_QUERY_FLAGS
 * @returns {string[]} the flags, deduplicated, in the order they were named
 */
function detailFlags(include) {
  /** @type {string[]} */
  const flags = [];
  for (const name of include) {
    const flag = Object.prototype.hasOwnProperty.call(DETAIL_QUERY_FLAGS, name)
      ? DETAIL_QUERY_FLAGS[name]
      : undefined;
    if (!flag) {
      throw new TransportError(`unknown query detail: ${name}`, {
        code: 'UNSAFE_QUERY',
        remedy: `known details: ${Object.keys(DETAIL_QUERY_FLAGS).join(', ')}`,
      });
    }
    if (!flags.includes(flag)) flags.push(flag);
  }
  return flags;
}

/**
 * The client half of every ssh argv: port, batch mode, a connect timeout, then
 * the `--` marker and the destination. Past that marker ssh parses no option, so
 * the destination is never one, and every remote word that follows is Gerrit's
 * to read. Exported for the one other module that runs a Gerrit command over
 * ssh, `message.js`, which appends its own fixed remote words to this.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {{connectTimeoutSeconds?: number}} [opts]
 * @returns {string[]}
 */
export function buildSshDestination(conn, { connectTimeoutSeconds = 10 } = {}) {
  assertSafeConnection(conn);
  return [
    '-p', String(conn.port),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    // Past this marker ssh parses no option, so the destination is never one.
    '--',
    `${conn.user}@${conn.host}`,
  ];
}

/**
 * Build the argv for `ssh`. Exported so tests can assert on it without running
 * anything. No credential is ever an element of this array -- SSH authenticates
 * with the user's own agent/keys.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {string} query
 * @param {{limit?: number, connectTimeoutSeconds?: number, include?: readonly string[]}} [opts]
 * @returns {string[]}
 */
export function buildSshArgs(
  conn,
  query,
  { limit = 100, connectTimeoutSeconds = 10, include = [] } = {},
) {
  const destination = buildSshDestination(conn, { connectTimeoutSeconds });
  assertSafeQuery(query);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TransportError(`invalid limit: ${limit}`, { code: 'UNSAFE_QUERY' });
  }
  return [
    ...destination,
    'gerrit', 'query',
    '--format=JSON',
    '--current-patch-set',
    '--all-approvals',
    '--submit-records',
    ...detailFlags(include),
    query,
    `limit:${limit}`,
  ];
}

/**
 * Parse `gerrit query --format=JSON` output: one JSON object per line, with a
 * trailing `{"type":"stats"}` row. Rows of type `error` are the server telling us
 * the query was bad, which is worth surfacing rather than returning nothing.
 *
 * @param {string} stdout
 * @returns {{rows: any[], stats: any|null}}
 */
export function parseQueryOutput(stdout) {
  /** @type {any[]} */
  const rows = [];
  /** @type {any|null} */
  let stats = null;

  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new TransportError('gerrit query returned a line that is not JSON', {
        code: 'BAD_RESPONSE',
        cause: err,
      });
    }
    if (obj?.type === 'stats') {
      stats = obj;
      continue;
    }
    if (obj?.type === 'error') {
      throw new TransportError(`gerrit rejected the query: ${obj.message ?? 'unknown error'}`, {
        code: 'GERRIT_ERROR',
      });
    }
    rows.push(obj);
  }
  return { rows, stats };
}

/**
 * Spawn `ssh` with a built argv. A runner that cannot spawn ssh at all is the
 * one failure this turns into an error; an exit status is the caller's to read,
 * because what a non-zero status means depends on the remote command.
 *
 * @param {string[]} args
 * @param {{runner?: import('./exec.js').Runner, timeoutMs?: number}} [opts]
 * @returns {Promise<import('./exec.js').RunResult>}
 */
export async function runSsh(args, { runner = runCommand, timeoutMs = 60_000 } = {}) {
  try {
    return await runner('ssh', args, { timeoutMs });
  } catch (err) {
    throw new TransportError('could not run ssh', {
      code: 'SSH_FAILED',
      remedy: 'Is the OpenSSH client installed and on PATH?',
      cause: err,
    });
  }
}

/**
 * The error for an ssh command that exited non-zero, with the first line of
 * what it said and the one check that tells a key or host problem from a Gerrit
 * one.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {import('./exec.js').RunResult} result
 * @returns {TransportError}
 */
export function sshFailure(conn, result) {
  const reason = firstLine(result.stderr);
  return new TransportError(
    `ssh to Gerrit failed: ${reason ? JSON.stringify(reason) : `exit ${result.code}`}`,
    {
      code: 'SSH_FAILED',
      remedy: [
        'Check that your SSH key is registered with Gerrit and that the host is reachable:',
        `    ssh -p ${conn.port} -- <user>@<host> gerrit version`,
      ].join('\n'),
    },
  );
}

/**
 * Run `gerrit query` over SSH and return the raw change rows.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {string} query
 * @param {{limit?: number, runner?: import('./exec.js').Runner,
 *          include?: readonly string[], connectTimeoutSeconds?: number,
 *          timeoutMs?: number}} [opts]
 * @returns {Promise<{rows: any[], stats: any|null}>}
 */
export async function sshQuery(
  conn,
  query,
  { limit = 100, runner = runCommand, include = [], connectTimeoutSeconds, timeoutMs } = {},
) {
  const args = buildSshArgs(conn, query, { limit, include, connectTimeoutSeconds });
  const result = await runSsh(args, { runner, timeoutMs });
  if (result.code !== 0) throw sshFailure(conn, result);
  return parseQueryOutput(result.stdout);
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}
