// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { main, EXIT } from '../src/axi/main.js';
import { buildReadyArgs } from '../src/core/ready.js';
import { captureStream, fakeRunner } from './helpers.js';

const REVISION = 'a'.repeat(40);
const CHANGE = {
  number: 12345, project: 'demo', status: 'NEW', wip: true,
  currentPatchSet: { number: 2, revision: REVISION },
};

async function run(argv = [], { before = CHANGE, after = { ...CHANGE, wip: false }, post = {}, spawnFailure = false } = {}) {
  let reads = 0;
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: 'ssh://ada@gerrit.example.com:29418/demo\n' } },
    { match: (f, a) => f === 'ssh' && a.includes('query'), result: () => {
      const row = reads++ === 0 ? before : after;
      return { stdout: row === null ? '' : JSON.stringify(row) };
    } },
    { match: (f, a) => f === 'ssh' && a.includes('review'), result: () => {
      if (spawnFailure) throw new Error('cannot spawn');
      return post;
    } },
  ]);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(['ready', ...argv, '--json'], {
    env: { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' }, cwd: '/some/checkout',
    runner, stdout: stdout.stream, stderr: stderr.stream,
  });
  assert.equal(stderr.text, '');
  return { code, record: JSON.parse(stdout.text), calls: runner.calls.filter((c) => c.file === 'ssh') };
}

test('ready sends only fixed JSON on stdin and verifies the same patch set and revision', async () => {
  const { code, record, calls } = await run(['12345', '--patch-set', '2', '--revision', REVISION]);
  assert.equal(code, EXIT.ok);
  assert.deepEqual(record, { ok: true, op: 'ready', change: 12345, patch_set: 2,
    revision: REVISION, wip: false, status: 'NEW', already_ready: false });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args, ['-p', '29418', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '--', 'ada@gerrit.example.com', 'gerrit', 'review', '--json', '12345,2']);
  assert.equal(calls[1].input, '{"ready":true,"notify":"NONE"}');
  for (const i of [0, 2]) {
    for (const flag of ['--current-patch-set', '--all-approvals', '--submit-records']) assert.ok(calls[i].args.includes(flag));
    assert.equal(calls[i].input, undefined);
  }
});

test('already active succeeds without writing, but still checks the guard', async () => {
  const { code, record, calls } = await run(['12345'], { before: { ...CHANGE, wip: false } });
  assert.equal(code, EXIT.ok);
  assert.equal(record.already_ready, true);
  assert.equal(calls.length, 1);
  const stale = await run(['12345', '--patch-set', '1'], { before: { ...CHANGE, wip: false } });
  assert.equal(stale.record.code, 'PATCH_SET_MISMATCH');
  assert.equal(stale.calls.length, 1);
});

test('guards, closed changes, missing changes and malformed responses never write', async () => {
  const cases = [
    { argv: ['12345', '--patch-set', '1'], expected: 'PATCH_SET_MISMATCH' },
    { argv: ['12345', '--revision', 'b'.repeat(40)], expected: 'PATCH_SET_MISMATCH' },
    { before: { ...CHANGE, status: 'ABANDONED' }, expected: 'READY_REFUSED' },
    { before: { ...CHANGE, status: 'MERGED', wip: false }, expected: 'READY_REFUSED' },
    { before: null, expected: 'NOT_FOUND' },
    { before: { ...CHANGE, number: 99999 }, expected: 'NOT_FOUND' },
    { before: { ...CHANGE, currentPatchSet: null }, expected: 'BAD_RESPONSE' },
    { before: { ...CHANGE, currentPatchSet: { number: 0, revision: REVISION } }, expected: 'BAD_RESPONSE' },
  ];
  for (const c of cases) {
    const result = await run(c.argv ?? ['12345'], Object.hasOwn(c, 'before') ? { before: c.before } : {});
    assert.equal(result.code, EXIT.transport);
    assert.equal(result.record.code, c.expected);
    assert.equal(result.calls.length, 1);
  }
});

test('ready refuses malformed arguments before contacting the server', async () => {
  for (const argv of [[], ['12345', '12346'], ['-1'], ['12345', '--patch-set', '0'],
    ['12345', '--patch-set', '9007199254740992'], ['12345', '--revision', '--submit'],
    ['12345', '--revision', 'deadbeef'], ['12345', '--label', 'X=2'], ['12345', '--wip']]) {
    const { code, calls } = await run(argv);
    assert.equal(code, EXIT.usage, argv.join(' '));
    assert.equal(calls.length, 0);
  }
});

test('readback must confirm active, open, unchanged patch set and revision', async () => {
  for (const after of [CHANGE, { ...CHANGE, wip: false, status: 'MERGED' },
    { ...CHANGE, wip: false, currentPatchSet: { number: 3, revision: REVISION } },
    { ...CHANGE, wip: false, currentPatchSet: { number: 2, revision: 'b'.repeat(40) } }]) {
    const result = await run(['12345'], { after });
    assert.equal(result.record.code, 'READY_NOT_CONFIRMED');
    assert.equal(result.code, EXIT.transport);
    assert.equal(result.calls.length, 3);
  }
  const missing = await run(['12345'], { after: null });
  assert.equal(missing.record.code, 'NOT_FOUND');
});

test('ready distinguishes Gerrit refusal from SSH failure', async () => {
  for (const [post, expected] of [[{ code: 1, stderr: 'permission denied' }, 'READY_REFUSED'],
    [{ code: 255, stderr: 'connection refused' }, 'SSH_FAILED']]) {
    const result = await run(['12345'], { post });
    assert.equal(result.code, EXIT.transport);
    assert.equal(result.record.code, expected);
    assert.match(result.record.error, new RegExp(post.stderr));
    assert.equal(result.calls.length, 2);
  }
  assert.equal((await run(['12345'], { spawnFailure: true })).record.code, 'SSH_FAILED');
});

test('ready argv rejects injected targets and unsafe SSH destinations', () => {
  const conn = { host: 'gerrit.example.com', port: 29418, user: 'ada' };
  for (const value of [0, -1, '1 --submit', NaN, Infinity]) {
    assert.throws(() => buildReadyArgs(conn, value, 2));
    assert.throws(() => buildReadyArgs(conn, 12345, value));
  }
  assert.throws(() => buildReadyArgs({ ...conn, user: '-oProxyCommand=id' }, 12345, 2), /begins with/);
});

test('interrupted ready writes report SSH failure and an uncertain activation outcome', async () => {
  for (const post of [
    { code: null, stderr: '\ntimed out after 60000ms' },
    { code: null, stderr: '' },
    { code: 255, stderr: 'connection lost' },
  ]) {
    const { code, record, calls } = await run(['12345'], { post });
    assert.equal(code, EXIT.transport);
    assert.equal(record.code, 'SSH_FAILED');
    assert.ok(record.error.includes(post.stderr.trim() || 'exit null'));
    assert.match(record.remedy, /Inspect the change before retrying/);
    assert.match(record.remedy, /ready write may already have taken effect/);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes('review'));
    assert.equal(calls[1].input, '{"ready":true,"notify":"NONE"}');
  }
});
