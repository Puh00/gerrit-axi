// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { main, EXIT } from '../src/axi/main.js';
import { Session } from '../src/core/session.js';
import { restReady, restWip } from '../src/core/rest.js';
import { captureStream, fakeFetch, fakeRunner, PLACEHOLDER_TOKEN } from './helpers.js';

const REVISION = 'a'.repeat(40);
const CHANGE = { _number: 12345, status: 'NEW', current_revision: REVISION,
  revisions: { [REVISION]: { _number: 2 } } };

async function run(t, op, { before, after, argv = [], status = 200, readStatus = 200,
  missingToken = false, failure = false, json = true } = {}) {
  const wip = op === 'wip';
  before ??= { ...CHANGE, work_in_progress: !wip };
  after ??= { ...CHANGE, ...(wip ? { work_in_progress: true } : {}) };
  if (!missingToken) t.mock.method(Session.prototype, 'token', async () => ({ token: PLACEHOLDER_TOKEN }));
  const runner = fakeRunner([]);
  const calls = [];
  let reads = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), ...init });
    if (init.method === 'POST' && failure) throw new Error('connection lost');
    return {
      status: init.method === 'POST' ? status : readStatus,
      headers: new Map(),
      text: async () => init.method === 'POST' ? '' : ")]}'\n" + JSON.stringify(reads++ === 0 ? before : after),
    };
  };
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main([op, '12345', ...(wip ? [] : ['--rest']), ...argv,
    '--host', 'gerrit.example.com', '--user', 'ada', ...(json ? ['--json'] : [])], {
    env: { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' }, cwd: '/some/checkout',
    runner, fetchImpl, stdout: stdout.stream, stderr: stderr.stream,
  });
  assert.equal(stderr.text, '');
  assert.equal(runner.calls.some((call) => call.file === 'ssh'), false, 'REST must not invoke SSH');
  t.mock.restoreAll();
  return { code, record: json ? JSON.parse(stdout.text) : stdout.text, calls };
}

for (const op of ['ready', 'wip']) {
  test(`${op} REST sends only a fixed POST and confirms state with REST reads`, async (t) => {
    const { code, record, calls } = await run(t, op, { argv: ['--patch-set', '2', '--revision', REVISION] });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(record, { ok: true, op, change: 12345, patch_set: 2, revision: REVISION,
      wip: op === 'wip', status: 'NEW', [op === 'wip' ? 'already_wip' : 'already_ready']: false });
    assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname + new URL(call.url).search]), [
      ['GET', '/a/changes/12345?o=CURRENT_REVISION'], ['POST', `/a/changes/12345/${op}`],
      ['GET', '/a/changes/12345?o=CURRENT_REVISION'],
    ]);
    assert.equal(calls[1].body, '{}');
    for (const call of calls) {
      assert.equal(call.redirect, 'manual');
      assert.equal(call.headers.Authorization, `Basic ${Buffer.from(`ada:${PLACEHOLDER_TOKEN}`).toString('base64')}`);
    }
    assert.ok(!JSON.stringify(record).includes(PLACEHOLDER_TOKEN));
    const toon = await run(t, op, { json: false });
    assert.equal(toon.code, EXIT.ok);
    assert.match(toon.record, new RegExp(`^op: ${op}$`, 'm'));
  });

  test(`${op} REST checks guards even on a no-op and never writes closed or malformed changes`, async (t) => {
    const before = { ...CHANGE, work_in_progress: op === 'wip' };
    const noop = await run(t, op, { before });
    assert.equal(noop.code, EXIT.ok);
    assert.equal(noop.record[op === 'wip' ? 'already_wip' : 'already_ready'], true);
    assert.equal(noop.calls.length, 1);
    for (const [options, expected] of [
      [{ before, argv: ['--patch-set', '1'] }, 'PATCH_SET_MISMATCH'],
      [{ before, argv: ['--revision', 'b'.repeat(40)] }, 'PATCH_SET_MISMATCH'],
      [{ before: { ...before, status: 'MERGED' } }, `${op.toUpperCase()}_REFUSED`],
      [{ before: { ...before, status: 'ABANDONED' } }, `${op.toUpperCase()}_REFUSED`],
      [{ before: { ...before, current_revision: undefined } }, 'BAD_RESPONSE'],
      [{ before: { ...before, revisions: {} } }, 'BAD_RESPONSE'],
      [{ before: { ...before, _number: 12346 } }, 'BAD_RESPONSE'],
      [{ before: { ...before, work_in_progress: 'false' } }, 'BAD_RESPONSE'],
    ]) {
      const result = await run(t, op, options);
      assert.equal(result.code, EXIT.transport);
      assert.equal(result.record.code, expected);
      assert.equal(result.calls.length, 1);
    }
  });

  test(`${op} REST readback rejects wrong state, status, patch set, and revision`, async (t) => {
    const after = { ...CHANGE, work_in_progress: op === 'wip' };
    for (const changed of [
      { ...after, work_in_progress: op !== 'wip' },
      { ...after, status: 'MERGED' },
      { ...after, revisions: { [REVISION]: { _number: 3 } } },
      { ...after, current_revision: 'b'.repeat(40), revisions: { ['b'.repeat(40)]: { _number: 2 } } },
    ]) {
      const result = await run(t, op, { after: changed });
      assert.equal(result.record.code, `${op.toUpperCase()}_NOT_CONFIRMED`);
      assert.equal(result.calls.length, 3);
    }
  });

  test(`${op} REST preserves typed failures without fallback or retry`, async (t) => {
    for (const [status, expected] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
      [409, `${op.toUpperCase()}_REFUSED`], [302, 'HTTP_ERROR'], [500, 'HTTP_ERROR']]) {
      const result = await run(t, op, { status });
      assert.equal(result.record.code, expected);
      assert.equal(result.code, status === 401 ? EXIT.auth : EXIT.transport);
      assert.equal(result.calls.length, 2);
    }
    const lost = await run(t, op, { failure: true });
    assert.equal(lost.record.code, 'HTTP_ERROR');
    assert.equal(lost.calls.length, 2);
    const missing = await run(t, op, { missingToken: true });
    assert.equal(missing.code, EXIT.auth);
    assert.equal(missing.record.code, 'NO_CREDENTIAL');
    assert.equal(missing.calls.length, 0);
    const bad = await run(t, op, { readStatus: 401 });
    assert.equal(bad.record.code, 'UNAUTHORIZED');
    assert.equal(bad.calls.length, 1);
  });

  test(`${op} refuses injected options and invalid guards before HTTP calls`, async (t) => {
    for (const argv of [['--patch-set', '0'], ['--revision', 'abcd'], ['--label', 'X=2'],
      ['--notify', 'ALL'], ['--submit'], ['--rest=false'], ['12346']]) {
      const result = await run(t, op, { argv });
      assert.equal(result.code, EXIT.usage);
      assert.equal(result.calls.length, 0);
    }
  });
}

test('REST state writers reject invalid or injected targets without requests', async () => {
  const fetchImpl = fakeFetch([]);
  const target = { restBase: 'https://gerrit.example.com', user: 'ada', token: PLACEHOLDER_TOKEN, fetchImpl };
  for (const write of [restReady, restWip]) {
    for (const value of ['12345/submit', '../submit', '12345', 0, -1, Infinity, 1.5]) {
      await assert.rejects(write(target, value), { code: 'BAD_RESPONSE' });
    }
  }
  assert.equal(fetchImpl.calls.length, 0);
});
