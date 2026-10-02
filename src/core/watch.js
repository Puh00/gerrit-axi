// SPDX-License-Identifier: Apache-2.0

/**
 * Watching changes: wait until something happens on any of them, then say what.
 *
 * Three pieces, kept apart so that the source of observations can change without
 * changing what a caller is told:
 *
 *  - An Observation is what the server shows of one change now: its status,
 *    current patch set, votes, cover messages and inline comments.
 *  - A Baseline is the compact part of an observation that later ones are
 *    compared against. It is plain JSON, so a caller can keep it between runs and
 *    a restarted watch neither misses nor repeats a change.
 *  - `diffChange` turns a baseline and an observation into Deltas.
 *
 * This version polls, because `gerrit stream-events` is a capability an ordinary
 * account often does not have. A push-based source would build the same
 * Observations from events and hand them to the same `diffChange`.
 *
 * Every poll is one `gerrit query` for all the changes, with the cover messages
 * included. Inline comments need REST, one call per change, so they are read at
 * the baseline and afterwards only for a change whose `lastUpdated` has moved:
 * publishing a comment moves it, so an unmoved change has no new comment.
 *
 * Messages and comments are counted rather than identified, because the server
 * only ever appends them: the new ones are those past the baseline's count,
 * oldest first.
 *
 * Votes are the current patch set's, as `deriveVotes` reports them, keyed by
 * label and voter. A vote of 0 is no vote: Gerrit lists a reviewer it has added
 * with 0 on each label, and a vote taken back as 0. A vote gone in the same
 * poll as a new patch set is a vote reset, credited to no one: the voter did not
 * take it back, the label did not carry over to the new patch set.
 *
 * No label name appears here; labels are whatever the server called them.
 */

import { listComments } from './comments.js';
import { queryChanges } from './changes.js';
import { TransportError } from './errors.js';

/** The interval a watch polls at unless told otherwise. */
export const WATCH_DEFAULT_INTERVAL_SECONDS = 60;

/** No watch polls more often than this, whatever it is asked for. */
export const WATCH_MIN_INTERVAL_SECONDS = 15;

/**
 * Failed polls in a row that a watch rides out before it gives up. A long watch
 * outlives a dropped connection; a server that stays unreachable is an error.
 */
export const WATCH_MAX_FAILED_POLLS = 3;

/** Failures worth another poll: the server could not be reached, or erred. */
const TRANSIENT_CODES = new Set(['SSH_FAILED', 'HTTP_ERROR']);

/**
 * @typedef {Object} VoteState
 * @property {string} label
 * @property {string|null} by     the voter: username, else name, else email
 * @property {number} value       never 0
 */

/**
 * @typedef {Object} Entry       one cover message or inline comment
 * @property {string|null} author
 * @property {Date|null} at
 */

/**
 * @typedef {Object} Observation
 * @property {number} number
 * @property {string} subject
 * @property {string|null} url
 * @property {string|null} status       null when the server no longer returns the change
 * @property {number|null} patchSet
 * @property {string|null} uploader     of the current patch set
 * @property {string|null} updated      the change's lastUpdated, ISO-8601
 * @property {VoteState[]} votes
 * @property {Entry[]} messages          oldest first
 * @property {Entry[]|null} comments     oldest first; null when not read this time
 */

/**
 * @typedef {Object} Baseline
 * @property {number} number
 * @property {string|null} status
 * @property {number|null} patchSet
 * @property {string|null} updated
 * @property {VoteState[]} votes
 * @property {number} messages   how many cover messages there were
 * @property {number} comments   how many inline comments there were
 */

/**
 * What happened to one change. `from` and `to` are the old and new value: a
 * vote's value (null when there was none, or is none now), a patch set number,
 * a status, or a message or comment count. `by` is who did it, as far as the
 * server says: the voter, the uploader, the authors of the new messages or
 * comments, and for a status the author of the newest new cover message, which
 * is the account Gerrit records a merge or an abandon under; empty when nothing
 * names one, and for a vote reset. `reason` says why a vote was reset; null for
 * every other kind.
 *
 * @typedef {Object} Delta
 * @property {number} change
 * @property {'vote_added'|'vote_changed'|'vote_removed'|'vote_reset'|'patch_set'|'comments'|'messages'|'status'} kind
 * @property {string|null} label     the vote's label; null for every other kind
 * @property {string|number|null} from
 * @property {string|number|null} to
 * @property {string[]} by
 * @property {string|null} reason
 */

/**
 * How an account is keyed: the stable handle when it has one.
 *
 * @param {{name: string|null, username: string|null, email: string|null}|null|undefined} account
 * @returns {string|null}
 */
function accountKey(account) {
  if (!account) return null;
  return account.username ?? account.name ?? account.email ?? null;
}

/**
 * @param {Date|null|undefined} date
 * @returns {string|null}
 */
function iso(date) {
  return date instanceof Date ? date.toISOString() : null;
}

/**
 * @param {Entry[]} entries
 * @returns {Entry[]}
 */
function oldestFirst(entries) {
  return [...entries].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
}

/**
 * What the server shows of one change now.
 *
 * @param {import('./changes.js').Change} change   queried with the cover messages
 * @param {readonly import('./comments.js').Comment[]|null} comments  null when not read
 * @returns {Observation}
 */
export function observeChange(change, comments) {
  return {
    number: change.number,
    subject: change.subject,
    url: change.url,
    status: change.status,
    patchSet: change.currentPatchSet?.number ?? null,
    uploader: accountKey(change.currentPatchSet?.uploader),
    updated: iso(change.lastUpdated),
    votes: change.votes.flatMap((label) => label.votes
      .filter((vote) => vote.value !== 0)
      .map((vote) => ({ label: label.name, by: accountKey(vote.by), value: vote.value }))),
    messages: oldestFirst(change.messages.map((m) => ({ author: accountKey(m.author), at: m.timestamp }))),
    comments: comments === null
      ? null
      : oldestFirst(comments.map((c) => ({ author: accountKey(c.author), at: c.updated }))),
  };
}

/**
 * The observation of a change the server stopped returning: abandoned and
 * hidden, deleted, or no longer visible to this account.
 *
 * @param {Baseline} baseline
 * @returns {Observation}
 */
function goneChange(baseline) {
  return {
    number: baseline.number,
    subject: '',
    url: null,
    status: null,
    patchSet: baseline.patchSet,
    uploader: null,
    updated: baseline.updated,
    votes: baseline.votes,
    messages: [],
    comments: null,
  };
}

/**
 * The part of an observation later ones are compared against. When this
 * observation did not read the comments, the count is the previous baseline's.
 *
 * @param {Observation} observation
 * @param {Baseline} [previous]
 * @returns {Baseline}
 */
export function baselineOf(observation, previous) {
  if (observation.status === null && previous) return { ...previous, status: null };
  return {
    number: observation.number,
    status: observation.status,
    patchSet: observation.patchSet,
    updated: observation.updated,
    votes: observation.votes.map((v) => ({ ...v })),
    messages: observation.messages.length,
    comments: observation.comments?.length ?? previous?.comments ?? 0,
  };
}

/**
 * Distinct names, in the order they first appear.
 *
 * @param {Entry[]} entries
 * @returns {string[]}
 */
function authors(entries) {
  return [...new Set(entries.map((e) => e.author).filter((a) => a !== null))];
}

/**
 * Everything that differs between a baseline and an observation of the same
 * change: status first, then the patch set, the votes by label and voter, the
 * cover messages and the inline comments.
 *
 * @param {Baseline} before
 * @param {Observation} after
 * @returns {Delta[]}
 */
export function diffChange(before, after) {
  const change = after.number;
  /** @type {Delta[]} */
  const deltas = [];
  const newMessages = after.messages.slice(before.messages);

  if (before.status !== after.status) {
    const newest = newMessages.at(-1)?.author ?? null;
    deltas.push({ change, kind: 'status', label: null, from: before.status, to: after.status,
      by: newest === null ? [] : [newest], reason: null });
  }
  if (after.status === null) return deltas;

  if (before.patchSet !== after.patchSet) {
    deltas.push({ change, kind: 'patch_set', label: null, from: before.patchSet, to: after.patchSet,
      by: after.uploader === null ? [] : [after.uploader], reason: null });
  }

  const key = (/** @type {VoteState} */ v) => JSON.stringify([v.label, v.by]);
  const was = new Map(before.votes.map((v) => [key(v), v]));
  const now = new Map(after.votes.map((v) => [key(v), v]));
  for (const [k, vote] of now) {
    const old = was.get(k);
    if (old === undefined) {
      deltas.push({ change, kind: 'vote_added', label: vote.label, from: null, to: vote.value,
        by: vote.by === null ? [] : [vote.by], reason: null });
    } else if (old.value !== vote.value) {
      deltas.push({ change, kind: 'vote_changed', label: vote.label, from: old.value, to: vote.value,
        by: vote.by === null ? [] : [vote.by], reason: null });
    }
  }
  const reset = before.patchSet === after.patchSet ? null : `patch set ${before.patchSet} -> ${after.patchSet}`;
  for (const [k, vote] of was) {
    if (now.has(k)) continue;
    if (reset === null) {
      deltas.push({ change, kind: 'vote_removed', label: vote.label, from: vote.value, to: null,
        by: vote.by === null ? [] : [vote.by], reason: null });
    } else {
      deltas.push({ change, kind: 'vote_reset', label: vote.label, from: vote.value, to: null, by: [], reason: reset });
    }
  }

  if (newMessages.length > 0) {
    deltas.push({ change, kind: 'messages', label: null, from: before.messages, to: after.messages.length,
      by: authors(newMessages), reason: null });
  }
  if (after.comments !== null && after.comments.length > before.comments) {
    deltas.push({ change, kind: 'comments', label: null, from: before.comments, to: after.comments.length,
      by: authors(after.comments.slice(before.comments)), reason: null });
  }
  return deltas;
}

/**
 * Observe every change named, in one `gerrit query`, reading inline comments
 * only for a change that has no baseline yet or whose `lastUpdated` has moved
 * since it.
 *
 * @param {import('./session.js').Session} session
 * @param {readonly number[]} numbers
 * @param {ReadonlyMap<number, Baseline>} baselines
 * @returns {Promise<{observed: Map<number, Observation>, missing: number[]}>}
 */
export async function observeChanges(session, numbers, baselines) {
  const found = await queryChanges(session, { kind: 'changes', numbers: [...numbers] }, {
    limit: numbers.length,
    include: ['comments'],
  });
  const byNumber = new Map(found.map((change) => [change.number, change]));
  /** @type {Map<number, Observation>} */
  const observed = new Map();
  /** @type {number[]} */
  const missing = [];
  for (const number of numbers) {
    const change = byNumber.get(number);
    if (change === undefined) {
      missing.push(number);
      continue;
    }
    const before = baselines.get(number);
    const moved = before === undefined || before.updated !== iso(change.lastUpdated);
    const comments = moved ? await listComments(session, number) : null;
    observed.set(number, observeChange(change, comments));
  }
  return { observed, missing };
}

/**
 * @typedef {Object} WatchResult
 * @property {boolean} changed       false when the timeout came first
 * @property {Delta[]} deltas        empty when nothing changed
 * @property {Observation[]} changes the changes that changed, in the order named
 * @property {Baseline[]} baseline   where the next watch should start, every change named
 * @property {number} polls          times the server was asked, the first and any failed included
 */

/**
 * Wait until something changes on any of the changes named, and return what.
 *
 * Without `since` the first observation is the baseline, and the first
 * comparison is one interval later. With it, the first observation is compared
 * at once, so a change that landed while no watch was running is reported
 * rather than missed; a change `since` does not cover gets its baseline from
 * that first observation. A change the server does not return when it has no
 * baseline is an error, since there is nothing to watch; one that disappears
 * later is a status delta to null.
 *
 * Polls are `intervalMs` apart and never closer than the minimum. The timeout
 * ends the wait at its deadline; it never shortens the gap between two polls.
 *
 * @param {import('./session.js').Session} session
 * @param {readonly number[]} numbers
 * @param {{intervalMs?: number, timeoutMs?: number|null, since?: readonly Baseline[]|null,
 *          sleep?: (ms: number) => Promise<void>, now?: () => number}} [opts]
 * @returns {Promise<WatchResult>}
 */
export async function watchChanges(session, numbers, opts = {}) {
  const {
    intervalMs = WATCH_DEFAULT_INTERVAL_SECONDS * 1000,
    timeoutMs = null,
    since = null,
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now = Date.now,
  } = opts;
  if (numbers.length === 0) throw new TypeError('no change numbers given');
  const floorMs = WATCH_MIN_INTERVAL_SECONDS * 1000;
  if (!(intervalMs >= floorMs)) {
    throw new RangeError(`a watch polls at most every ${WATCH_MIN_INTERVAL_SECONDS} seconds`);
  }
  const deadline = timeoutMs === null ? Infinity : now() + timeoutMs;

  /** @type {Map<number, Baseline>} */
  const baselines = new Map();
  for (const entry of since ?? []) {
    if (numbers.includes(entry.number)) baselines.set(entry.number, entry);
  }

  const current = () => numbers.map((n) => /** @type {Baseline} */ (baselines.get(n)));
  let polls = 0;
  let failures = 0;
  for (;;) {
    if (polls > 0) {
      const remaining = deadline - now();
      const wait = Math.min(intervalMs, remaining);
      if (wait < floorMs) {
        if (remaining > 0) await sleep(remaining);
        return { changed: false, deltas: [], changes: [], baseline: current(), polls };
      }
      await sleep(wait);
    }

    /** @type {Awaited<ReturnType<typeof observeChanges>>} */
    let seen;
    try {
      seen = await observeChanges(session, numbers, baselines);
      failures = 0;
    } catch (err) {
      // The first observation must succeed: without it there is no baseline.
      const transient = err instanceof TransportError && TRANSIENT_CODES.has(err.code);
      failures += 1;
      if (polls === 0 || !transient || failures >= WATCH_MAX_FAILED_POLLS) throw err;
      continue;
    } finally {
      polls += 1;
    }

    const unknown = seen.missing.filter((n) => !baselines.has(n));
    if (unknown.length > 0) {
      throw new TransportError(`no such change: ${unknown.join(', ')}`, {
        code: 'NOT_FOUND',
        remedy: 'Check the change number; a change you cannot see is not returned either.',
      });
    }

    /** @type {Delta[]} */
    const deltas = [];
    /** @type {Observation[]} */
    const changes = [];
    for (const number of numbers) {
      const before = baselines.get(number);
      const after = seen.observed.get(number)
        ?? goneChange(/** @type {Baseline} */ (before));
      if (before !== undefined) {
        const found = diffChange(before, after);
        if (found.length > 0) {
          deltas.push(...found);
          changes.push(after);
        }
      }
      baselines.set(number, baselineOf(after, before));
    }
    if (deltas.length > 0) return { changed: true, deltas, changes, baseline: current(), polls };
  }
}
