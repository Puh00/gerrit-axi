// SPDX-License-Identifier: Apache-2.0

/**
 * `gerrit-axi watch`: poll until something changes, then one record of what and
 * who.
 *
 * Offline like everything else here. Each test hands the binary a sequence of
 * server states, one per `gerrit query`, and a sequence of inline-comment
 * bodies, one per REST call; the clock and the sleep are fakes, so a watch that
 * would wait an hour returns at once and the waits it asked for are recorded.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EXIT, main } from '../src/axi/main.js';
import { Session } from '../src/core/session.js';
import { captureStream, fakeRunner } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const URL_200101 = 'https://gerrit.example.com/c/acme/apps/widget-console/+/200101';

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com', username: 'ada' };
const GRACE = { name: 'Grace Hopper', email: 'grace@example.com', username: 'grace' };
const ALAN = { name: 'Alan Turing', email: 'alan@example.com', username: 'alan' };

/**
 * One `gerrit query` row for change 200101, as the server sends it with
 * `--current-patch-set --all-approvals --submit-records --comments`.
 *
 * @param {{number?: number, status?: string, patchSet?: number, updated?: number,
 *          uploader?: any, approvals?: any[], messages?: any[]}} [state]
 */
function row({
  number = 200101, status = 'NEW', patchSet = 4, updated = 1785536000, uploader = ADA,
  approvals = [], messages = [],
} = {}) {
  return {
    project: 'acme/apps/widget-console',
    branch: 'main',
    id: `I${String(number).repeat(5)}`,
    number,
    subject: 'Split the queue reader out of the daemon',
    owner: ADA,
    url: `https://gerrit.example.com/c/acme/apps/widget-console/+/${number}`,
    createdOn: 1784536000,
    lastUpdated: updated,
    status,
    comments: messages,
    currentPatchSet: {
      number: String(patchSet),
      revision: 'a'.repeat(40),
      ref: `refs/changes/01/${number}/${patchSet}`,
      uploader,
      createdOn: 1785532400,
      approvals,
    },
    submitRecords: [{ status: 'NOT_READY', labels: [{ label: 'Quokka-Review', status: 'NEED' }] }],
  };
}

/**
 * Run `gerrit-axi` against a server whose answer to the n-th `gerrit query` is
 * `polls[n]` (the last one repeating) and to the n-th inline-comment read is
 * `comments[n]`, with a fake clock that every sleep advances.
 *
 * @param {string[]} argv
 * @param {{polls: any[][], comments?: any[], ssh?: (call: number) => any, cwd?: string}} server
 */
async function watch(argv, { polls, comments = [{}], ssh, cwd = '/some/checkout' }) {
  let queries = 0;
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    {
      match: (f) => f === 'ssh',
      result: () => {
        const call = queries;
        queries += 1;
        const failure = ssh?.(call);
        if (failure) return failure;
        const rows = polls[Math.min(call, polls.length - 1)];
        const lines = rows.map((r) => JSON.stringify(r));
        lines.push(JSON.stringify({ type: 'stats', rowCount: rows.length, moreChanges: false }));
        return { stdout: `${lines.join('\n')}\n` };
      },
    },
  ]);
  /** @type {string[]} */
  const reads = [];
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url) => {
    const body = comments[Math.min(reads.length, comments.length - 1)];
    reads.push(String(url));
    return { status: 200, headers: new Map(), text: async () => `)]}'\n${JSON.stringify(body)}` };
  };
  let clock = 1_800_000_000_000;
  /** @type {number[]} */
  const sleeps = [];
  const stdout = captureStream();
  const stderr = captureStream();
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({ token: 'placeholder-not-a-real-token', backend: 'file', location: null });
  try {
    const code = await main(argv, {
      cwd,
      env: ENV,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runner,
      fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
    });
    return { code, out: stdout.text, err: stderr.text, queries, reads, sleeps, calls: runner.calls };
  } finally {
    Session.prototype.token = restored;
  }
}

test('a vote cast after the baseline is reported with its label, value and voter', async () => {
  const before = row();
  const after = row({
    updated: 1785537000,
    approvals: [{ type: 'Quokka-Review', value: '2', grantedOn: 1785537000, by: GRACE }],
  });

  const { code, out, err, sleeps } = await watch(['watch', '200101', '--json'], { polls: [[before], [after]] });

  assert.equal(code, EXIT.ok);
  assert.equal(err, '');
  const record = JSON.parse(out);
  assert.equal(record.ok, true);
  assert.equal(record.op, 'watch');
  assert.equal(record.changed, true);
  assert.equal(record.count, 1);
  assert.equal(record.polls, 2);
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(record.changes, [{
    change: 200101, subject: 'Split the queue reader out of the daemon', status: 'NEW', patch_set: 4, url: URL_200101,
  }]);
  assert.deepEqual(record.deltas, [
    { change: 200101, kind: 'vote_added', label: 'Quokka-Review', from: null, to: 2, by: 'grace' },
  ]);
  assert.match(record.baseline, /^w1\./);
});

test('a vote changed from one value to another names the old and the new', async () => {
  const before = row({ approvals: [{ type: 'Quokka-Review', value: '1', grantedOn: 1785535000, by: GRACE }] });
  const after = row({
    updated: 1785537000,
    approvals: [{ type: 'Quokka-Review', value: '-1', grantedOn: 1785537000, by: GRACE }],
  });

  const { code, out } = await watch(['watch', '200101', '--json'], { polls: [[before], [after]] });

  assert.equal(code, EXIT.ok);
  assert.deepEqual(JSON.parse(out).deltas, [
    { change: 200101, kind: 'vote_changed', label: 'Quokka-Review', from: 1, to: -1, by: 'grace' },
  ]);
});

test('a vote taken back to 0, or gone from the approvals, is a vote removed', async () => {
  const before = row({
    approvals: [
      { type: 'Quokka-Review', value: '2', grantedOn: 1785535000, by: GRACE },
      { type: 'Xylophone-Gate', value: '1', grantedOn: 1785535100, by: ALAN },
    ],
  });
  const after = row({
    updated: 1785537000,
    approvals: [{ type: 'Quokka-Review', value: '0', grantedOn: 1785537000, by: GRACE }],
  });

  const { code, out } = await watch(['watch', '200101', '--json'], { polls: [[before], [after]] });

  assert.equal(code, EXIT.ok);
  assert.deepEqual(JSON.parse(out).deltas, [
    { change: 200101, kind: 'vote_removed', label: 'Quokka-Review', from: 2, to: null, by: 'grace' },
    { change: 200101, kind: 'vote_removed', label: 'Xylophone-Gate', from: 1, to: null, by: 'alan' },
  ]);
});

test('a new patch set is reported with its uploader, and the cover message it brought', async () => {
  const before = row({ patchSet: 4 });
  const after = row({
    patchSet: 5,
    updated: 1785537000,
    uploader: ADA,
    messages: [{ timestamp: 1785537000, reviewer: ADA, message: 'Uploaded patch set 5.' }],
  });

  const { code, out } = await watch(['watch', '200101', '--json'], { polls: [[before], [after]] });

  assert.equal(code, EXIT.ok);
  const record = JSON.parse(out);
  assert.equal(record.changes[0].patch_set, 5);
  assert.deepEqual(record.deltas, [
    { change: 200101, kind: 'patch_set', label: null, from: 4, to: 5, by: 'ada' },
    { change: 200101, kind: 'messages', label: null, from: 0, to: 1, by: 'ada' },
  ]);
});

test('new inline comments are counted with their authors, read only once the change has moved', async () => {
  const before = row();
  const after = row({ updated: 1785537000 });
  const old = { patch_set: 4, id: 'c1', updated: '2026-08-01 10:00:00.000000000', message: 'Old.', author: GRACE };
  const comments = [
    { '/PATCHSET_LEVEL': [old] },
    {
      '/PATCHSET_LEVEL': [old],
      'src/Reader.java': [
        { patch_set: 4, id: 'c2', line: 3, updated: '2026-08-02 10:00:00.000000000', message: 'Why?', author: ALAN },
        { patch_set: 4, id: 'c3', line: 9, updated: '2026-08-02 10:00:00.000000000', message: 'And here.', author: ALAN },
        { patch_set: 4, id: 'c4', line: 9, updated: '2026-08-02 11:00:00.000000000', message: 'Agreed.', author: GRACE },
      ],
    },
  ];

  // The change sits still for two polls, then moves.
  const { code, out, reads, queries } = await watch(['watch', '200101', '--json'], {
    polls: [[before], [before], [before], [after]],
    comments,
  });

  assert.equal(code, EXIT.ok);
  assert.equal(queries, 4);
  // One read for the baseline and one for the poll that saw the change move:
  // an unmoved change has no new comment, so the polls between read none.
  assert.equal(reads.length, 2);
  assert.ok(reads.every((url) => url.endsWith('/a/changes/200101/comments')));
  assert.deepEqual(JSON.parse(out).deltas, [
    { change: 200101, kind: 'comments', label: null, from: 1, to: 4, by: 'alan,grace' },
  ]);
});

test('new cover messages are counted with their authors', async () => {
  const before = row({ messages: [{ timestamp: 1785535000, reviewer: ADA, message: 'Uploaded patch set 4.' }] });
  const after = row({
    updated: 1785537000,
    messages: [
      { timestamp: 1785535000, reviewer: ADA, message: 'Uploaded patch set 4.' },
      { timestamp: 1785536500, reviewer: { name: 'Build Bot', username: 'buildbot' }, message: 'Build Started' },
      { timestamp: 1785537000, reviewer: GRACE, message: 'Patch Set 4:\n\nLooks close.' },
    ],
  });

  const { code, out } = await watch(['watch', '200101', '--json'], { polls: [[before], [after]] });

  assert.equal(code, EXIT.ok);
  assert.deepEqual(JSON.parse(out).deltas, [
    { change: 200101, kind: 'messages', label: null, from: 1, to: 3, by: 'buildbot,grace' },
  ]);
});

test('a merge is a status change, credited to the author of the message that recorded it', async () => {
  const before = row();
  const after = row({
    status: 'MERGED',
    updated: 1785537000,
    messages: [{ timestamp: 1785537000, reviewer: GRACE, message: 'Change has been successfully merged' }],
  });

  const { code, out } = await watch(['watch', '200101', '--json'], { polls: [[before], [after]] });

  assert.equal(code, EXIT.ok);
  const record = JSON.parse(out);
  assert.equal(record.changes[0].status, 'MERGED');
  assert.deepEqual(record.deltas, [
    { change: 200101, kind: 'status', label: null, from: 'NEW', to: 'MERGED', by: 'grace' },
    { change: 200101, kind: 'messages', label: null, from: 0, to: 1, by: 'grace' },
  ]);
});

test('a change the server stops returning is a status change to null', async () => {
  const other = row({ number: 200102 });

  const { code, out } = await watch(['watch', '200101', '200102', '--json'], {
    polls: [[row(), other], [other]],
  });

  assert.equal(code, EXIT.ok);
  const record = JSON.parse(out);
  assert.deepEqual(record.changes, [{ change: 200101, subject: '', status: null, patch_set: 4, url: null }]);
  assert.deepEqual(record.deltas, [
    { change: 200101, kind: 'status', label: null, from: 'NEW', to: null, by: null },
  ]);
});

test('one record covers every change that moved in the same poll, in the order named', async () => {
  const quiet = row({ number: 200102 });
  const voted = row({
    number: 200103,
    updated: 1785537000,
    approvals: [{ type: 'Quokka-Review', value: '1', grantedOn: 1785537000, by: ALAN }],
  });
  const abandoned = row({ status: 'ABANDONED', updated: 1785537000 });

  const { code, out } = await watch(['watch', '200103', '200102', '200101', '--json'], {
    polls: [[row(), quiet, row({ number: 200103 })], [abandoned, quiet, voted]],
  });

  assert.equal(code, EXIT.ok);
  const record = JSON.parse(out);
  assert.equal(record.count, 2);
  assert.deepEqual(record.changes.map((c) => c.change), [200103, 200101]);
  assert.deepEqual(record.deltas.map((d) => [d.change, d.kind]), [[200103, 'vote_added'], [200101, 'status']]);
  assert.match(record.help[0], /^Run `gerrit-axi show 200103 200101 --comments`/);
  assert.match(record.help[1], /^Run `gerrit-axi watch 200103 200102 200101 --since <baseline>` to wait for the next change/);
});

test('nothing changed by --timeout is a record with changed: false and exit 6', async () => {
  const still = row();

  const { code, out, err, sleeps, queries } = await watch(
    ['watch', '200101', '--interval', '20', '--timeout', '50', '--json'],
    { polls: [[still]] },
  );

  assert.equal(code, EXIT.timeout);
  assert.equal(code, 6);
  assert.equal(err, '');
  const record = JSON.parse(out);
  assert.equal(record.ok, true);
  assert.equal(record.changed, false);
  assert.equal(record.count, 0);
  assert.deepEqual(record.changes, []);
  assert.deepEqual(record.deltas, []);
  // Polls at 0, 20 and 40 seconds; the last 10 are too short for another poll,
  // so the watch sleeps out the deadline and stops.
  assert.deepEqual(sleeps, [20_000, 20_000, 10_000]);
  assert.equal(queries, 3);
  assert.equal(record.polls, 3);
  assert.match(record.baseline, /^w1\./);
  assert.deepEqual(record.help, [
    'Run `gerrit-axi watch 200101 --interval 20 --timeout 50 --since <baseline>` to keep waiting from here;'
      + " <baseline> is this record's baseline, or a file holding this record",
  ]);
});

test('--since compares against the earlier baseline at once, and does not report a change twice', async () => {
  const before = row();
  const after = row({
    updated: 1785537000,
    approvals: [{ type: 'Quokka-Review', value: '2', grantedOn: 1785537000, by: GRACE }],
  });

  // A watch that times out with nothing changed hands over its baseline...
  const first = await watch(['watch', '200101', '--timeout', '0', '--json'], { polls: [[before]] });
  assert.equal(first.code, EXIT.timeout);
  const { baseline } = JSON.parse(first.out);

  // ...and the vote landed while no watch was running: the next one reports it
  // from its first query, without sleeping.
  const second = await watch(['watch', '200101', '--since', baseline, '--json'], { polls: [[after]] });
  assert.equal(second.code, EXIT.ok);
  assert.deepEqual(second.sleeps, []);
  assert.equal(second.queries, 1);
  const record = JSON.parse(second.out);
  assert.equal(record.polls, 1);
  assert.deepEqual(record.deltas, [
    { change: 200101, kind: 'vote_added', label: 'Quokka-Review', from: null, to: 2, by: 'grace' },
  ]);

  // Resuming from that record's baseline, the same vote is not news.
  const third = await watch(['watch', '200101', '--since', record.baseline, '--timeout', '0', '--json'], {
    polls: [[after]],
  });
  assert.equal(third.code, EXIT.timeout);
  assert.deepEqual(JSON.parse(third.out).deltas, []);
});

test('--since takes a file holding a whole earlier record, in TOON or JSON', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watch-since-'));
  try {
    const before = row();
    const after = row({ status: 'MERGED', updated: 1785537000 });

    const toon = await watch(['watch', '200101', '--timeout', '0'], { polls: [[before]] });
    assert.equal(toon.code, EXIT.timeout);
    assert.match(toon.out, /^baseline: w1\.\S+$/m);
    writeFileSync(path.join(dir, 'last.toon'), toon.out);
    const json = await watch(['watch', '200101', '--timeout', '0', '--json'], { polls: [[before]] });
    writeFileSync(path.join(dir, 'last.json'), json.out);

    for (const file of ['last.toon', 'last.json']) {
      const resumed = await watch(['watch', '200101', '--since', file, '--json'], { polls: [[after]], cwd: dir });
      assert.equal(resumed.code, EXIT.ok, file);
      assert.deepEqual(JSON.parse(resumed.out).deltas, [
        { change: 200101, kind: 'status', label: null, from: 'NEW', to: 'MERGED', by: null },
      ], file);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a change --since does not cover takes its baseline from the first query', async () => {
  const first = await watch(['watch', '200101', '--timeout', '0', '--json'], { polls: [[row()]] });
  const { baseline } = JSON.parse(first.out);
  const newcomer = row({ number: 200102, approvals: [{ type: 'Quokka-Review', value: '1', grantedOn: 1, by: ALAN }] });

  const { code, out } = await watch(['watch', '200101', '200102', '--since', baseline, '--timeout', '0', '--json'], {
    polls: [[row(), newcomer]],
  });

  assert.equal(code, EXIT.timeout);
  assert.deepEqual(JSON.parse(out).deltas, []);
});

test('--since that is not a baseline, or is one from another server, is refused before the server is asked', async () => {
  const bad = await watch(['watch', '200101', '--since', 'w1.not-base64-json', '--json'], { polls: [[row()]] });
  assert.equal(bad.code, EXIT.usage);
  assert.equal(JSON.parse(bad.out).code, 'BAD_USAGE');
  assert.equal(bad.queries, 0);

  const missing = await watch(['watch', '200101', '--since', 'no-such-file', '--json'], { polls: [[row()]] });
  assert.equal(missing.code, EXIT.usage);
  assert.match(JSON.parse(missing.out).error, /neither a watch baseline nor a readable file: no-such-file/);

  const first = await watch(['watch', '200101', '--timeout', '0', '--json'], { polls: [[row()]] });
  const { baseline } = JSON.parse(first.out);
  const elsewhere = await watch(
    ['watch', '200101', '--since', baseline, '--host', 'review.example.org', '--json'],
    { polls: [[row()]] },
  );
  assert.equal(elsewhere.code, EXIT.usage);
  assert.equal(JSON.parse(elsewhere.out).error,
    '--since is a baseline from gerrit.example.com, not review.example.org');
  assert.equal(elsewhere.queries, 0);
});

test('an --interval under the floor, or no change number, is refused before the server is asked', async () => {
  const fast = await watch(['watch', '200101', '--interval', '5', '--json'], { polls: [[row()]] });
  assert.equal(fast.code, EXIT.usage);
  assert.equal(JSON.parse(fast.out).error, '--interval must be at least 15 seconds, got: 5');
  assert.equal(fast.queries, 0);

  const none = await watch(['watch', '--json'], { polls: [[row()]] });
  assert.equal(none.code, EXIT.usage);
  assert.equal(JSON.parse(none.out).error, 'watch needs at least one change number');
  assert.deepEqual(JSON.parse(none.out).help, ['Run `gerrit-axi watch <change>... [--timeout <secs>]`']);
});

test('a change the server does not return at the baseline is NOT_FOUND', async () => {
  const { code, out } = await watch(['watch', '200101', '999999', '--json'], { polls: [[row()]] });

  assert.equal(code, EXIT.transport);
  const record = JSON.parse(out);
  assert.equal(record.ok, false);
  assert.equal(record.op, 'watch');
  assert.equal(record.code, 'NOT_FOUND');
  assert.equal(record.error, 'no such change: 999999');
});

test('a failing server is an error record: at once for the baseline, after repeated polls later', async () => {
  const refused = { code: 255, stderr: 'Permission denied (publickey).\n' };

  const atStart = await watch(['watch', '200101', '--json'], { polls: [[row()]], ssh: () => refused });
  assert.equal(atStart.code, EXIT.transport);
  assert.equal(atStart.err, '');
  const record = JSON.parse(atStart.out);
  assert.equal(record.ok, false);
  assert.equal(record.op, 'watch');
  assert.equal(record.code, 'SSH_FAILED');
  assert.equal(record.kind, 'transport');
  assert.equal(atStart.queries, 1);

  // Later, one dropped poll is ridden out and the watch carries on...
  const voted = row({ updated: 1785537000, approvals: [{ type: 'Quokka-Review', value: '1', grantedOn: 1, by: ALAN }] });
  const blip = await watch(['watch', '200101', '--json'], {
    polls: [[row()], [row()], [voted]],
    ssh: (call) => (call === 1 ? refused : undefined),
  });
  assert.equal(blip.code, EXIT.ok);
  assert.equal(JSON.parse(blip.out).deltas[0].kind, 'vote_added');

  // ...but three in a row end it.
  const down = await watch(['watch', '200101', '--json'], {
    polls: [[row()]],
    ssh: (call) => (call >= 1 ? refused : undefined),
  });
  assert.equal(down.code, EXIT.transport);
  assert.equal(JSON.parse(down.out).code, 'SSH_FAILED');
  assert.equal(down.queries, 4);
});

test('each poll is one gerrit query for every change named, with the cover messages', async () => {
  const { calls } = await watch(['watch', '200101', '200102', '--timeout', '60', '--json'], {
    polls: [[row(), row({ number: 200102 })]],
  });

  const queries = calls.filter((c) => c.file === 'ssh').map((c) => c.args);
  assert.equal(queries.length, 2);
  for (const args of queries) {
    for (const flag of ['--current-patch-set', '--all-approvals', '--submit-records', '--comments']) {
      assert.ok(args.includes(flag), `${flag} in ${args.join(' ')}`);
    }
    assert.ok(args.includes('(change:200101 OR change:200102)'));
  }
});
