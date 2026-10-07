// SPDX-License-Identifier: Apache-2.0

/**
 * Posting one change-level message to one change.
 *
 * This module and ready.js are the only modules that spell the remote command
 * they use. That command can also vote, submit, abandon, restore
 * and rebase, which is why every module outside those two is forbidden to name it
 * (test/layering.test.js scans for it) and why this one builds its argv in a
 * single function with no parameter for a flag: `buildMessageArgs` takes a
 * connection, a change, a patch set and a text, and emits a fixed shape whose
 * only option is `--message`. Nothing a caller passes can become an option,
 * because the text travels as one quoted word. test/vote-ban.test.js drives the
 * whole path and pins what leaves the process.
 *
 * Why a message at all: a squash publishes a pipeline's fixes as one patch set
 * carrying the original commit message, so nothing on the change says what the
 * pipeline changed. A change message is where that account belongs, and Gerrit
 * records one with no label when no label flag is given.
 *
 * The message is never an element of this process's argv -- the agent tier reads
 * it from stdin or a file -- but it is a word of ssh's remote command line, which
 * Gerrit's sshd tokenises itself with shell-like quoting. `quoteForGerrit` wraps
 * it in single quotes with the `'\''` idiom, which both Gerrit's tokeniser and a
 * POSIX shell read as one literal word. So even if the host resolved off a git
 * remote turns out to be an ordinary sshd, the text cannot become a command.
 */

import { GerritError, TransportError } from './errors.js';
import { queryChanges } from './changes.js';
import { buildSshDestination, runSsh, sshFailure } from './ssh.js';

/** ssh's own exit status for a failure to connect or authenticate. */
const SSH_CLIENT_FAILURE = 255;

/**
 * @typedef {Object} PostedMessage
 * @property {number} change
 * @property {number} patchSet     the current patch set the message was posted on
 * @property {string|null} revision
 * @property {string|null} project
 * @property {string|null} branch
 * @property {string|null} subject
 * @property {string|null} url
 * @property {number} chars        length of the text as sent
 */

/**
 * Refuse a text that has nothing in it, or that no argv can carry.
 *
 * @param {unknown} text
 * @returns {string} the text with trailing whitespace removed
 */
export function assertPostableMessage(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new GerritError('the message is empty', { code: 'EMPTY_MESSAGE' });
  }
  if (text.includes('\0')) {
    throw new GerritError('the message contains a NUL byte', { code: 'UNSAFE_MESSAGE' });
  }
  return text.replace(/\s+$/, '');
}

/**
 * One word for Gerrit's command-line tokeniser: single-quoted, with each
 * embedded single quote spelled `'\''`. Inside single quotes that tokeniser
 * treats every character, backslash included, as literal, and a POSIX shell
 * reads the same spelling the same way.
 *
 * @param {string} text
 * @returns {string}
 */
export function quoteForGerrit(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv for ssh, pinned: the destination, then exactly the remote words
 * `gerrit review --message <text> <change>,<patchSet>`. There is no parameter
 * for any other option.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {number} change
 * @param {number} patchSet
 * @param {string} text
 * @returns {string[]}
 */
export function buildMessageArgs(conn, change, patchSet, text) {
  if (!Number.isInteger(change) || change <= 0) {
    throw new GerritError(`not a change number: ${change}`, { code: 'BAD_RESPONSE' });
  }
  if (!Number.isInteger(patchSet) || patchSet <= 0) {
    throw new GerritError(`not a patch set number: ${patchSet}`, { code: 'BAD_RESPONSE' });
  }
  const body = assertPostableMessage(text);
  return [
    ...buildSshDestination(conn),
    'gerrit', 'review',
    '--message', quoteForGerrit(body),
    `${change},${patchSet}`,
  ];
}

/**
 * Post one message on the current patch set of one change.
 *
 * Two round trips: a query for the change, so the message is addressed to the
 * patch set the server actually has and the record can name it, then the post.
 * A change the query does not return is NOT_FOUND. A refusal by Gerrit comes
 * back in its own words as MESSAGE_REFUSED; ssh's own failure to connect is
 * SSH_FAILED, as everywhere else.
 *
 * @param {import('./session.js').Session} session
 * @param {number|string} change
 * @param {string} text
 * @returns {Promise<PostedMessage>}
 */
export async function postChangeMessage(session, change, text) {
  const body = assertPostableMessage(text);
  const number = Number(change);
  // Matched on the number rather than taken by position: the record must name
  // the change that was asked about, whatever else the server's answer carries.
  const rows = await queryChanges(session, { kind: 'changes', numbers: [number] }, { limit: 1 });
  const found = rows.find((row) => row.number === number);
  if (!found) {
    throw new TransportError(`no such change: ${number}`, {
      code: 'NOT_FOUND',
      remedy: 'Check the change number; a change you cannot see also reads as missing.',
    });
  }
  const patchSet = found.currentPatchSet?.number;
  if (typeof patchSet !== 'number' || !Number.isInteger(patchSet)) {
    throw new TransportError(`change ${number} has no current patch set in the server's answer`, {
      code: 'BAD_RESPONSE',
    });
  }

  const { config, runner } = session;
  const conn = { host: config.host, port: config.port, user: config.user };
  const result = await runSsh(buildMessageArgs(conn, number, patchSet, body), { runner });
  if (result.code === SSH_CLIENT_FAILURE) throw sshFailure(conn, result);
  if (result.code !== 0) {
    const words = String(result.stderr ?? '').trim() || `exit ${result.code}`;
    throw new TransportError(`Gerrit refused the message on change ${number}: ${words}`, {
      code: 'MESSAGE_REFUSED',
    });
  }

  return {
    change: found.number,
    patchSet,
    revision: found.currentPatchSet?.revision ?? null,
    project: found.project ?? null,
    branch: found.branch ?? null,
    subject: found.subject ?? null,
    url: found.url ?? null,
    chars: body.length,
  };
}
