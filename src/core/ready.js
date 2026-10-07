// SPDX-License-Identifier: Apache-2.0

/** Activate a change through a fixed review body. No caller-supplied JSON or options. */
import { queryChanges } from './changes.js';
import { GerritError, TransportError } from './errors.js';
import { buildSshDestination, runSsh, sshFailure } from './ssh.js';

/**
 * @param {{host: string, port: number, user: string}} conn
 * @param {number} change
 * @param {number} patchSet
 */
export function buildReadyArgs(conn, change, patchSet) {
  if (!Number.isSafeInteger(change) || change <= 0
    || !Number.isSafeInteger(patchSet) || patchSet <= 0) {
    throw new GerritError('ready needs positive change and patch set numbers', { code: 'BAD_RESPONSE' });
  }
  return [...buildSshDestination(conn), 'gerrit', 'review', '--json', `${change},${patchSet}`];
}

/**
 * Read before and after the write. Guards detect stale validation before writing;
 * the readback detects a concurrent patch set update, but is not an atomic lock.
 * @param {import('./session.js').Session} session
 * @param {number} number
 * @param {{patchSet?: number, revision?: string}} [expected]
 */
export async function readyChange(session, number, expected = {}) {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new GerritError('ready needs a positive change number', { code: 'BAD_RESPONSE' });
  }
  if ((expected.patchSet !== undefined && (!Number.isSafeInteger(expected.patchSet) || expected.patchSet <= 0))
    || (expected.revision !== undefined && (typeof expected.revision !== 'string'
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expected.revision)))) {
    throw new GerritError('invalid expected patch set or revision', { code: 'BAD_RESPONSE' });
  }
  const read = async () => {
    const rows = await queryChanges(session, { kind: 'changes', numbers: [number] }, { limit: 1 });
    const change = rows.find((row) => row.number === number);
    if (!change) throw new TransportError(`no such change: ${number}`, { code: 'NOT_FOUND' });
    const ps = change.currentPatchSet;
    if (!Number.isSafeInteger(ps?.number) || ps.number <= 0 || typeof ps.revision !== 'string'
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(ps.revision)) {
      throw new TransportError('the server returned no valid current patch set', { code: 'BAD_RESPONSE' });
    }
    return change;
  };
  const before = await read();
  const ps = before.currentPatchSet;
  if ((expected.patchSet !== undefined && expected.patchSet !== ps.number)
    || (expected.revision !== undefined && expected.revision !== ps.revision)) {
    throw new TransportError('the current patch set differs from the expected patch set or revision', {
      code: 'PATCH_SET_MISMATCH',
    });
  }
  if (before.status !== 'NEW') {
    throw new TransportError(`change ${number} is not open: ${before.status}`, { code: 'READY_REFUSED' });
  }
  if (!before.wip) return { change: before, alreadyReady: true };
  const conn = session.config;
  const result = await runSsh(buildReadyArgs(conn, number, ps.number), {
    runner: session.runner,
    input: JSON.stringify({ ready: true, notify: 'NONE' }),
  });
  if (result.code === null || result.code === 255) {
    const error = sshFailure(conn, result);
    error.remedy = `Inspect the change before retrying; the ready write may already have taken effect.\n${error.remedy}`;
    throw error;
  }
  if (result.code !== 0) {
    throw new TransportError(`Gerrit refused to activate change ${number}: ${String(result.stderr ?? '').trim() || `exit ${result.code}`}`, {
      code: 'READY_REFUSED',
    });
  }
  const after = await read();
  if (after.wip || after.status !== 'NEW' || after.currentPatchSet.number !== ps.number
    || after.currentPatchSet.revision !== ps.revision) {
    throw new TransportError('readback did not confirm an active change on the same patch set and revision', {
      code: 'READY_NOT_CONFIRMED',
      remedy: 'Inspect the change before retrying; the ready write may already have taken effect.',
    });
  }
  return { change: after, alreadyReady: false };
}
