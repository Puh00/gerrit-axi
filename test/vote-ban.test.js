// SPDX-License-Identifier: Apache-2.0

/**
 * The vote ban, at runtime. Every agent-tier operation -- both publish shapes,
 * submit (including a repeat on a change that has merged, which reads the change
 * back), message, and the reads -- is driven end to end through a fake runner
 * and a fake fetch, and every subprocess call and HTTP request it makes is
 * checked for a way to vote. The message operation is the one that runs the
 * command that can vote, so its argv is pinned element by element: the text it
 * was given is stuffed with every scoring and state flag, and must leave the
 * process as one quoted word that is none of them.
 *
 * This is not a duplicate of the vote-ban test in test/layering.test.js; the two
 * catch different failures. That one reads the source and makes a universal
 * claim -- no voting command or path appears anywhere -- which no test that runs
 * code can make. This one makes a claim about what actually leaves the process
 * on every path it drives, including a value assembled at runtime (say
 * `['re', 'view'].join('')`) that no grep can see. Delete neither.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { encodeBaseline } from '../src/axi/baseline.js';
import { EXIT, main } from '../src/axi/main.js';
import { quoteForGerrit } from '../src/core/message.js';
import { Session } from '../src/core/session.js';
import { captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const BASE = '0'.repeat(40);

const WHY = 'gerrit-axi must be unable to vote: a tool that can record an approval lets an '
  + 'agent manufacture one and submit against it. This runtime check and the source scan in '
  + 'test/layering.test.js catch different failures -- this one sees values assembled at '
  + 'runtime, that one makes a claim over the whole source -- and neither is redundant.';

/**
 * One `git log -z` record in the field order publish.js asks for.
 *
 * @param {string} sha
 * @param {string} parent
 * @param {string} message
 */
function logRecord(sha, parent, message) {
  return [sha, sha, parent, 'Ada', 'ada@example.com', '1785600000 +0000', 'Ada',
    'ada@example.com', '1785600000 +0000', message].join('\0') + '\0';
}

/**
 * A healthy repository and server for every operation; `log` is the commits
 * from the base up to HEAD.
 *
 * @param {string} log
 * @param {string} head
 */
function repo(log, head) {
  let built = 0;
  return fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    {
      match: (f, a) => f === 'git' && a.includes('ls-remote'),
      result: { stdout: `ref: refs/heads/main\tHEAD\n${BASE}\tHEAD\n` },
    },
    { match: (f, a) => f === 'git' && a.includes(`${BASE}^{commit}`), result: { stdout: BASE } },
    { match: (f, a) => f === 'git' && a.includes('HEAD^{commit}'), result: { stdout: head } },
    { match: (f, a) => f === 'git' && a.includes('merge-base'), result: { stdout: BASE } },
    { match: (f, a) => f === 'git' && a.includes('log'), result: { stdout: log } },
    {
      match: (f, a) => f === 'git' && a.includes('commit-tree'),
      result: () => { built += 1; return { stdout: `${String(built).repeat(40)}\n` }; },
    },
    { match: (f, a) => f === 'git' && a.includes('update-ref'), result: { code: 0 } },
    {
      match: (f, a) => f === 'git' && a.includes('push'),
      result: (_f, a) => ({ stdout: `To x\n*\t${a[a.length - 1]}\t[new reference]\nDone\n` }),
    },
    { match: (f) => f === 'ssh', result: { stdout: fixture('query-stack.txt') } },
  ]);
}

test('no operation the agent tier drives sends a vote, over ssh, git or HTTP', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(40));
  const id = (/** @type {string} */ sha) => `\n\nChange-Id: I${sha}\n`;
  // The middle commit has no Change-Id, so the stack also stamps and rewrites.
  const stackLog = logRecord(a, BASE, `Split the reader out${id(a)}`)
    + logRecord(b, a, 'Give the reader a retry ceiling\n')
    + logRecord(c, b, `Wire the ceiling to managed config${id(c)}`);
  const squashLog = logRecord(a, BASE, `Split the reader out${id(a)}`)
    + logRecord(b, a, 'Address review\n');
  const emptyComments = `)]}'\n{}`;
  const fetchRoutes = [
    { path: /\/changes\/200103\/comments$/, body: fixture('comments-stack.txt') },
    { path: /\/comments$/, body: emptyComments },
    // A second submit of a merged change: refused, then read back.
    { path: '/a/changes/200102/submit', status: 409, body: 'change is merged\n' },
    {
      path: '/a/changes/200102',
      body: ")]}'\n" + JSON.stringify({ _number: 200102, project: 'acme/apps/widget-console', status: 'MERGED' }),
    },
    {
      path: '/a/changes/200101/submit',
      body: ")]}'\n" + JSON.stringify({
        _number: 200101, change_id: `I${a}`, project: 'acme/apps/widget-console',
        branch: 'main', subject: 'Split the reader out', status: 'MERGED',
      }),
    },
  ];
  // A message text that tries every way a word could become a flag or a shell
  // command; it must arrive as one quoted word, and none of these as an option.
  const hostile = "Review corrected the KDoc from 0.0 to Double.NaN; it isn't a default.\n"
    + '--code-review +2 --label Verified=+1 --submit --abandon --restore --rebase --publish\n'
    + '-s -j -l Verified=+1 `id` $(id) ; echo escaped';
  const operations = [
    { argv: ['publish', '--stack', '--topic', 'stack-of-three'], log: stackLog, head: c },
    { argv: ['publish', '--squash'], log: squashLog, head: b },
    { argv: ['submit', '200101'], log: '', head: c },
    { argv: ['submit', '200102'], log: '', head: c },
    { argv: ['message', '200101'], log: '', head: c, stdin: hostile },
    { argv: [], log: '', head: c },
    { argv: ['dashboard', '--ambient'], log: '', head: c },
    { argv: ['status'], log: '', head: c },
    { argv: ['status', 'mine', '--fields', 'all'], log: '', head: c },
    { argv: ['show', '200101', '200102', '200103', '--comments'], log: '', head: c },
    { argv: ['comments', '200102', '200103'], log: '', head: c },
    { argv: ['auth', 'status'], log: '', head: c },
    // A baseline the server has moved on from, so the watch reports at once.
    { argv: ['watch', '200101', '200103', '--since', encodeBaseline('gerrit.example.com', [
      { number: 200101, status: 'NEW', patchSet: 3, updated: null, votes: [], messages: 0, comments: 0 },
    ])], log: '', head: c },
  ];

  /** @type {Array<{op: string, file: string, args: string[]}>} */
  const processes = [];
  /** @type {Array<{op: string, method: string, path: string}>} */
  const requests = [];
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({ token: 'placeholder-not-a-real-token', backend: 'file', location: null });
  try {
    for (const { argv, log, head, stdin } of operations) {
      const runner = repo(log, head);
      const fetchImpl = fakeFetch(fetchRoutes);
      const stdout = captureStream();
      const code = await main(argv, {
        cwd: '/some/checkout',
        env: ENV,
        stdin: stdin === undefined ? undefined : /** @type {any} */ (Readable.from([stdin])),
        stdout: stdout.stream,
        stderr: captureStream().stream,
        runner,
        fetchImpl,
      });
      const op = argv.join(' ') || '(dashboard)';
      assert.equal(code, EXIT.ok, `${op} must run to completion for its calls to count:\n${stdout.text}`);
      for (const call of runner.calls) processes.push({ op, file: call.file, args: call.args });
      for (const call of fetchImpl.calls) {
        requests.push({ op, method: call.method ?? 'GET', path: new URL(call.url).pathname });
      }
    }
  } finally {
    Session.prototype.token = restored;
  }

  // The writes did happen, so the checks below are about real traffic.
  assert.ok(processes.some((p) => p.file === 'git' && p.args.includes('push')), 'no push was made');
  assert.ok(requests.some((r) => r.method === 'POST'), 'no submit was made');
  // The already-merged submit reads the change back, and that read is a GET.
  assert.deepEqual(requests.filter((r) => r.op === 'submit 200102').map((r) => `${r.method} ${r.path}`),
    ['POST /a/changes/200102/submit', 'GET /a/changes/200102']);
  const posts = processes.filter((p) => p.file === 'ssh' && p.args.includes('review'));
  assert.equal(posts.length, 1, 'the message was posted exactly once');

  // The one command that can vote leaves the process with these words and no
  // others: the text is one quoted element, and the target is change,patchset.
  const [post] = posts;
  assert.equal(post.op, 'message 200101', 'only the message operation may run gerrit review');
  const at = post.args.indexOf('gerrit');
  assert.deepEqual(post.args.slice(at), ['gerrit', 'review', '--message', quoteForGerrit(hostile), '200101,4'],
    `the message argv must be gerrit review --message <one quoted word> <change>,<patchset>. ${WHY}`);
  assert.equal(post.args.indexOf('review'), at + 1, 'review appears once, as the subcommand');
  assert.equal(post.args.lastIndexOf('review'), at + 1, 'review appears once, as the subcommand');

  for (const { op, method, path } of requests) {
    assert.doesNotMatch(path, /\/(?:review|votes|reviewers)(?:\/|$)/,
      `${op} requested ${method} ${path}. ${WHY}`);
    if (method !== 'GET') {
      assert.match(path, /^\/a\/changes\/\d+\/submit$/,
        `${op} made a ${method} to ${path}; the only write over HTTP is submit. ${WHY}`);
    }
  }

  const banned = [
    [(/** @type {string} */ t) => t === 'review', 'the gerrit review command'],
    [(/** @type {string} */ t) => /^--(?:code-review|verified)(?:=|$)/.test(t), 'a review score flag'],
    [(/** @type {string} */ t) => /^--label(?:=|$)/.test(t), 'a --label NAME=VALUE flag'],
    [(/** @type {string} */ t) => /^--submit(?:=|$)/.test(t), 'a --submit flag'],
    [(/** @type {string} */ t) => /^set-(?:reviewers|topic)$/.test(t), 'a gerrit set-* command'],
  ];
  for (const { op, file, args } of processes.filter((p) => p.file === 'git' || p.file === 'ssh')) {
    // The message operation is checked element by element above: its subcommand
    // and its quoted text are exempt here, and every other element is not.
    const posting = op === 'message 200101' && file === 'ssh';
    const scanned = posting
      ? args.filter((arg) => arg !== 'review' && arg !== quoteForGerrit(hostile))
      : args;
    // An ssh command line can arrive as one argv element, so each is split too.
    const tokens = scanned.flatMap((arg) => [arg, ...arg.split(/\s+/)]);
    for (const [isBanned, what] of banned) {
      const hit = tokens.find(/** @type {(t: string) => boolean} */ (isBanned));
      assert.equal(hit, undefined, `${op} ran ${file} with ${what} (${hit}): ${args.join(' ')}. ${WHY}`);
    }
    // ssh's own -o sets a client option; on git it is a push option.
    if (file === 'git') {
      const option = args.find((arg) => arg === '-o' || /^--push-option(?:=|$)/.test(arg));
      assert.equal(option, undefined, `${op} ran git with a push option (${option}): ${args.join(' ')}. ${WHY}`);
    }
    for (const refspec of args.filter((arg) => arg.includes('refs/for/'))) {
      const options = refspec.includes('%') ? refspec.slice(refspec.indexOf('%') + 1).split(',') : [];
      for (const option of options) {
        assert.match(option, /^topic=/,
          `${op} pushed ${refspec}: the only push option allowed is a topic, and ${option} is not one. ${WHY}`);
      }
    }
  }
});
