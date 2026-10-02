// SPDX-License-Identifier: Apache-2.0

/**
 * The tier's operations. Each one builds a document out of core models and hands
 * it back; main.js serialises it.
 *
 * Every read that names changes takes a list of them and answers about all of
 * them in one call. That is the requirement this tier was built for: a watch
 * following a nine-change stack must not need nine invocations, and `gerrit
 * query` answers about a whole list in one round trip anyway.
 *
 * `watch` is the one operation that waits: it polls the changes named until
 * something happens on one of them, then answers once.
 *
 * The three writes are `publish`, `submit` and `message`, and there is no fourth:
 * nothing here records a vote, writes an inline comment, or sets reviewers.
 *
 * A document carries `help[]` -- the next steps, as complete commands -- only
 * where the next step is not obvious: after a list, after a write, after a
 * watch, and whenever something was held back (a page the server cut, a message
 * list capped by `--messages`, a body cut to its preview). A detail view that answers the
 * question whole, or a confirmation, carries none. The lines are built by
 * hints.js and are never spelled here.
 */

import { readFile } from 'node:fs/promises';

import { authStatus } from '../core/auth.js';
import {
  buildQuery,
  queryChangePage,
  queryChanges,
  sortByLastUpdatedDesc,
} from '../core/changes.js';
import { listComments } from '../core/comments.js';
import { postChangeMessage } from '../core/message.js';
import { publishChanges } from '../core/publish.js';
import { submitChange } from '../core/submit.js';
import { WATCH_DEFAULT_INTERVAL_SECONDS, WATCH_MIN_INTERVAL_SECONDS, watchChanges } from '../core/watch.js';
import { encodeBaseline, readSince } from './baseline.js';
import { changeNumbers, messageCount, positiveInt, statusFields } from './args.js';
import { command, invocation, submittableHint, truncationHint } from './hints.js';
import { hookCommand, tildify } from './setup.js';
import {
  changeRow,
  commentRows,
  deltaRow,
  dependencyRows,
  entryRow,
  labelRows,
  messageRows,
  pickFields,
  publishedRow,
  sectionRow,
  voteRows,
  watchedRow,
} from './records.js';
import { UsageError } from './output.js';

/**
 * @typedef {Object} Ctx
 * @property {import('../core/session.js').Session} session  absent where `connect` is the way in
 * @property {import('./args.js').ParsedArgs} args
 * @property {NodeJS.ReadStream} [stdin]   where `message` reads its text
 * @property {() => Promise<import('../core/session.js').Session>} [connect]
 *           builds the session, for an operation that must not fail when none resolves
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [execPath]            this binary, as a hook would name it
 * @property {string} [cwd]                 where a relative `--since` file is read from
 * @property {(ms: number) => Promise<void>} [sleep]  what `watch` waits on
 * @property {() => number} [now]           the clock `watch` reads, epoch ms
 */

/** Rows the dashboard shows per section unless `--rows` says otherwise. */
const DASHBOARD_ROWS = 10;

/**
 * How many changes each dashboard query fetches. Also the ceiling on `--rows`:
 * past it a section's `count` would be the fetch limit rather than the truth.
 */
const DASHBOARD_FETCH_LIMIT = 100;

/**
 * How long the ambient view's queries may take in all, well inside the
 * session-start hook's timeout, so an unreachable server is still a help line.
 */
const AMBIENT_QUERY_BUDGET_MS = 5_000;

/**
 * `dashboard` -- the home view, and what a bare `gerrit-axi` prints: the
 * caller's open changes grouped the way Gerrit's own dashboard groups them.
 * Your turn, work in progress, outgoing, incoming, CCed on.
 *
 * Four round trips, one per question the server can answer in a single
 * `gerrit query`: a query row carries neither the attention set nor whether the
 * caller is a reviewer or a CC, so the sections cannot be split locally from one
 * OR'd query. The owner query is the exception -- `wip` is on the row -- so work
 * in progress and outgoing reviews come from the same call. The four run one at
 * a time, as `comments` does, rather than opening four sockets at once against
 * someone's review server.
 *
 * Every section row is always present. Nothing awaiting you is a fact worth a
 * row, not a table to omit. The tool's `bin` and `description` come first, as
 * they do on the ambient view, so a caller that ran it bare knows what answered.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opDashboard(ctx) {
  const { args } = ctx;
  const { positional, flags, overrides } = args;
  if (positional.length > 0) {
    throw new UsageError(`dashboard takes no arguments (got: ${positional.join(' ')})`);
  }
  if (flags['--ambient']) {
    if (flags['--rows'] !== undefined) throw new UsageError('--ambient shows counts, not rows; drop --rows');
    return ambientView(ctx);
  }
  const rows = positiveInt(flags['--rows'], DASHBOARD_ROWS, '--rows');
  if (rows < 1 || rows > DASHBOARD_FETCH_LIMIT) {
    throw new UsageError(`--rows must be between 1 and ${DASHBOARD_FETCH_LIMIT}, got: ${rows}`);
  }

  const session = /** @type {import('../core/session.js').Session} */ (ctx.session);
  const sections = await dashboardSections(session, rows);
  const distinct = distinctChanges(sections);

  return {
    ok: true,
    op: 'dashboard',
    ...identity(ctx),
    user: session.config.user,
    host: session.config.host,
    total: distinct,
    sections: sections.map(sectionRow),
    entries: sections.flatMap((s) => s.kept.map((change) => entryRow(s.name, change))),
    help: dashboardHelp(sections, distinct, overrides),
  };
}

/**
 * The dashboard's five sections, from its four queries.
 *
 * @param {import('../core/session.js').Session} session
 * @param {number} rows
 * @param {{deadline?: number}} [opts]  epoch ms by which every query must have finished
 * @returns {Promise<DashboardSection[]>}
 */
async function dashboardSections(session, rows, { deadline } = {}) {
  const fetch = (/** @type {import('../core/changes.js').QuerySpec} */ spec) => {
    if (deadline === undefined) return queryChangePage(session, spec, { limit: DASHBOARD_FETCH_LIMIT });
    const timeoutMs = Math.max(1, deadline - Date.now());
    return queryChangePage(session, spec, {
      limit: DASHBOARD_FETCH_LIMIT,
      timeoutMs,
      connectTimeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
    });
  };
  const attention = await fetch({ kind: 'attention' });
  const own = await fetch({ kind: 'mine' });
  const incoming = await fetch({ kind: 'incoming' });
  const cced = await fetch({ kind: 'cced' });

  const mine = buildQuery({ kind: 'mine' });
  return [
    dashboardSection('your_turn', buildQuery({ kind: 'attention' }), attention, rows),
    dashboardSection('wip', `${mine} is:wip`, {
      changes: own.changes.filter((change) => change.wip),
      more: own.more,
    }, rows),
    dashboardSection('outgoing', `${mine} NOT is:wip`, {
      changes: own.changes.filter((change) => !change.wip),
      more: own.more,
    }, rows),
    dashboardSection('incoming', buildQuery({ kind: 'incoming' }), incoming, rows),
    dashboardSection('cced', buildQuery({ kind: 'cced' }), cced, rows),
  ];
}

/**
 * @param {DashboardSection[]} sections
 * @returns {number} changes across all sections, each counted once
 */
function distinctChanges(sections) {
  return new Set(sections.flatMap((s) => s.changes.map((change) => change.number))).size;
}

/** One line on what gerrit-axi is, for the home view and the session a hook starts. */
export const DESCRIPTION = 'Gerrit code review for agents: what awaits you, change readiness and'
  + ' inline comments as records; publishes, posts change messages and submits, and cannot vote.'
  + ' Prefer it over raw `gerrit query` over ssh or Gerrit\'s REST API.';

/**
 * Who is answering, ahead of the live data on the home view and the ambient
 * view alike: this binary, as the hook would name it and with the home
 * directory shown as `~`, and one line on what it is.
 *
 * @param {Pick<Ctx, 'env'|'execPath'>} ctx
 * @returns {{bin: string, description: string}}
 */
function identity({ env = {}, execPath = '' }) {
  return { bin: tildify(hookCommand({ execPath, env }).bin, env), description: DESCRIPTION };
}

/**
 * `dashboard --ambient` -- what a session-start hook prints (`gerrit-axi setup
 * hooks` installs one). It loads on every session, so it is the dashboard's
 * counts without its rows, and the server is asked only from a checkout whose
 * origin is a Gerrit remote: anywhere else the session learns the tool exists
 * and how to start, and no query leaves the machine.
 *
 * It never fails, because a failing hook breaks the start of an unrelated
 * session: a server that cannot be reached, or a missing credential, is a line
 * of help[], and the exit code is 0.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
async function ambientView({ args, connect, env = {}, execPath = '' }) {
  const { overrides } = args;
  const run = (/** @type {Array<string|number>} */ words) => command(words, overrides);
  /** @type {Record<string, unknown>} */
  const doc = identity({ env, execPath });

  /** @type {import('../core/session.js').Session} */
  let session;
  try {
    session = await /** @type {NonNullable<Ctx['connect']>} */ (connect)();
  } catch (err) {
    doc.help = [/** @type {any} */ (err)?.code === 'HOST_UNRESOLVED'
      ? `Run \`${run([])}\` in a checkout whose origin is a Gerrit remote for your review dashboard`
      : `Could not resolve the Gerrit connection: ${firstLine(err)}; run \`${run([])}\` for the error and its remedy`];
    return doc;
  }
  const { host, user, sources } = session.config;
  if (sources.host !== 'git-remote') {
    doc.help = [`Run \`${run([])}\` for your review dashboard on ${host}`];
    return doc;
  }

  doc.host = host;
  doc.user = user;
  /** @type {string[]} */
  const help = [];
  try {
    const sections = await dashboardSections(session, DASHBOARD_ROWS, {
      deadline: Date.now() + AMBIENT_QUERY_BUDGET_MS,
    });
    doc.sections = sections.map((s) => ({ section: s.name, count: s.count }));
    const by = Object.fromEntries(sections.map((s) => [s.name, s]));
    if (distinctChanges(sections) === 0) help.push('No open change involves you.');
    else if (by.your_turn.count === 0) help.push('Nothing awaits your attention.');
    else {
      const numbers = by.your_turn.kept.map((change) => change.number);
      help.push(`Run \`${run(['show', ...numbers, '--comments'])}\` for the full state of what awaits you`);
    }
    for (const s of sections.filter((section) => section.serverMore)) {
      help.push(`Run \`${run(['status', '--query', s.query, '--limit', DASHBOARD_FETCH_LIMIT * 10])}\``
        + ` for more ${s.name} changes (${s.count}+ matched)`);
    }
    help.push(`Run \`${run([])}\` for the changes in each section`);
  } catch (err) {
    help.push(`Could not read your changes from ${host}: ${firstLine(err)};`
      + ` run \`${run([])}\` for the error and its remedy`);
  }
  if (!(await session.hasStoredToken().catch(() => true))) {
    help.push('Not signed in: run `gerrit auth login` so inline comments and submit can reach the server');
  }
  doc.help = help;
  return doc;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function firstLine(err) {
  return String(/** @type {any} */ (err)?.message ?? err).split('\n')[0];
}

/**
 * @typedef {Object} DashboardSection
 * @property {string} name
 * @property {string} query        reproduces the section on its own
 * @property {import('../core/changes.js').Change[]} changes  all matched, newest first
 * @property {import('../core/changes.js').Change[]} kept     the rows shown
 * @property {number} count
 * @property {number} shown
 * @property {boolean} more        this tier or the server held rows back
 * @property {boolean} serverMore  the server did, so `count` is a floor
 */

/**
 * @param {string} name
 * @param {string} query
 * @param {import('../core/changes.js').ChangePage} page
 * @param {number} rows
 * @returns {DashboardSection}
 */
function dashboardSection(name, query, page, rows) {
  const changes = sortByLastUpdatedDesc(page.changes);
  const kept = changes.slice(0, rows);
  return {
    name,
    query,
    changes,
    kept,
    count: changes.length,
    shown: kept.length,
    more: page.more || kept.length < changes.length,
    serverMore: page.more,
  };
}

/**
 * The next step, named: what to run for what awaits you, where the rest of a
 * truncated section is, and how to start when nothing of yours is open. One
 * line per point at most, and none when nothing applies. Every command carries
 * the invocation's connection overrides, so it reaches the same server.
 *
 * @param {DashboardSection[]} sections
 * @param {number} total
 * @param {import('./args.js').ParsedArgs['overrides']} overrides
 * @returns {string[]}
 */
function dashboardHelp(sections, total, overrides) {
  const by = Object.fromEntries(sections.map((s) => [s.name, s]));
  const run = (/** @type {Array<string|number>} */ words) => command(words, overrides);
  /** @type {string[]} */
  const help = [];
  if (total === 0) {
    help.push('No open change involves you.');
  } else if (by.your_turn.count === 0) {
    help.push('Nothing awaits your attention.');
  } else {
    const numbers = by.your_turn.kept.map((change) => change.number);
    help.push(`Run \`${run(['show', ...numbers, '--comments'])}\` for the full state of what awaits you`);
  }
  for (const s of sections) {
    if (!s.more) continue;
    if (s.serverMore) {
      help.push(`Run \`${run(['status', '--query', s.query, '--limit', DASHBOARD_FETCH_LIMIT * 10])}\``
        + ` for more ${s.name} changes (${s.count}+ matched, ${s.shown} shown)`);
    } else {
      help.push(`Run \`${run(['status', '--query', s.query])}\``
        + ` for every ${s.name} change (${s.count} matched, ${s.shown} shown)`);
    }
  }
  if (by.wip.count === 0 && by.outgoing.count === 0) {
    help.push(publishHint(overrides));
  }
  return help;
}

/**
 * @param {import('./args.js').ParsedArgs['overrides']} overrides
 * @returns {string}
 */
function publishHint(overrides) {
  return `Run \`${command(['publish', '--stack', '--topic', '<t>'], overrides)}\``
    + ` or \`${command(['publish', '--squash'], overrides)}\` to propose the commits on HEAD`;
}

/**
 * `status` -- the list view: the attention set, your own changes, named changes,
 * or a raw Gerrit query. Newest first, matching what the question "what changed"
 * wants. `more` is the server's word that `--limit` cut the page short.
 *
 * A row is the few columns that pick a change (`STATUS_FIELDS` in records.js);
 * `--fields` adds columns, the `labels` and `votes` tables, or `all` of them,
 * and `show` is the detail view. The hints read the whole row, so what they
 * name does not depend on what the caller asked to see.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opStatus({ session, args }) {
  const { positional, flags } = args;
  const raw = flags['--query'];
  /** @type {import('../core/changes.js').QuerySpec} */
  let spec;
  if (typeof raw === 'string') {
    if (positional.length > 0) {
      throw new UsageError('--query takes the whole query; drop the positional arguments',
        undefined, [`Run \`${command(['status', '--query', '<query>'], args.overrides)}\``]);
    }
    spec = { kind: 'raw', query: raw };
  } else if (positional.length === 0) {
    spec = { kind: 'attention' };
  } else if (positional.length === 1 && positional[0] === 'mine') {
    spec = { kind: 'mine' };
  } else {
    spec = { kind: 'changes', numbers: changeNumbers(positional) };
  }

  const limit = positiveInt(flags['--limit'], 100, '--limit');
  const { columns, tables } = statusFields(flags['--fields']);
  const page = await queryChangePage(session, spec, { limit });
  const changes = sortByLastUpdatedDesc(page.changes);
  const rows = changes.map(changeRow);

  return {
    ok: true,
    op: 'status',
    count: changes.length,
    more: page.more,
    changes: rows.map((row) => pickFields(row, columns)),
    ...(tables.has('labels') ? { labels: changes.flatMap(labelRows) } : {}),
    ...(tables.has('votes') ? { votes: changes.flatMap(voteRows) } : {}),
    ...withHelp(statusHelp(spec, args, rows, page.more, limit)),
  };
}

/**
 * After a list: the detail view of it, the write that applies to a change the
 * server marks ready, the rest of a page the server cut short; after an empty
 * list, where else to look. A raw query that matched nothing gets no line: the
 * query is the caller's own, and `count: 0` is its answer.
 *
 * @param {import('../core/changes.js').QuerySpec} spec
 * @param {import('./args.js').ParsedArgs} args
 * @param {Array<Record<string, string|number|boolean|null>>} rows
 * @param {boolean} more
 * @param {number} limit
 * @returns {string[]}
 */
function statusHelp(spec, args, rows, more, limit) {
  const { overrides } = args;
  const run = (/** @type {Array<string|number>} */ words) => command(words, overrides);
  /** @type {string[]} */
  const help = [];
  const named = spec.kind === 'changes' ? spec.numbers.map(String) : [];
  if (rows.length > 0) {
    help.push(spec.kind === 'changes'
      ? `Run \`${run(['show', ...named, '--comments'])}\` for the full review state`
      : `Run \`${run(['show', '<change>...', '--comments'])}\` for the full review state of a listed change`);
    const ready = submittableHint(rows, overrides);
    if (ready) help.push(ready);
  } else if (spec.kind === 'attention') {
    help.push(`Run \`${run(['status', 'mine'])}\` for your open changes`);
    help.push(`Run \`${run([])}\` for your whole dashboard`);
  } else if (spec.kind === 'mine') {
    help.push(publishHint(overrides));
  }
  if (spec.kind === 'changes' && rows.length < named.length) {
    help.push(`Run \`${run(['show', ...named])}\`; a number the server did not return is listed under missing`);
  }
  if (more) {
    help.push(`Run \`${invocation('status', args, { set: { '--limit': String(limit * 10) } })}\``
      + ` for more changes (${rows.length}+ matched, ${rows.length} shown)`);
  }
  return help;
}

/**
 * `help` is present only when there is a line to carry: an empty list would be
 * a key a consumer has to skip on every document.
 *
 * @param {string[]} help
 * @returns {{help?: string[]}}
 */
function withHelp(help) {
  return help.length > 0 ? { help } : {};
}

/**
 * `show` -- the full review state of every change named, in the order they were
 * named so a caller can zip the result against its own list. Change numbers the
 * server did not return come back under `missing` rather than as a failure: a
 * watch needs to tell "abandoned or no longer visible" apart from "the call
 * broke".
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opShow({ session, args }) {
  const numbers = changeNumbers(args.positional);
  if (numbers.length === 0) {
    throw new UsageError('show needs at least one change number', undefined,
      [`Run \`${command(['show', '<change>...', '[--messages <n|all>]', '[--comments]'], args.overrides)}\``]);
  }

  const keep = messageCount(args.flags['--messages']);
  const wantComments = args.flags['--comments'] === true;
  const full = args.flags['--full'] === true;
  if (full && keep === 0 && !wantComments) {
    throw new UsageError('--full needs --messages or --comments; it lifts the cut on their bodies');
  }
  // The cover messages cost the server work per row, so they are only asked for
  // when they will be emitted. The stack is always asked for: a stale parent
  // revision is the thing a stack watch exists to notice.
  const include = keep > 0 ? ['comments', 'dependencies'] : ['dependencies'];

  const found = await queryChanges(session, { kind: 'changes', numbers }, {
    limit: numbers.length,
    include,
  });
  const byNumber = new Map(found.map((change) => [change.number, change]));
  const changes = numbers
    .map((number) => byNumber.get(number))
    .filter((change) => change !== undefined);

  /** @type {Record<string, unknown>} */
  const document = {
    ok: true,
    op: 'show',
    count: changes.length,
    missing: numbers.filter((number) => !byNumber.has(number)),
    changes: changes.map(changeRow),
    labels: changes.flatMap(labelRows),
    votes: changes.flatMap(voteRows),
    depends_on: changes.flatMap((change) => dependencyRows(change, 'dependsOn')),
    needed_by: changes.flatMap((change) => dependencyRows(change, 'neededBy')),
  };
  /** @type {string[]} */
  const help = [];
  if (keep > 0) {
    const messages = changes.flatMap((change) => messageRows(change, keep, full));
    document.messages = messages;
    // A list capped by --messages is a truncated list, and is always revealed.
    const capped = changes.filter((change) => change.messages.length > keep);
    if (capped.length > 0) {
      const shown = capped.map((change) => `${keep} of ${change.messages.length} shown on ${change.number}`);
      help.push(`Run \`${invocation('show', args, { set: { '--messages': 'all' } })}\``
        + ` for every cover message (${shown.join('; ')})`);
    }
  }
  if (wantComments) {
    document.comments = await gatherComments(session, changes.map((c) => c.number), args.flags);
  }
  const bodies = [...(document.messages ?? []), ...(document.comments ?? [])];
  const cut = truncationHint('show', args, /** @type {any[]} */ (bodies));
  if (cut) help.push(cut);
  return { ...document, ...withHelp(help) };
}

/**
 * `comments` -- the inline comments on every change named. These are the ones a
 * reviewer actually writes against a line; the SSH cover messages do not carry
 * them, so this is the only path that reaches them.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opComments({ session, args }) {
  const numbers = changeNumbers(args.positional);
  if (numbers.length === 0) {
    throw new UsageError('comments needs at least one change number', undefined,
      [`Run \`${command(['comments', '<change>...', '[--bots | --humans]'], args.overrides)}\``]);
  }
  const rows = await gatherComments(session, numbers, args.flags);

  // After the list: the cover messages, which are the half of the review this
  // table cannot carry. After an empty filtered list: the filter itself.
  const filtered = args.flags['--bots'] === true || args.flags['--humans'] === true;
  const named = numbers.map(String);
  /** @type {string[]} */
  const help = [];
  if (rows.length === 0 && filtered) {
    help.push(`Run \`${command(['comments', ...named], args.overrides)}\` for the comments the filter excluded`);
  } else {
    help.push(`Run \`${command(['show', ...named, '--messages', 'all'], args.overrides)}\` for the cover messages`
      + (rows.length === 0
        ? '; a review written there carries no inline comment'
        : ' and where each change stands'));
  }
  const cut = truncationHint('comments', args, /** @type {any[]} */ (rows));
  if (cut) help.push(cut);
  return { ok: true, op: 'comments', count: rows.length, comments: rows, help };
}

/**
 * One REST call per change, sequentially: a watch over a stack should not open
 * nine sockets at once against someone's review server.
 *
 * @param {import('../core/session.js').Session} session
 * @param {readonly number[]} numbers
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function gatherComments(session, numbers, flags) {
  const botsOnly = flags['--bots'] === true;
  const humansOnly = flags['--humans'] === true;
  if (botsOnly && humansOnly) throw new UsageError('--bots and --humans exclude each other');
  const full = flags['--full'] === true;

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const number of numbers) {
    const comments = await listComments(session, number, { botsOnly, humansOnly });
    rows.push(...commentRows(number, comments, full));
  }
  return rows;
}

/**
 * `auth status` -- whether the stored credential still works. Without it a
 * consumer cannot tell an expired token from a change with no comments except by
 * reading an error string, which is exactly what this tier exists to avoid.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opAuth({ session, args }) {
  const [sub = 'status'] = args.positional;
  if (sub !== 'status') {
    throw new UsageError(`auth ${sub} is not part of this tier; use 'gerrit auth ${sub}'`);
  }
  const status = await authStatus(session);
  const help = status.stored && status.verified ? [] : [
    'Run `gerrit auth login` to store a token that works, then'
      + ` \`${command(['auth', 'status'], args.overrides)}\` to confirm`,
  ];
  return {
    ok: true,
    op: 'auth status',
    stored: status.stored,
    verified: status.verified,
    backend: status.backend,
    encrypted_at_rest: status.encryptedAtRest,
    best_backend: status.bestBackend,
    account: status.account?.username ?? status.account?.name ?? null,
    problem: status.problem?.code ?? null,
    host: session.config.host,
    user: session.config.user,
    ...withHelp(help),
  };
}

/**
 * `publish` -- the commits on HEAD, proposed to a branch as changes: one change
 * per commit under a topic with `--stack`, or one change for all of them with
 * `--squash`. The shape is the caller's to name, never guessed; a single commit
 * publishes identically either way, but a caller that meant one and got the
 * other would have created changes it has to abandon.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opPublish({ session, args }) {
  const { positional, flags, overrides } = args;
  const shapes = [publishHint(overrides)];
  if (positional.length > 0) {
    throw new UsageError(`publish takes no arguments; it publishes HEAD (got: ${positional.join(' ')})`,
      undefined, shapes);
  }
  const stack = flags['--stack'] === true;
  const squash = flags['--squash'] === true;
  if (stack === squash) throw new UsageError('publish needs exactly one of --stack or --squash', undefined, shapes);
  const topic = typeof flags['--topic'] === 'string' ? flags['--topic'] : null;
  // A stack is addressed as a unit through its topic; without one it is only a
  // chain of changes that happen to depend on each other.
  if (stack && topic === null) throw new UsageError('publish --stack needs --topic <name>', undefined, shapes);
  if (squash && topic !== null) {
    throw new UsageError('publish --squash takes no --topic; a topic names a stack', undefined, shapes);
  }
  const branch = typeof flags['--branch'] === 'string' ? flags['--branch'] : null;

  const publication = await publishChanges(session, {
    shape: stack ? 'stack' : 'squash',
    branch,
    topic,
  });
  const changes = publication.published
    .map((entry) => entry.change)
    .filter((change) => change !== null);
  const rows = changes.map(changeRow);
  return {
    ok: true,
    op: 'publish',
    shape: publication.shape,
    branch: publication.branch,
    topic: publication.topic,
    base: publication.base,
    commit: publication.commit,
    new_patch_sets: publication.newPatchSets,
    head: publication.head,
    rewritten_from: publication.rewrittenFrom,
    count: publication.published.length,
    published: publication.published.map(publishedRow),
    changes: rows,
    help: publishHelp(publication, rows, overrides),
  };
}

/**
 * After a publish: the changes to follow; the stack as the server lists it; on
 * a squash that made a patch set, the message that says what it changed, since
 * the squash carries the oldest commit's message; and `submit` only for a
 * change the server already marks submittable, which a fresh push rarely is.
 *
 * @param {import('../core/publish.js').Publication} publication
 * @param {Array<Record<string, string|number|boolean|null>>} rows
 * @param {import('./args.js').ParsedArgs['overrides']} overrides
 * @returns {string[]}
 */
function publishHelp(publication, rows, overrides) {
  const run = (/** @type {Array<string|number>} */ words) => command(words, overrides);
  const numbers = publication.published.map((entry) => entry.change?.number ?? '<change>');
  const help = [`Run \`${run(['show', ...numbers, '--comments'])}\` to follow the review`];
  if (publication.shape === 'stack' && publication.topic !== null) {
    help.push(`Run \`${run(['status', '--query', `topic:${publication.topic}`])}\` for the stack as the server lists it`);
  }
  if (publication.shape === 'squash' && publication.newPatchSets) {
    help.push(`Run \`${run(['message', numbers[0], '--file', '<path>'])}\` to say what this patch set changed,`
      + " since the squash carries the oldest commit's message");
  }
  const ready = submittableHint(rows, overrides);
  if (ready) help.push(ready);
  return help;
}

/**
 * `submit` -- ask the server to submit one change. One, because the server
 * already decides what must go in with it -- the changes it depends on, or the
 * rest of its topic -- and submits those together or not at all; a list here
 * would only invent an order between separate transactions.
 *
 * Nothing is checked first. A refusal is the server's, in its own words, and
 * arrives as an error record with code SUBMIT_REFUSED -- unless the change had
 * already merged, which is what the caller wanted: that is a success with
 * `already_merged: true`, exit 0, so a repeated submit is a no-op.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opSubmit({ session, args }) {
  const numbers = changeNumbers(args.positional);
  if (numbers.length !== 1) {
    throw new UsageError('submit takes exactly one change; the server submits what must go with it',
      undefined, [`Run \`${command(['submit', '<change>'], args.overrides)}\``]);
  }
  const submitted = await submitChange(session, numbers[0]);
  // A merge is a confirmation and carries no hint. Anything else the server
  // reported is worth reading back.
  const help = submitted.status === 'MERGED' ? [] : [
    `Run \`${command(['show', submitted.number], args.overrides)}\` to see whether it has merged`,
  ];
  return {
    ok: true,
    op: 'submit',
    change: submitted.number,
    status: submitted.status,
    already_merged: submitted.alreadyMerged,
    change_id: submitted.changeId,
    project: submitted.project,
    branch: submitted.branch,
    topic: submitted.topic,
    subject: submitted.subject,
    ...withHelp(help),
  };
}

/**
 * `message` -- post one change-level message on the current patch set of one
 * change. The text comes from stdin or `--file`, never from argv: it can be
 * long, and argv is readable by every process on the machine. An empty text is
 * refused rather than posted as a blank message.
 *
 * This is the write a pipeline uses to say what it changed when a squash left
 * the original commit message in place. It records no label; the record names
 * the patch set the message landed on.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opMessage({ session, args, stdin }) {
  const numbers = changeNumbers(args.positional);
  const shape = [`Run \`${command(['message', '<change>', '--file', '<path>'], args.overrides)}\`, or pipe the text on stdin`];
  if (numbers.length !== 1) throw new UsageError('message takes exactly one change number', undefined, shape);
  const file = typeof args.flags['--file'] === 'string' ? args.flags['--file'] : null;

  const text = file !== null ? await readMessageFile(file, shape) : await readMessageStdin(stdin, shape);
  if (text.trim() === '') {
    throw new UsageError(file !== null
      ? `the message file is empty: ${file}`
      : 'the message on stdin is empty; pipe the text in, or name a file with --file <path>', undefined, shape);
  }

  const posted = await postChangeMessage(session, numbers[0], text);
  return {
    ok: true,
    op: 'message',
    change: posted.change,
    patch_set: posted.patchSet,
    revision: posted.revision,
    project: posted.project,
    branch: posted.branch,
    subject: posted.subject,
    url: posted.url,
    chars: posted.chars,
    help: [
      `Run \`${command(['show', posted.change, '--messages', 'all'], args.overrides)}\``
        + ' for the conversation including this message',
    ],
  };
}

/**
 * `watch` -- wait until something happens on any of the changes named, then
 * print one record saying what and who: a vote added, changed or removed, a new
 * patch set, new cover messages or inline comments, a status such as MERGED or
 * ABANDONED. Nothing changed by `--timeout` is the same record with
 * `changed: false`, and exit 6 rather than 0, so a caller can tell the two apart
 * without parsing.
 *
 * Either record carries `baseline`, the state it ended at. `--since` takes it
 * back, so the next watch compares against exactly that: a change that landed
 * while no watch was running is reported at once, and none is reported twice.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opWatch({ session, args, cwd = process.cwd(), sleep, now }) {
  const { positional, flags, overrides } = args;
  const numbers = [...new Set(changeNumbers(positional))];
  if (numbers.length === 0) {
    throw new UsageError('watch needs at least one change number', undefined,
      [`Run \`${command(['watch', '<change>...', '[--timeout <secs>]'], overrides)}\``]);
  }
  const interval = positiveInt(flags['--interval'], WATCH_DEFAULT_INTERVAL_SECONDS, '--interval');
  if (interval < WATCH_MIN_INTERVAL_SECONDS) {
    throw new UsageError(`--interval must be at least ${WATCH_MIN_INTERVAL_SECONDS} seconds, got: ${interval}`);
  }
  const timeout = typeof flags['--timeout'] === 'string' ? positiveInt(flags['--timeout'], 0, '--timeout') : null;
  const { host } = session.config;
  const since = typeof flags['--since'] === 'string' ? readSince(flags['--since'], host, cwd) : null;

  const result = await watchChanges(session, numbers, {
    intervalMs: interval * 1000,
    timeoutMs: timeout === null ? null : timeout * 1000,
    since,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  });

  const again = `Run \`${invocation('watch', args, { set: { '--since': '<baseline>' } })}\``;
  const help = result.changed
    ? [
      `Run \`${command(['show', ...result.changes.map((c) => c.number), '--comments'], overrides)}\``
        + ' for the full state of what changed',
      `${again} to wait for the next change; <baseline> is this record's baseline, or a file holding this record`,
    ]
    : [`${again} to keep waiting from here; <baseline> is this record's baseline, or a file holding this record`];
  return {
    ok: true,
    op: 'watch',
    changed: result.changed,
    count: result.changes.length,
    polls: result.polls,
    baseline: encodeBaseline(host, result.baseline),
    changes: result.changes.map(watchedRow),
    deltas: result.deltas.map(deltaRow),
    help,
  };
}

/**
 * @param {string} file
 * @param {string[]} help  the corrected call
 * @returns {Promise<string>}
 */
async function readMessageFile(file, help) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const reason = /** @type {any} */ (err)?.code === 'ENOENT' ? 'no such file' : 'cannot read';
    throw new UsageError(`${reason}: ${file}`, undefined, help);
  }
}

/**
 * A terminal on stdin means nothing was piped, and waiting for someone to type
 * a message and press ^D is not what an agent binary should do.
 *
 * @param {NodeJS.ReadStream|undefined} stdin
 * @param {string[]} help  the corrected call
 * @returns {Promise<string>}
 */
async function readMessageStdin(stdin, help) {
  if (!stdin || stdin.isTTY) {
    throw new UsageError('message needs its text on stdin or in --file <path>', undefined, help);
  }
  let text = '';
  stdin.setEncoding?.('utf8');
  for await (const chunk of stdin) text += chunk;
  return text;
}
