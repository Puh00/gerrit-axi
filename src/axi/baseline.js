// SPDX-License-Identifier: Apache-2.0

/**
 * The `watch` baseline on the wire: one opaque token a record carries and
 * `--since` takes back, so a watch that is restarted starts where the last one
 * stopped instead of from whatever the server shows when it starts again.
 *
 * The token is `w1.` and the base64url of a JSON document naming the host and
 * holding core's Baseline for every change watched. It carries nothing that the
 * record it came in does not already show, and no credential. `--since` takes
 * the token itself, or a file holding it: the token alone, or a whole earlier
 * `watch` record in TOON or JSON, so a caller can redirect a watch's output to a
 * file and hand that file to the next one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { UsageError } from './output.js';

const PREFIX = 'w1.';

/**
 * @param {string} host
 * @param {readonly import('../core/watch.js').Baseline[]} baselines
 * @returns {string}
 */
export function encodeBaseline(host, baselines) {
  const doc = {
    h: host,
    c: baselines.map((b) => ({
      n: b.number,
      s: b.status,
      p: b.patchSet,
      u: b.updated,
      v: b.votes.map((v) => [v.label, v.by, v.value]),
      m: b.messages,
      k: b.comments,
    })),
  };
  return PREFIX + Buffer.from(JSON.stringify(doc), 'utf8').toString('base64url');
}

/**
 * @param {string} token
 * @param {string} host   the server this watch reaches; a baseline from another is refused
 * @returns {import('../core/watch.js').Baseline[]}
 */
export function decodeBaseline(token, host) {
  const bad = () => new UsageError('--since is not a watch baseline',
    'Pass the baseline a watch record carries, or a file holding it or the whole record.');
  if (!token.startsWith(PREFIX)) throw bad();
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(Buffer.from(token.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!doc || typeof doc.h !== 'string' || !Array.isArray(doc.c)) throw bad();
  if (doc.h !== host) {
    throw new UsageError(`--since is a baseline from ${doc.h}, not ${host}`,
      'Watch the server the baseline came from, or drop --since to start a new one.');
  }
  const str = (/** @type {unknown} */ v) => v === null || typeof v === 'string';
  const int = (/** @type {unknown} */ v) => Number.isSafeInteger(v);
  return doc.c.map((/** @type {any} */ c) => {
    const ok = c && int(c.n) && str(c.s) && (c.p === null || int(c.p)) && str(c.u)
      && int(c.m) && int(c.k) && Array.isArray(c.v)
      && c.v.every((/** @type {any} */ v) => Array.isArray(v) && typeof v[0] === 'string'
        && str(v[1]) && int(v[2]));
    if (!ok) throw bad();
    return {
      number: c.n,
      status: c.s,
      patchSet: c.p,
      updated: c.u,
      votes: c.v.map((/** @type {any[]} */ v) => ({ label: v[0], by: v[1], value: v[2] })),
      messages: c.m,
      comments: c.k,
    };
  });
}

/**
 * What `--since` names: a token, or a file holding one or a whole watch record.
 *
 * @param {string} value
 * @param {string} host
 * @param {string} cwd   a relative path is read from here
 * @returns {import('../core/watch.js').Baseline[]}
 */
export function readSince(value, host, cwd) {
  if (value.startsWith(PREFIX)) return decodeBaseline(value, host);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path.resolve(cwd, value), 'utf8');
  } catch {
    throw new UsageError(`--since is neither a watch baseline nor a readable file: ${value}`,
      'Pass the baseline a watch record carries, or a file holding it or the whole record.');
  }
  return decodeBaseline(tokenIn(text), host);
}

/**
 * The token in a file's text: the text itself, a JSON record's `baseline`, or a
 * TOON record's `baseline:` line.
 *
 * @param {string} text
 * @returns {string}
 */
function tokenIn(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith(PREFIX)) return trimmed;
  try {
    const doc = JSON.parse(trimmed);
    if (typeof doc?.baseline === 'string') return doc.baseline;
  } catch {
    // Not JSON; it may be TOON.
  }
  return /^baseline: (\S+)$/m.exec(trimmed)?.[1] ?? '';
}
