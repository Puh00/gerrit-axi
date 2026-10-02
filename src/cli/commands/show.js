// SPDX-License-Identifier: Apache-2.0

/**
 * `gerrit show <change>... [--messages <n|all>]`
 *
 * The answer to "where does this change stand", which in practice is three
 * questions asked together: what is the current patch set (and is my push on the
 * server), who voted and how long ago, and what did CI say and where do I read
 * it. Those live in three different corners of one `gerrit query` row, so they
 * are one command rather than three.
 *
 * `status` stays the list view and this is the detail view; nothing here is a
 * summary of many changes.
 *
 * Same tier-1 discipline as everywhere else: no label name and no bot name
 * appears in this file. Labels are whatever the server enumerated, submit
 * statuses are the server's verdict printed verbatim, and a cover message is
 * printed exactly as the server wrote it -- including whatever URL it carries,
 * because that URL is the point of the message.
 */

import { queryChangeDetails } from '../../core/changes.js';
import { UsageError } from '../args.js';
import {
  abbreviateRevision,
  colorSubmitStatus,
  formatAge,
  formatDate,
  formatDateTime,
  formatVote,
  table,
} from '../render.js';

/** Cover messages shown when `--messages` is not given. */
const DEFAULT_MESSAGE_COUNT = 10;

export const SHOW_USAGE = `usage: gerrit show <change>... [--messages <n|all>]

Everything one change's review state consists of:

  * the current patch set number and its revision, and the ref it was pushed to
  * dependencies, and whether this change is stacked on its parent's current
    patch set or on a superseded one
  * every vote, with who cast it and when
  * the cover messages -- vote summaries, CI results and the URLs they point at

  <change>...       one or more change numbers

  --messages <n>    how many cover messages to show, newest last
                    (default ${DEFAULT_MESSAGE_COUNT}; 'all' for every one, '0' for none)`;

/** Flags this command understands, for the argument parser. */
export const SHOW_FLAGS = {
  withValue: new Set(['--messages']),
  boolean: new Set(),
};

/**
 * @param {string|boolean|undefined} raw
 * @returns {number} Infinity for 'all'
 */
export function messageCountFromArg(raw) {
  if (raw === undefined) return DEFAULT_MESSAGE_COUNT;
  if (raw === 'all') return Infinity;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return Number(raw);
  throw new UsageError(`--messages takes a non-negative integer or 'all', got: ${raw}`);
}

/**
 * @param {{session: import('../../core/session.js').Session, args: import('../args.js').ParsedArgs,
 *          out: (line?: string) => void, err: (line?: string) => void,
 *          colorize: (code: string, text: string) => string, now?: Date}} ctx
 * @returns {Promise<number>}
 */
export async function runShow({ session, args, out, err, colorize, now = new Date() }) {
  const numbers = args.positional;
  if (numbers.length === 0) throw new UsageError(SHOW_USAGE);
  for (const number of numbers) {
    if (!/^[0-9]+$/.test(number)) {
      throw new UsageError(`not a change number: ${number}\n\n${SHOW_USAGE}`);
    }
  }
  const messageCount = messageCountFromArg(args.flags['--messages']);

  const changes = await queryChangeDetails(session, numbers);
  if (changes.length === 0) {
    out('no such change is visible to you');
    return 0;
  }

  // Asked-for order, so `gerrit show 3 2 1` reads back the way it was typed.
  const rank = new Map(numbers.map((n, i) => [n, i]));
  changes.sort((a, b) => (
    (rank.get(String(a.number)) ?? Infinity) - (rank.get(String(b.number)) ?? Infinity)
  ));

  changes.forEach((change, i) => {
    if (i > 0) out();
    renderChange(change, { out, colorize, now, messageCount });
  });

  const missing = numbers.filter((n) => !changes.some((c) => String(c.number) === n));
  if (missing.length) {
    err(colorize('dim', `not visible to you: ${missing.join(', ')}`));
  }
  return 0;
}

/**
 * @param {import('../../core/changes.js').Change} change
 * @param {{out: (line?: string) => void, colorize: (code: string, text: string) => string,
 *          now: Date, messageCount: number}} ctx
 */
function renderChange(change, { out, colorize, now, messageCount }) {
  out(`${colorize('bold', String(change.number))}  ${change.subject}`);

  /** @type {Array<[string, string]>} */
  const fields = [
    ['project', `${change.project}  (${change.branch})`],
  ];
  if (change.topic) fields.push(['topic', change.topic]);
  fields.push(
    ['owner', describeAccount(change.owner)],
    ['status', [
      change.status,
      ...(change.wip ? ['WIP'] : []),
      `submit ${colorSubmitStatus(change.readiness.status, colorize)}`,
    ].join('  ·  ')],
  );
  if (change.readiness.blocking.length) {
    fields.push(['blocked on', colorize('red', change.readiness.blocking.join(', '))]);
  }
  if (change.readiness.errorMessage) {
    fields.push(['rule error', colorize('red', change.readiness.errorMessage)]);
  }
  fields.push(['updated', withAge(change.lastUpdated, now, formatDate)]);

  const patchSet = change.currentPatchSet;
  if (patchSet) {
    // The whole revision, never abbreviated: this line exists to be compared
    // against a local `git rev-parse HEAD` after a push.
    fields.push(['patch set', [
      colorize('bold', String(patchSet.number ?? '?')),
      patchSet.revision ?? '(no revision reported)',
    ].join('  ')]);
    if (patchSet.ref) fields.push(['ref', patchSet.ref]);
    if (patchSet.uploader || patchSet.createdOn) {
      fields.push(['uploaded', [
        describeAccount(patchSet.uploader),
        withAge(patchSet.createdOn, now, formatDateTime),
      ].join('  ')]);
    }
  }

  for (const dependency of change.dependsOn) {
    fields.push(['depends on', describeDependency(dependency, colorize, 'parent')]);
  }
  for (const dependency of change.neededBy) {
    fields.push(['needed by', describeDependency(dependency, colorize, 'child')]);
  }
  if (change.url) fields.push(['url', change.url]);

  const width = Math.max(...fields.map(([name]) => name.length));
  for (const [name, value] of fields) {
    out(`  ${colorize('dim', name.padEnd(width))}  ${value}`);
  }

  renderVotes(change, { out, colorize, now });
  renderMessages(change, { out, colorize, now, messageCount });
}

/**
 * One row per vote actually cast, plus a row for any label the server named in a
 * submit record that nobody has voted on -- which is exactly the label that is
 * usually blocking.
 *
 * @param {import('../../core/changes.js').Change} change
 * @param {{out: (line?: string) => void, colorize: (code: string, text: string) => string,
 *          now: Date}} ctx
 */
function renderVotes(change, { out, colorize, now }) {
  /** @type {Array<{label: string, vote: string, who: string, when: string, status: string}>} */
  const rows = [];
  const names = new Set([
    ...change.votes.map((v) => v.name),
    ...change.readiness.labels.map((l) => l.name),
  ]);

  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const verdict = change.readiness.labels.find((l) => l.name === name);
    const status = verdict
      ? (verdict.blocking ? colorize('red', verdict.status) : colorSubmitStatus(verdict.status, colorize))
      : colorize('dim', '·');
    const cast = change.votes.find((v) => v.name === name)?.votes ?? [];
    if (cast.length === 0) {
      rows.push({ label: name, vote: colorize('dim', '·'), who: '-', when: '-', status });
      continue;
    }
    // The verdict belongs to the label, so it is stated once. Put it against the
    // vote the server credited it to when it names one -- printing REJECT beside
    // the oldest vote on the label would be a lie about who blocked it.
    const credited = cast.findIndex((vote) => sameAccount(vote.by, verdict?.by ?? null));
    const statusRow = credited === -1 ? 0 : credited;
    cast.forEach((vote, i) => {
      rows.push({
        label: i === 0 ? name : '',
        vote: colorize(vote.value < 0 ? 'red' : 'green', formatVote(vote.value)),
        who: describeAccount(vote.by),
        when: withAge(vote.grantedOn, now, formatDateTime),
        status: i === statusRow ? status : '',
      });
    });
  }

  out();
  if (rows.length === 0) {
    out(`  ${colorize('dim', 'votes')}  the server reported none`);
    return;
  }
  out(`  ${colorize('dim', 'votes')}`);
  const lines = table(rows, [
    { header: 'LABEL', value: (r) => r.label },
    { header: 'VOTE', value: (r) => r.vote, align: 'right' },
    { header: 'WHO', value: (r) => r.who },
    { header: 'WHEN', value: (r) => r.when },
    { header: 'SUBMIT', value: (r) => r.status },
  ], { colorize });
  for (const line of lines) out(`    ${line}`);
}

/**
 * The cover messages, oldest first, printed verbatim. This is where a failed
 * build says so and where it says which URL to read.
 *
 * @param {import('../../core/changes.js').Change} change
 * @param {{out: (line?: string) => void, colorize: (code: string, text: string) => string,
 *          now: Date, messageCount: number}} ctx
 */
function renderMessages(change, { out, colorize, now, messageCount }) {
  if (messageCount === 0) return;
  const all = change.messages;

  out();
  if (all.length === 0) {
    out(`  ${colorize('dim', 'messages')}  none`);
    return;
  }

  const shown = all.slice(Math.max(0, all.length - messageCount));
  const heading = shown.length === all.length
    ? `messages (${all.length}, oldest first)`
    : `messages (the last ${shown.length} of ${all.length}, oldest first; --messages all for every one)`;
  out(`  ${colorize('dim', heading)}`);

  for (const message of shown) {
    const bits = [colorize('bold', formatDateTime(message.timestamp))];
    bits.push(colorize('dim', `(${formatAge(message.timestamp, now)})`));
    if (message.patchSet !== null) bits.push(colorize('dim', `[ps${message.patchSet}]`));
    bits.push(colorize('cyan', `<${describeAccount(message.author)}>`));
    out(`    ${bits.join('  ')}`);
    // Indent the body, but never indent a blank line into trailing whitespace.
    for (const line of String(message.message).split('\n')) out(line ? `        ${line}` : '');
    out();
  }
}

/**
 * @param {import('../../core/changes.js').Dependency} dependency
 * @param {(code: string, text: string) => string} colorize
 * @param {'parent'|'child'} role
 * @returns {string}
 */
function describeDependency(dependency, colorize, role) {
  // Abbreviated, unlike the current patch set's: this revision is here to be
  // recognised, not to be compared against a local commit.
  const bits = [String(dependency.number ?? '?'), abbreviateRevision(dependency.revision)];
  if (dependency.isCurrentPatchSet === true) {
    bits.push(colorize('green', 'that change\'s current patch set'));
  } else if (dependency.isCurrentPatchSet === false) {
    // Worth saying out loud in both directions: a superseded parent means this
    // change wants a rebase, and a superseded child is history, not a dependent.
    bits.push(colorize('yellow', role === 'parent'
      ? 'superseded -- that change has a newer patch set'
      : 'superseded -- an older patch set of that change'));
  }
  return bits.join('  ');
}

/**
 * Same person? The submit record and the approval may name an account by
 * different fields, so any one of them matching is enough, and an account with
 * nothing to compare never matches.
 *
 * @param {import('../../core/changes.js').Account|null} a
 * @param {import('../../core/changes.js').Account|null} b
 * @returns {boolean}
 */
function sameAccount(a, b) {
  if (!a || !b) return false;
  return ['username', 'email', 'name'].some((field) => (
    typeof a[field] === 'string' && a[field] === b[field]
  ));
}

/**
 * @param {import('../../core/changes.js').Account|null} account
 * @returns {string}
 */
function describeAccount(account) {
  return account?.username ?? account?.name ?? account?.email ?? '?';
}

/**
 * @param {Date|null} date
 * @param {Date} now
 * @param {(date: Date|null) => string} format
 * @returns {string}
 */
function withAge(date, now, format) {
  if (!date) return '-';
  return `${format(date)}  (${formatAge(date, now)})`;
}
