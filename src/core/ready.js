// SPDX-License-Identifier: Apache-2.0

/** Guard and verify WIP transitions through fixed SSH or REST writes. */
import { queryChanges } from './changes.js';
import { GerritError, TransportError } from './errors.js';
import { restGetJson, restReady, restWip } from './rest.js';
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
 * @param {{patchSet?: number, revision?: string, rest?: boolean}} [expected]
 */
export async function readyChange(session, number, expected = {}) {
  const result = await changeWipState(session, number, expected, false);
  return { change: result.change, alreadyReady: result.already };
}

/** Mark an existing open change WIP using REST, without uploading a patch set.
 * @param {import('./session.js').Session} session
 * @param {number} number
 * @param {{patchSet?: number, revision?: string}} [expected]
 */
export async function wipChange(session, number, expected = {}) {
  const result = await changeWipState(session, number, { ...expected, rest: true }, true);
  return { change: result.change, alreadyWip: result.already };
}

/**
 * @param {import('./session.js').Session} session
 * @param {number} number
 * @param {{patchSet?: number, revision?: string, rest?: boolean}} expected
 * @param {boolean} wip
 */
async function changeWipState(session, number, expected, wip) {
  const op = wip ? 'wip' : 'ready';
  const code = wip ? 'WIP' : 'READY';
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new GerritError(`${op} needs a positive change number`, { code: 'BAD_RESPONSE' });
  }
  if ((expected.patchSet !== undefined && (!Number.isSafeInteger(expected.patchSet) || expected.patchSet <= 0))
    || (expected.revision !== undefined && (typeof expected.revision !== 'string'
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expected.revision)))) {
    throw new GerritError('invalid expected patch set or revision', { code: 'BAD_RESPONSE' });
  }
  const target = expected.rest ? await session.restTarget() : null;
  const read = async () => {
    const rows = target ? [await readRestState(target, number)]
      : await queryChanges(session, { kind: 'changes', numbers: [number] }, { limit: 1 });
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
    throw new TransportError(`change ${number} is not open: ${before.status}`, { code: `${code}_REFUSED` });
  }
  if (before.wip === wip) return { change: before, already: true };
  if (target) {
    try {
      await (wip ? restWip : restReady)(target, number);
    } catch (error) {
      if (error instanceof TransportError && error.code === 'HTTP_ERROR') {
        error.remedy = `Inspect the change before retrying; the ${op} write may already have taken effect.\n${error.remedy ?? ''}`.trim();
      }
      throw error;
    }
  } else {
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
        code: `${code}_REFUSED`,
      });
    }
  }
  const after = await read().catch((error) => {
    if (error instanceof GerritError) {
      error.remedy = `Inspect the change before retrying; the ${op} write may already have taken effect.\n${error.remedy ?? ''}`.trim();
    }
    throw error;
  });
  if (after.wip !== wip || after.status !== 'NEW' || after.currentPatchSet.number !== ps.number
    || after.currentPatchSet.revision !== ps.revision) {
    throw new TransportError(`readback did not confirm ${op} state on the same open patch set and revision`, {
      code: `${code}_NOT_CONFIRMED`,
      remedy: `Inspect the change before retrying; the ${op} write may already have taken effect.`,
    });
  }
  return { change: after, already: false };
}

/** Read just the state needed for guards and confirmation, entirely over REST.
 * Gerrit omits work_in_progress when false.
 * @param {import('./rest.js').RestTarget} target
 * @param {number} number
 */
async function readRestState(target, number) {
  const info = await restGetJson(target, `/a/changes/${number}?o=CURRENT_REVISION`);
  if (!info || info._number !== number || typeof info.status !== 'string'
    || (info.work_in_progress !== undefined && typeof info.work_in_progress !== 'boolean')) {
    throw new TransportError('the server returned invalid change state', { code: 'BAD_RESPONSE' });
  }
  return {
    number: info._number,
    status: info.status,
    wip: info.work_in_progress ?? false,
    currentPatchSet: {
      number: info.revisions?.[info.current_revision]?._number,
      revision: info.current_revision,
    },
  };
}
