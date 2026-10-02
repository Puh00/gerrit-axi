// SPDX-License-Identifier: Apache-2.0

/**
 * The wire records this tier emits.
 *
 * Everything here is a projection of the typed models `src/core/` already
 * returns: pick fields, name them, turn Dates into ISO-8601 strings. No
 * readiness is recomputed, no label is recognised by name, and no server row is
 * re-parsed -- if a value is not already on a core model, it does not belong
 * here.
 *
 * The shape is deliberately a set of flat, uniform tables rather than one deeply
 * nested object per change, because that is what survives a server growing a
 * label. Per-change scalars live in `changes`; anything per-label lives in
 * `labels` and `votes`, keyed by `(change, label)`. A consumer looks a value up
 * by change number and label name; nothing is ever found by position.
 */

/**
 * How much of a cover message or inline comment a row carries by default. A
 * body longer than this is cut to its first that-many characters, and the row
 * says so: `chars` is the whole body's length and `truncated` is true. The cut
 * is by code point, so a character outside the basic plane is kept or dropped
 * whole. `--full` lifts the cut.
 */
export const BODY_PREVIEW_CHARS = 1000;

/**
 * The body fields of a message or comment row: the text, or its preview, with
 * its total size and whether it was cut. No marker is mixed into the text --
 * the field stays the body's own characters, so a consumer can compare it --
 * and the two flags are on every row, so the table's columns never move.
 *
 * @param {string|null|undefined} text
 * @param {boolean} full
 * @returns {{message: string, chars: number, truncated: boolean}}
 */
export function bodyFields(text, full) {
  const whole = String(text ?? '');
  let chars = 0;
  let offset = 0;
  let cutAt = -1;
  for (const ch of whole) {
    chars += 1;
    offset += ch.length;
    if (chars === BODY_PREVIEW_CHARS) cutAt = offset;
  }
  const truncated = !full && cutAt !== -1 && cutAt < whole.length;
  return { message: truncated ? whole.slice(0, cutAt) : whole, chars, truncated };
}

/**
 * @param {Date|null|undefined} date
 * @returns {string|null}
 */
function iso(date) {
  return date instanceof Date ? date.toISOString() : null;
}

/**
 * How an account is named on the wire: its username when it has one, since that
 * is the stable handle, falling back to the display name.
 *
 * @param {{name: string|null, username: string|null, email: string|null}|null|undefined} account
 * @returns {string|null}
 */
function who(account) {
  if (!account) return null;
  return account.username ?? account.name ?? account.email ?? null;
}

/**
 * One row per change: the scalars a watch compares between runs.
 *
 * `blocked_on` is the server's own blocking-label list, joined -- an empty string
 * means nothing is blocking. The authoritative per-label form is the `labels`
 * table; this field is here so a watch can diff one string.
 *
 * @param {import('../core/changes.js').Change} change
 * @returns {Record<string, string|number|boolean|null>}
 */
export function changeRow(change) {
  return {
    change: change.number,
    subject: change.subject,
    project: change.project,
    branch: change.branch,
    topic: change.topic,
    owner: who(change.owner),
    status: change.status,
    wip: change.wip,
    submit: change.readiness.status,
    submittable: change.readiness.submittable,
    blocked_on: change.readiness.blocking.join(','),
    patch_set: change.currentPatchSet?.number ?? null,
    revision: change.currentPatchSet?.revision ?? null,
    ref: change.currentPatchSet?.ref ?? null,
    updated: iso(change.lastUpdated),
    created: iso(change.createdOn),
    url: change.url,
  };
}

/** Every column of `changeRow`, in its order. */
export const CHANGE_FIELDS = /** @type {const} */ ([
  'change', 'subject', 'project', 'branch', 'topic', 'owner', 'status', 'wip', 'submit',
  'submittable', 'blocked_on', 'patch_set', 'revision', 'ref', 'updated', 'created', 'url',
]);

/**
 * The columns a `status` row carries unless `--fields` asks for more: enough to
 * pick a change -- which one, what it is, whether it is open, and the server's
 * verdict on submitting it. `show` is the detail view.
 */
export const STATUS_FIELDS = /** @type {const} */ (['change', 'subject', 'status', 'submit']);

/** The per-label tables `status --fields` adds by name; `all` adds both. */
export const STATUS_TABLES = /** @type {const} */ (['labels', 'votes']);

/**
 * A change row cut to the columns named, in `changeRow`'s own order whatever
 * order they were named in, so a table's header never depends on the caller's
 * spelling.
 *
 * @param {Record<string, string|number|boolean|null>} row
 * @param {ReadonlySet<string>} fields
 * @returns {Record<string, string|number|boolean|null>}
 */
export function pickFields(row, fields) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key)));
}

/**
 * One row per dashboard section, present whether or not anything matched: a
 * section with nothing in it is a fact about the caller's day, not a missing
 * table. `count` is how many changes the section holds (exact up to the fetch
 * limit), `shown` how many `entries` rows carry it, and `more` whether either
 * this tier or the server held some back. `query` is the Gerrit query that
 * reproduces the section on its own, ready for `status --query`.
 *
 * @param {{name: string, query: string, count: number, shown: number, more: boolean}} section
 * @returns {Record<string, string|number|boolean|null>}
 */
export function sectionRow(section) {
  return {
    section: section.name,
    count: section.count,
    shown: section.shown,
    more: section.more,
    query: section.query,
  };
}

/**
 * One dashboard row per (section, change). A change on two sections appears
 * under each, as it does on Gerrit's own dashboard, and the pair is the join
 * key. Three content fields only: the dashboard says what is there, and `show`
 * says where it stands. `submit` is the server's overall verdict, unchanged.
 *
 * @param {string} section
 * @param {import('../core/changes.js').Change} change
 * @returns {Record<string, string|number|boolean|null>}
 */
export function entryRow(section, change) {
  return {
    section,
    change: change.number,
    subject: change.subject,
    owner: who(change.owner),
    submit: change.readiness.status,
  };
}

/**
 * One row per label the server mentioned in its submit records, including labels
 * nobody has voted on. `by` is the account the server credited the verdict to,
 * which is not always the account whose vote you would guess.
 *
 * @param {import('../core/changes.js').Change} change
 * @returns {Array<Record<string, string|number|boolean|null>>}
 */
export function labelRows(change) {
  return change.readiness.labels.map((label) => ({
    change: change.number,
    label: label.name,
    status: label.status,
    blocking: label.blocking,
    by: who(label.by),
  }));
}

/**
 * One row per vote on the current patch set: which label, what value, who cast
 * it and when.
 *
 * @param {import('../core/changes.js').Change} change
 * @returns {Array<Record<string, string|number|boolean|null>>}
 */
export function voteRows(change) {
  return change.votes.flatMap((label) => label.votes.map((vote) => ({
    change: change.number,
    label: label.name,
    value: vote.value,
    by: who(vote.by),
    granted: iso(vote.grantedOn),
  })));
}

/**
 * The stack, in both directions. `current` is tri-state on purpose: false means
 * this change sits on a parent revision the server has since superseded, and
 * null means the server did not say.
 *
 * @param {import('../core/changes.js').Change} change
 * @param {'dependsOn'|'neededBy'} direction
 * @returns {Array<Record<string, string|number|boolean|null>>}
 */
export function dependencyRows(change, direction) {
  return change[direction].map((dep) => ({
    change: change.number,
    related: dep.number,
    revision: dep.revision,
    ref: dep.ref,
    current: dep.isCurrentPatchSet,
  }));
}

/**
 * Cover messages -- the change conversation SSH carries. Bodies are verbatim,
 * newlines and all, so the encoder quotes and escapes them; a long one is cut
 * to its preview unless `full` (see `bodyFields`).
 *
 * @param {import('../core/changes.js').Change} change
 * @param {number} keep  how many of the newest to emit; Infinity for all
 * @param {boolean} [full]
 * @returns {Array<Record<string, string|number|boolean|null>>}
 */
export function messageRows(change, keep, full = false) {
  const all = change.messages;
  const kept = Number.isFinite(keep) ? all.slice(Math.max(0, all.length - keep)) : all;
  return kept.map((message) => ({
    change: change.number,
    patch_set: message.patchSet,
    author: who(message.author),
    at: iso(message.timestamp),
    urls: message.urls.join(' '),
    ...bodyFields(message.message, full),
  }));
}

/**
 * Inline review comments, with the bot/human split typed rather than implied.
 * `bot` is Gerrit's own `autogenerated:` convention and `bot_kind` is the suffix
 * the bot declared, so a reviewer nobody has heard of is classified the first
 * time it posts. A long body is cut to its preview unless `full`.
 *
 * @param {number|string} change
 * @param {readonly import('../core/comments.js').Comment[]} comments
 * @param {boolean} [full]
 * @returns {Array<Record<string, string|number|boolean|null>>}
 */
export function commentRows(change, comments, full = false) {
  return comments.map((comment) => ({
    change: Number(change),
    file: comment.file,
    line: comment.line,
    patch_set: comment.patchSet,
    author: who(comment.author),
    bot: comment.autogenerated,
    bot_kind: comment.botKind,
    unresolved: comment.unresolved,
    severity: comment.severity ?? null,
    id: comment.id,
    in_reply_to: comment.inReplyTo,
    updated: iso(comment.updated),
    ...bodyFields(comment.message, full),
  }));
}

/**
 * One row per change a publish sent, oldest first: the commit pushed, the
 * Change-Id that makes it that change, whether this publish had to stamp the
 * Change-Id, and what the server holds for it now. `current` is whether the
 * commit pushed is the change's current patch set on the server; null means the
 * server returned no change to compare against.
 *
 * @param {import('../core/publish.js').Published} entry
 * @returns {Record<string, string|number|boolean|null>}
 */
export function publishedRow(entry) {
  return {
    commit: entry.commit,
    change_id: entry.changeId,
    stamped: entry.stamped,
    subject: entry.subject,
    change: entry.change?.number ?? null,
    patch_set: entry.change?.currentPatchSet?.number ?? null,
    current: entry.isCurrentPatchSet,
  };
}

/**
 * One row per open change a stack publish left behind in its topic: on the
 * server, in the topic, but with a Change-Id no longer on HEAD.
 *
 * @param {import('../core/changes.js').Change} change
 * @returns {Record<string, string|number|boolean|null>}
 */
export function leftBehindRow(change) {
  return {
    change: change.number,
    subject: change.subject,
    url: change.url,
    patch_set: change.currentPatchSet?.number ?? null,
  };
}

/**
 * One row per change a watch reports on: which change, what it is now, and where
 * to read it. `status` is null for a change the server stopped returning.
 *
 * @param {import('../core/watch.js').Observation} observation
 * @returns {Record<string, string|number|boolean|null>}
 */
export function watchedRow(observation) {
  return {
    change: observation.number,
    subject: observation.subject,
    status: observation.status,
    patch_set: observation.patchSet,
    url: observation.url,
  };
}

/**
 * One row per thing that changed, keyed on `change` and, for a vote, `label`.
 * `from` and `to` are the old and new vote value, patch set number, status, or
 * message or comment count; `by` is who did it, joined when several did, and
 * null when the server names nobody; `reason` is why a vote was reset, null on
 * every other row.
 *
 * @param {import('../core/watch.js').Delta} delta
 * @returns {Record<string, string|number|boolean|null>}
 */
export function deltaRow(delta) {
  return {
    change: delta.change,
    kind: delta.kind,
    label: delta.label,
    from: delta.from,
    to: delta.to,
    by: delta.by.length > 0 ? delta.by.join(',') : null,
    reason: delta.reason,
  };
}
