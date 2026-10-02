// SPDX-License-Identifier: Apache-2.0

/**
 * The three facts a reviewer asks for together: which patch set the server has,
 * who voted and when, and what the cover messages say -- including a build result
 * and the URL it points at.
 *
 * Offline like everything else here: `test/fixtures/query-detail.txt` is a
 * recorded `gerrit query --comments --dependencies` response.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveMessages,
  deriveVotes,
  fillNeededByCurrency,
  normalizeChange,
  queryChangeDetails,
} from '../src/core/changes.js';
import { parseQueryOutput } from '../src/core/ssh.js';
import { Session } from '../src/core/session.js';
import { EXIT, main } from '../src/cli/main.js';
import { abbreviateRevision, formatAge, formatDateTime } from '../src/cli/render.js';
import { messageCountFromArg } from '../src/cli/commands/show.js';
import { captureStream, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', NO_COLOR: '1', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';

test('cover messages come back oldest first, with their patch set and their URLs', () => {
  const { rows } = parseQueryOutput(fixture('query-detail.txt'));
  const change = normalizeChange(rows[0]);

  // The fixture lists them out of order on purpose.
  assert.deepEqual(change.messages.map((m) => m.patchSet), [1, 2, 3, 3]);
  assert.deepEqual(
    change.messages.map((m) => m.timestamp?.getTime()),
    [1751000100, 1753790500, 1753800500, 1753801000].map((s) => s * 1000),
  );

  const failed = change.messages.find((m) => m.message.includes('Build Failed'));
  assert.equal(failed?.author?.username, 'buildbot');
  assert.equal(failed?.patchSet, 2);
  assert.deepEqual(failed?.urls, ['https://ci.example.com/job/widget-console/408/'],
    'the sentence-ending full stop is not part of the URL');

  const succeeded = change.messages.find((m) => m.message.includes('Build Successful'));
  assert.deepEqual(succeeded?.urls, ['https://ci.example.com/job/widget-console/412/']);
  assert.equal(succeeded?.message.includes('\n'), true, 'the body is kept verbatim, newlines and all');
});

test('a cover message that names no patch set gets null rather than a guess', () => {
  const messages = deriveMessages({
    comments: [
      { timestamp: 1753800000, reviewer: { username: 'grace' }, message: 'Nice.' },
      { timestamp: 1753800100, reviewer: { username: 'ada' }, message: 'Uploaded patch set 8.' },
      { timestamp: 1753800200, reviewer: { username: 'buildbot' }, message: 'Patch Set 12: Some-Label-1' },
    ],
  });
  assert.deepEqual(messages.map((m) => m.patchSet), [null, 8, 12]);
  assert.deepEqual(messages.map((m) => m.urls), [[], [], []]);
});

test('a change queried without --comments reports no messages rather than inventing any', () => {
  const { rows } = parseQueryOutput(fixture('query-output.txt'));
  const change = normalizeChange(rows[0]);
  assert.deepEqual(change.messages, []);
  assert.deepEqual(change.dependsOn, []);
  assert.deepEqual(change.neededBy, []);
});

test('every vote carries who cast it and when, oldest first', () => {
  const votes = deriveVotes({
    currentPatchSet: {
      approvals: [
        { type: 'Quokka-Review', value: '2', grantedOn: 1753900000, by: { username: 'grace' } },
        { type: 'Quokka-Review', value: '-1', grantedOn: 1753800000, by: { username: 'alan' } },
      ],
    },
  });
  assert.equal(votes.length, 1);
  assert.deepEqual(votes[0].votes.map((v) => v.by?.username), ['alan', 'grace']);
  assert.deepEqual(votes[0].votes.map((v) => v.value), [-1, 2]);
  assert.equal(votes[0].votes[0].grantedOn?.toISOString(), new Date(1753800000 * 1000).toISOString());
  assert.equal(votes[0].votes[1].grantedOn?.toISOString(), new Date(1753900000 * 1000).toISOString());
});

test('a vote the server timestamped with nothing is null, not the epoch', () => {
  const votes = deriveVotes({
    currentPatchSet: { approvals: [{ type: 'Quokka-Review', value: '1', by: { username: 'grace' } }] },
  });
  assert.equal(votes[0].votes[0].grantedOn, null);
  assert.equal(votes[0].votes[0].by?.username, 'grace');
});

test('the current patch set carries its number, revision, ref and uploader', () => {
  const { rows } = parseQueryOutput(fixture('query-detail.txt'));
  const change = normalizeChange(rows[0]);
  assert.equal(change.currentPatchSet?.number, 3);
  assert.equal(change.currentPatchSet?.revision, 'aaaa111122223333444455556666777788889999');
  assert.equal(change.currentPatchSet?.ref, 'refs/changes/58/184458/3');
  assert.equal(change.currentPatchSet?.uploader?.username, 'ada');
  assert.equal(change.currentPatchSet?.createdOn?.getTime(), 1753790000 * 1000);
});

test('dependencies report whether the revision is still that change\'s current patch set', () => {
  const { rows } = parseQueryOutput(fixture('query-detail.txt'));
  const change = normalizeChange(rows[0]);

  assert.equal(change.dependsOn.length, 1);
  assert.equal(change.dependsOn[0].number, 184400);
  assert.equal(change.dependsOn[0].revision, 'dddd111122223333444455556666777788889999');
  assert.equal(change.dependsOn[0].isCurrentPatchSet, false, 'stacked on a superseded parent revision');
  assert.equal(change.neededBy[0].number, 184470);
  assert.equal(change.neededBy[0].isCurrentPatchSet, true);
});

test('a server that does not say whether a dependency is current gets null, not false', () => {
  const change = normalizeChange({
    project: 'acme/one',
    number: 1,
    dependsOn: [{ number: '2', revision: 'ffff1111', ref: 'refs/changes/02/2/1' }],
  });
  assert.equal(change.dependsOn[0].isCurrentPatchSet, null);
  assert.equal(change.dependsOn[0].number, 2, 'a string change number is coerced');
});

test('a dependent is current when its patch set is that change\'s current one, read off changes in hand', async () => {
  const runner = fakeRunner([]);
  const session = new Session({ config: /** @type {any} */ ({ host: 'gerrit.example.com', port: 29418, user: 'ada' }),
    env: {}, runner });
  const parent = normalizeChange({
    project: 'acme/one',
    number: 1,
    currentPatchSet: { number: '3', revision: 'a'.repeat(40), ref: 'refs/changes/01/1/3' },
    neededBy: [
      { number: 2, revision: 'b'.repeat(40), ref: 'refs/changes/02/2/1' },
      { number: 2, revision: 'c'.repeat(40), ref: 'refs/changes/02/2/2' },
      { number: 3, revision: 'd'.repeat(40), ref: 'refs/changes/03/3/1', isCurrentPatchSet: false },
    ],
  });
  const child = normalizeChange({
    project: 'acme/one',
    number: 2,
    currentPatchSet: { number: '2', revision: 'c'.repeat(40), ref: 'refs/changes/02/2/2' },
  });

  const [filled, untouched] = await fillNeededByCurrency(session, [parent, child]);

  assert.deepEqual(filled.neededBy.map((d) => [d.number, d.ref, d.isCurrentPatchSet]), [
    [2, 'refs/changes/02/2/1', false],
    [2, 'refs/changes/02/2/2', true],
    [3, 'refs/changes/03/3/1', false],
  ], 'an outdated patch set is kept and marked; a flag the server sent is kept as sent');
  assert.deepEqual(untouched, child);
  assert.equal(runner.calls.length, 0, 'every dependent left unflagged was in hand, so nothing is asked');
});

test('a dependent not in hand is looked up in one query, and one the server does not return stays null', async () => {
  const runner = fakeRunner([{
    match: (f) => f === 'ssh',
    result: {
      stdout: `${JSON.stringify({
        project: 'acme/one',
        number: 2,
        currentPatchSet: { number: '1', revision: 'b'.repeat(40), ref: 'refs/changes/02/2/1' },
      })}\n{"type":"stats","rowCount":1}\n`,
    },
  }]);
  const session = new Session({ config: /** @type {any} */ ({ host: 'gerrit.example.com', port: 29418, user: 'ada' }),
    env: {}, runner });
  const parent = normalizeChange({
    project: 'acme/one',
    number: 1,
    neededBy: [
      { number: 2, revision: 'b'.repeat(40), ref: 'refs/changes/02/2/1' },
      { number: 9, revision: 'e'.repeat(40), ref: 'refs/changes/09/9/4' },
    ],
  });

  const [filled] = await fillNeededByCurrency(session, [parent]);

  assert.deepEqual(filled.neededBy.map((d) => d.isCurrentPatchSet), [true, null]);
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0].args.includes('(change:2 OR change:9)'), runner.calls[0].args.join(' '));
});

test('queryChangeDetails asks the server for the cover messages and the dependencies', async () => {
  const runner = fakeRunner([
    { match: (f) => f === 'ssh', result: { stdout: fixture('query-detail.txt') } },
  ]);
  const session = new Session({
    config: {
      host: 'gerrit.example.com',
      port: 29418,
      user: 'ada',
      project: null,
      restBase: 'https://gerrit.example.com',
      severityPatterns: [],
      sources: {},
      configPath: '/nonexistent/config.json',
    },
    env: {},
    runner,
  });

  const changes = await queryChangeDetails(session, ['184458']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].messages.length, 4);

  const { args } = runner.calls[0];
  assert.ok(args.includes('--comments'), 'cover messages need --comments');
  assert.ok(args.includes('--dependencies'), 'isCurrentPatchSet needs --dependencies');
  assert.ok(args.includes('--current-patch-set'));
  assert.ok(args.includes('change:184458'));
  assert.equal(args.includes('--patch-sets'), false, 'inline comments come over REST, not here');
});

test('gerrit show answers all three questions in one view', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    { match: (f) => f === 'ssh', result: { stdout: fixture('query-detail.txt') } },
  ]);

  const code = await main(['show', '184458'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner,
  });
  assert.equal(code, EXIT.ok);
  const text = stdout.text;

  // 3. the current patch set and its revision, in full, plus the ref it was pushed to.
  assert.match(text, /patch set\s+3\s+aaaa111122223333444455556666777788889999/);
  assert.match(text, /ref\s+refs\/changes\/58\/184458\/3/);
  assert.match(text, /uploaded\s+ada\s+2025-07-29/);
  // ...and the dependency's staleness, which is why --dependencies is asked for.
  assert.match(text, /depends on\s+184400\s+dddd111122\s+superseded -- that change has a newer patch set/);
  assert.match(text, /needed by\s+184470\s+eeee111122\s+that change's current patch set/);

  // 2. who voted, and when.
  assert.match(text, /LABEL\s+VOTE\s+WHO\s+WHEN\s+SUBMIT/);
  assert.match(text, /Widget-Approval\s+\+1\s+grace\s+2025-07-29 \d\d:\d\d\s+\(\d+\S* ago\)\s+OK/);
  assert.match(text, /Release-Gate\s+\+1\s+buildbot\s+2025-07-29/);
  // A label nobody voted on is still listed, with the server's verdict.
  assert.match(text, /Zebra-Check\s+·\s+-\s+-\s+NEED/);
  assert.match(text, /blocked on\s+Zebra-Check/);

  // 1. the cover messages, verbatim, including the build result and its URL.
  assert.match(text, /messages \(4, oldest first\)/);
  assert.match(text, /Build Failed/);
  assert.match(text, /https:\/\/ci\.example\.com\/job\/widget-console\/408\/ : FAILURE\./);
  assert.match(text, /Build Successful/);
  assert.match(text, /\[ps3\]\s+<buildbot>/);
  assert.match(text, /Uploaded patch set 1\./);
  // Oldest first: the failure on ps2 is printed above the success on ps3.
  assert.ok(text.indexOf('Build Failed') < text.indexOf('Build Successful'));
});

test('a blocking verdict is printed against the vote the server credited it to', async () => {
  // Change 184402 has a +1 and a -2 on one label, and the server's REJECT names
  // the account that cast the -2. Printing REJECT beside the +1 -- the older vote,
  // and the first row of the group -- would misattribute who blocked the change.
  const stdout = captureStream();
  const code = await main(['show', '184402'], {
    cwd: '/some/checkout',
    env: { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', FORCE_COLOR: '1', PATH: '' },
    stdout: stdout.stream,
    stderr: captureStream().stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: fixture('query-output.txt') } },
    ]),
  });
  assert.equal(code, EXIT.ok);

  const plain = stdout.text.replace(/\u001b\[[0-9;]*m/g, '');
  const rows = plain.split('\n').filter((l) => /\balan\b|\bgrace\b/.test(l));
  assert.match(rows[0], /Widget-Approval\s+\+1\s+alan\s+\S+ \S+\s+\([^)]+\)\s*$/, 'no verdict on the +1');
  assert.match(rows[1], /-2\s+grace\s+.*REJECT$/, 'the verdict belongs to the vote that blocked it');
  assert.match(plain, /status\s+NEW\s+·\s+WIP\s+·\s+submit NOT_READY/);

  // Colour is on above, so every escape introduced must be a complete one.
  assert.ok(stdout.text.includes('\u001b['), 'colour should be on for this to mean anything');
  for (const match of stdout.text.match(/\u001b\[?[^m]*m?/g) ?? []) {
    assert.match(match, /^\u001b\[[0-9;]*m$/, `malformed escape sequence: ${JSON.stringify(match)}`);
  }
});

test('gerrit show --messages bounds the timeline and says what it left out', async () => {
  const io = () => {
    const stdout = captureStream();
    return {
      stdout,
      args: {
        cwd: '/some/checkout',
        env: ENV,
        stdout: stdout.stream,
        stderr: captureStream().stream,
        stdin: /** @type {any} */ ({ isTTY: false }),
        runner: fakeRunner([
          { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
          { match: (f) => f === 'ssh', result: { stdout: fixture('query-detail.txt') } },
        ]),
      },
    };
  };

  const bounded = io();
  assert.equal(await main(['show', '184458', '--messages', '2'], bounded.args), EXIT.ok);
  assert.match(bounded.stdout.text, /messages \(the last 2 of 4, oldest first; --messages all for every one\)/);
  assert.equal(bounded.stdout.text.includes('Uploaded patch set 1.'), false, 'the oldest two are dropped');
  assert.match(bounded.stdout.text, /Build Successful/, 'the newest are kept');

  const none = io();
  assert.equal(await main(['show', '184458', '--messages', '0'], none.args), EXIT.ok);
  assert.equal(none.stdout.text.includes('Build Successful'), false);
  assert.match(none.stdout.text, /patch set\s+3/, 'the rest of the view is unaffected');

  const every = io();
  assert.equal(await main(['show', '184458', '--messages', 'all'], every.args), EXIT.ok);
  assert.match(every.stdout.text, /messages \(4, oldest first\)/);
});

test('show rejects a non-numeric change and a nonsense --messages before querying', async () => {
  const io = () => {
    const stderr = captureStream();
    const runner = fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: fixture('query-detail.txt') } },
    ]);
    return {
      stderr,
      runner,
      args: {
        cwd: '/some/checkout',
        env: ENV,
        stdout: captureStream().stream,
        stderr: stderr.stream,
        stdin: /** @type {any} */ ({ isTTY: false }),
        runner,
      },
    };
  };

  const named = io();
  assert.equal(await main(['show', 'HEAD'], named.args), EXIT.usage);
  assert.match(named.stderr.text, /not a change number: HEAD/);
  assert.equal(named.runner.calls.some((c) => c.file === 'ssh'), false, 'must not have queried');

  const badCount = io();
  assert.equal(await main(['show', '184458', '--messages', 'lots'], badCount.args), EXIT.usage);
  assert.match(badCount.stderr.text, /--messages takes a non-negative integer or 'all'/);
  assert.equal(badCount.runner.calls.some((c) => c.file === 'ssh'), false);

  const noChange = io();
  assert.equal(await main(['show'], noChange.args), EXIT.usage);
  assert.match(noChange.stderr.text, /usage: gerrit show/);

  assert.equal(messageCountFromArg(undefined), 10);
  assert.equal(messageCountFromArg('all'), Infinity);
  assert.equal(messageCountFromArg('0'), 0);
  assert.throws(() => messageCountFromArg('-1'), /non-negative integer/);
});

test('a change nobody can see says so instead of printing an empty view', async () => {
  const stdout = captureStream();
  const code = await main(['show', '999999'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: '{"type":"stats","rowCount":0}\n' } },
    ]),
  });
  assert.equal(code, EXIT.ok);
  assert.equal(stdout.text.trim(), 'no such change is visible to you');
});

test('gerrit status --patch-set adds the patch set and an abbreviated revision', async () => {
  const stdout = captureStream();
  const code = await main(['status', '--patch-set'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: fixture('query-output.txt') } },
    ]),
  });

  assert.equal(code, EXIT.ok);
  const lines = stdout.text.trimEnd().split('\n');
  assert.match(lines[0], /^CHANGE\s+PROJECT\s+BRANCH\s+UPDATED\s+SUBMIT\s+PATCH-SET\s+BLOCKED-ON\s+SUBJECT$/);
  assert.match(lines.find((l) => l.includes('184458')), /3@aaaa111122/);
  assert.match(lines.find((l) => l.includes('184431')), /1@bbbb111122/);
});

test('every command and its options are discoverable from the top-level help', async () => {
  // A session once missed --labels entirely because subcommand options appeared
  // nowhere but in the subcommand's own help.
  const stdout = captureStream();
  await main(['--help'], {
    cwd: '/tmp',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([]),
  });
  const text = stdout.text;
  for (const fragment of [
    'show <change>...',
    '--messages',
    '--labels',
    '--patch-set',
    '--limit',
    '--bots',
    '--stdin',
  ]) {
    assert.ok(text.includes(fragment), `top-level help should mention ${fragment}`);
  }

  const showHelp = captureStream();
  await main(['show', '--help'], {
    cwd: '/tmp',
    env: ENV,
    stdout: showHelp.stream,
    stderr: captureStream().stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([]),
  });
  assert.match(showHelp.text, /usage: gerrit show <change>\.\.\./);
  assert.match(showHelp.text, /--messages <n>/);
});

test('formatAge is coarse, and measured against a given instant rather than the clock', () => {
  const now = new Date('2026-08-10T12:00:00Z');
  assert.equal(formatAge(new Date('2026-08-10T11:59:30Z'), now), 'just now');
  assert.equal(formatAge(new Date('2026-08-10T11:20:00Z'), now), '40m ago');
  assert.equal(formatAge(new Date('2026-08-10T04:00:00Z'), now), '8h ago');
  assert.equal(formatAge(new Date('2026-08-07T12:00:00Z'), now), '3d ago');
  assert.equal(formatAge(new Date('2026-01-10T12:00:00Z'), now), '7mo ago');
  assert.equal(formatAge(new Date('2023-08-10T12:00:00Z'), now), '3y ago');
  assert.equal(formatAge(null, now), '-');
  assert.equal(formatAge(new Date('2026-08-10T12:30:00Z'), now), 'in the future');
});

test('a revision is abbreviated by truncation, never with an ellipsis to copy by mistake', () => {
  assert.equal(abbreviateRevision('aaaa111122223333444455556666777788889999'), 'aaaa111122');
  assert.equal(abbreviateRevision('aaaa111122223333', 7), 'aaaa111');
  assert.equal(abbreviateRevision(null), '-');
  assert.equal(formatDateTime(new Date('2026-08-10T12:34:56Z')), '2026-08-10 12:34');
  assert.equal(formatDateTime(null), '-');
});
