// SPDX-License-Identifier: Apache-2.0

/**
 * Next-step hints and body truncation in the agent tier.
 *
 * `help[]` follows a list, a write, or anything held back, and nothing else; a
 * body over the preview limit arrives cut, with its total size on the row and
 * `--full` named once. Offline like everything else here: the recorded query
 * fixtures answer ssh, and the REST bodies are built inline where a test needs
 * a comment long enough to cut.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { EXIT, main } from '../src/axi/main.js';
import { BODY_PREVIEW_CHARS, bodyFields } from '../src/axi/records.js';
import { command, invocation, shellWord } from '../src/axi/hints.js';
import { Session } from '../src/core/session.js';
import { captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const STATS = '{"type":"stats","rowCount":0,"runTimeMilliseconds":3,"moreChanges":false}\n';

/**
 * Drive the entry point under `--json` and parse the one document it writes.
 * `ssh` is the fixture, or the text, every query is answered with.
 *
 * @param {string[]} argv
 * @param {{ssh?: string, sshText?: string, fetchRoutes?: any[], stdin?: string,
 *          gitRemote?: string}} [opts]
 */
async function runJson(argv, { ssh = 'query-stack.txt', sshText, fetchRoutes = [], stdin, gitRemote = REMOTE } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: gitRemote } },
    { match: (f) => f === 'ssh', result: { stdout: sshText ?? fixture(ssh) } },
  ]);
  const input = stdin === undefined ? undefined : Object.assign(Readable.from([stdin]), { isTTY: false });
  const code = await main([...argv, '--json'], {
    cwd: '/some/checkout',
    env: ENV,
    stdin: /** @type {any} */ (input),
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner,
    fetchImpl: fakeFetch(fetchRoutes),
  });
  assert.equal(stderr.text, '', 'stderr carries nothing');
  return { code, document: JSON.parse(stdout.text), runner };
}

/** A REST comments body with one inline comment of the given text. */
function commentsBody(text) {
  return `)]}'\n${JSON.stringify({
    'src/Main.java': [{
      patch_set: 1,
      id: 'long0001',
      line: 3,
      updated: '2026-08-03 07:41:02.000000000',
      message: text,
      author: { _account_id: 4202, name: 'Alan', username: 'alan' },
      unresolved: true,
    }],
  })}`;
}

/** Answer every credential lookup with a placeholder for the test's duration. */
function withToken(fn) {
  return async () => {
    const restored = Session.prototype.token;
    Session.prototype.token = async () => ({ token: 'placeholder-not-a-real-token', backend: 'file', location: null });
    try {
      await fn();
    } finally {
      Session.prototype.token = restored;
    }
  };
}

test('a hinted command carries the connection overrides and quotes what a shell would split', () => {
  assert.equal(command(['show', 200101, '--comments'], {}), 'gerrit-axi show 200101 --comments');
  assert.equal(command(['status'], { host: 'review.example.org', port: '2222' }),
    'gerrit-axi status --host review.example.org --port 2222');
  assert.equal(shellWord('owner:self status:open'), "'owner:self status:open'");
  assert.equal(shellWord('<change>...'), '<change>...', 'a placeholder is for the reader, not the shell');
  assert.equal(shellWord('[--bots | --humans]'), '[--bots | --humans]');
  assert.equal(shellWord("it's"), "'it'\\''s'");
  // The invocation is rebuilt from its parsed form; --json is not repeated, the
  // command's own options are, and an edit applies over them.
  const args = {
    positional: ['200101'],
    flags: { '--messages': '3', '--json': true, '--host': 'h.example.com' },
    overrides: { host: 'h.example.com' },
    json: true,
    help: false,
    version: false,
  };
  assert.equal(invocation('show', args, { set: { '--messages': 'all' } }),
    'gerrit-axi show 200101 --messages all --host h.example.com');
  assert.equal(invocation('show', args, { set: { '--full': true } }),
    'gerrit-axi show 200101 --messages 3 --full --host h.example.com');
});

test('a body is cut to its preview by code point, and the row says how much there was', () => {
  const short = bodyFields('Looks right.', false);
  assert.deepEqual(short, { message: 'Looks right.', chars: 12, truncated: false });

  const exact = bodyFields('x'.repeat(BODY_PREVIEW_CHARS), false);
  assert.equal(exact.truncated, false, 'a body of exactly the limit is whole');

  const long = bodyFields(`${'y'.repeat(BODY_PREVIEW_CHARS)}and the rest`, false);
  assert.equal(long.message, 'y'.repeat(BODY_PREVIEW_CHARS));
  assert.deepEqual([long.chars, long.truncated], [BODY_PREVIEW_CHARS + 12, true]);

  const astral = bodyFields(`${'\u{1F600}'.repeat(BODY_PREVIEW_CHARS)}z`, false);
  assert.equal([...astral.message].length, BODY_PREVIEW_CHARS, 'counted in characters, not UTF-16 units');
  assert.equal(astral.message.endsWith('\u{1F600}'), true, 'never split through a surrogate pair');
  assert.deepEqual([astral.chars, astral.truncated], [BODY_PREVIEW_CHARS + 1, true]);

  const full = bodyFields(`${'y'.repeat(BODY_PREVIEW_CHARS)}and the rest`, true);
  assert.deepEqual([full.message.length, full.chars, full.truncated], [BODY_PREVIEW_CHARS + 12, BODY_PREVIEW_CHARS + 12, false]);
});

test('status follows a list with the detail view, and names submit only for what the server marks ready', async () => {
  // 184431 is the one change the server's submit records mark OK.
  const { code, document } = await runJson(['status'], { ssh: 'query-output.txt' });
  assert.equal(code, EXIT.ok);
  assert.equal(document.more, false);
  assert.deepEqual(document.help, [
    'Run `gerrit-axi show <change>... --comments` for the full review state of a listed change',
    'Run `gerrit-axi submit <change>` for a change the server marks submittable: 184431',
  ]);

  // Named changes are hinted concretely, and one the server did not return is
  // pointed at `show`, whose `missing` says so.
  const named = await runJson(['status', '200101', '200102', '200103', '999999'], { ssh: 'query-stack.txt' });
  assert.equal(named.document.count, 3);
  assert.deepEqual(named.document.help, [
    'Run `gerrit-axi show 200101 200102 200103 999999 --comments` for the full review state',
    'Run `gerrit-axi submit <change>` for a change the server marks submittable: 200101',
    'Run `gerrit-axi show 200101 200102 200103 999999`; a number the server did not return is listed under missing',
  ]);

  // Nothing in a raw query's result is submittable here, so no submit line.
  const raw = await runJson(['status', '--query', 'topic:stack-of-three'], { ssh: 'query-detail.txt' });
  assert.deepEqual(raw.document.help,
    ['Run `gerrit-axi show <change>... --comments` for the full review state of a listed change']);
});

test('an empty status says where else to look, except for a raw query, whose answer is the zero', async () => {
  const attention = await runJson(['status'], { sshText: STATS });
  assert.deepEqual(attention.document.help, [
    'Run `gerrit-axi status mine` for your open changes',
    'Run `gerrit-axi` for your whole dashboard',
  ]);

  const mine = await runJson(['status', 'mine'], { sshText: STATS });
  assert.deepEqual(mine.document.help, [
    'Run `gerrit-axi publish --stack --topic <t>` or `gerrit-axi publish --squash` to propose the commits on HEAD',
  ]);

  const raw = await runJson(['status', '--query', 'topic:nothing'], { sshText: STATS });
  assert.equal(raw.document.count, 0);
  assert.equal('help' in raw.document, false, 'help is absent, not empty');
});

test('a page the server cut short is revealed, with the limit raised, and the hint keeps the query', async () => {
  const { document } = await runJson(['status', '--query', 'cc:self status:open', '--limit', '1'], {
    ssh: 'query-more.txt',
  });
  assert.equal(document.more, true);
  assert.equal(document.help.at(-1),
    "Run `gerrit-axi status --query 'cc:self status:open' --limit 10` for more changes (1+ matched, 1 shown)");
});

test('every hint carries the connection overrides of the call it follows', async () => {
  const status = await runJson(['status', 'mine', '--host', 'review.example.org', '--port', '2222'], {
    ssh: 'query-stack.txt',
  });
  for (const line of status.document.help) {
    assert.match(line, /--host review\.example\.org --port 2222`/, line);
  }
  const empty = await runJson(['status', 'mine', '--host', 'review.example.org'], { sshText: STATS });
  assert.equal(empty.document.help[0],
    'Run `gerrit-axi publish --stack --topic <t> --host review.example.org` or `gerrit-axi publish --squash --host review.example.org` to propose the commits on HEAD');

  // The dashboard, which had the hints first, carries them too now.
  const stdout = captureStream();
  const code = await main(['--host', 'review.example.org'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: fixture('query-stack.txt') } },
    ]),
    fetchImpl: fakeFetch([]),
  });
  assert.equal(code, EXIT.ok);
  assert.match(stdout.text,
    /^help\[1\]: Run `gerrit-axi show 200103 200102 200101 --comments --host review\.example\.org` for the full state of what awaits you$/m);
});

test('show is self-contained: no help unless something was held back', async () => {
  const plain = await runJson(['show', '200101', '200102']);
  assert.equal(plain.code, EXIT.ok);
  assert.equal('help' in plain.document, false);
  assert.equal(plain.document.changes[0].submittable, true,
    'a submittable change in a detail view is still not hinted: the caller reading it knows');

  // Every message shown: nothing to reveal.
  const all = await runJson(['show', '200102', '--messages', 'all']);
  assert.equal('help' in all.document, false);
  assert.equal(all.document.messages.length, 3);
  assert.deepEqual(all.document.messages.map((m) => m.truncated), [false, false, false]);
  assert.equal(typeof all.document.messages[0].chars, 'number');

  // A list capped by --messages is a truncated list, and is always revealed,
  // as the same call with --messages all.
  const capped = await runJson(['show', '200102', '200103', '--messages', '1']);
  assert.deepEqual(capped.document.help, [
    'Run `gerrit-axi show 200102 200103 --messages all` for every cover message (1 of 3 shown on 200102)',
  ]);
});

test('a comment body over the limit arrives cut, sized, and with --full named once', withToken(async () => {
  const long = `${'The managed value is read before the provider is bound. '.repeat(40)}END`;
  const routes = [{ path: /\/changes\/200103\/comments$/, body: commentsBody(long) }];

  const cut = await runJson(['comments', '200103'], { fetchRoutes: routes });
  assert.equal(cut.code, EXIT.ok);
  const [row] = cut.document.comments;
  assert.equal(row.truncated, true);
  assert.equal(row.chars, long.length);
  assert.equal(row.message, long.slice(0, BODY_PREVIEW_CHARS), 'the preview is the body\'s own first characters, no marker');
  assert.deepEqual(cut.document.help, [
    'Run `gerrit-axi show 200103 --messages all` for the cover messages and where each change stands',
    `Run \`gerrit-axi comments 200103 --full\` for the full text of 1 truncated body (longest ${long.length} chars)`,
  ]);

  const full = await runJson(['comments', '200103', '--full'], { fetchRoutes: routes });
  assert.deepEqual([full.document.comments[0].message, full.document.comments[0].truncated, full.document.comments[0].chars],
    [long, false, long.length]);
  assert.deepEqual(full.document.help,
    ['Run `gerrit-axi show 200103 --messages all` for the cover messages and where each change stands'],
    '--full is not suggested when nothing was cut');

  // The same table under show, where the hint is the show call plus --full.
  const shown = await runJson(['show', '200103', '--comments'], { fetchRoutes: routes });
  assert.equal(shown.document.comments[0].truncated, true);
  assert.deepEqual(shown.document.help, [
    `Run \`gerrit-axi show 200103 --comments --full\` for the full text of 1 truncated body (longest ${long.length} chars)`,
  ]);
  const shownFull = await runJson(['show', '200103', '--comments', '--full'], { fetchRoutes: routes });
  assert.equal(shownFull.document.comments[0].truncated, false);
  assert.equal('help' in shownFull.document, false);
}));

test('a short comment body is whole and carries its size, in TOON and JSON alike', withToken(async () => {
  const routes = [{ path: /\/changes\/200103\/comments$/, body: fixture('comments-stack.txt') }];
  const { document } = await runJson(['comments', '200103'], { fetchRoutes: routes });
  assert.deepEqual(document.comments.map((c) => [c.truncated, c.chars]),
    [[false, 36], [false, 63], [false, 47]]);

  const stdout = captureStream();
  await main(['comments', '200103'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner: fakeRunner([{ match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } }]),
    fetchImpl: fakeFetch(routes),
  });
  assert.match(stdout.text, /^comments\[3\]\{change,file,line,patch_set,author,bot,bot_kind,unresolved,severity,id,in_reply_to,updated,message,chars,truncated\}:$/m);
  assert.match(stdout.text, /,36,false$/m);
  assert.match(stdout.text, /^help\[1\]: Run `gerrit-axi show 200103 --messages all` for the cover messages and where each change stands$/m);
}));

test('--full without anything it applies to is refused before any call', async () => {
  const { code, document, runner } = await runJson(['show', '200101', '--full']);
  assert.equal(code, EXIT.usage);
  assert.equal(document.code, 'BAD_USAGE');
  assert.equal(document.error, '--full needs --messages or --comments; it lifts the cut on their bodies');
  assert.equal('help' in document, false, 'the error text is the fix');
  assert.equal(runner.calls.filter((c) => c.file === 'ssh').length, 0);
});

test('an empty comment list points at the cover messages, or at the filter that emptied it', withToken(async () => {
  const none = [{ path: /\/changes\/200102\/comments$/, body: `)]}'\n{}` }];
  const empty = await runJson(['comments', '200102'], { fetchRoutes: none });
  assert.equal(empty.document.count, 0);
  assert.deepEqual(empty.document.help, [
    'Run `gerrit-axi show 200102 --messages all` for the cover messages; a review written there carries no inline comment',
  ]);

  const bots = [{ path: /\/changes\/200103\/comments$/, body: fixture('comments-stack.txt') }];
  const filtered = await runJson(['comments', '200103', '--humans', '--bots'], { fetchRoutes: bots }).catch(() => null);
  assert.equal(filtered?.document.code, 'BAD_USAGE');
  const humansOnly = await runJson(['comments', '200102', '--humans'], { fetchRoutes: none });
  assert.deepEqual(humansOnly.document.help,
    ['Run `gerrit-axi comments 200102` for the comments the filter excluded']);
}));

test('submit: a merge, or one already made, is a confirmation with no hint; anything else, and a refusal, point at show', withToken(async () => {
  const info = (status) => `)]}'\n${JSON.stringify({ _number: 200101, status, project: 'acme/apps/widget-console' })}`;
  const merged = await runJson(['submit', '200101'], {
    fetchRoutes: [{ path: '/a/changes/200101/submit', body: info('MERGED') }],
  });
  assert.equal(merged.code, EXIT.ok);
  assert.equal('help' in merged.document, false);

  const pending = await runJson(['submit', '200101'], {
    fetchRoutes: [{ path: '/a/changes/200101/submit', body: info('SUBMITTED') }],
  });
  assert.deepEqual(pending.document.help, ['Run `gerrit-axi show 200101` to see whether it has merged']);

  // A change that had already merged is the same confirmation: nothing to do next.
  const again = await runJson(['submit', '200101'], {
    fetchRoutes: [
      { path: '/a/changes/200101/submit', status: 409, body: 'change is merged' },
      { path: '/a/changes/200101', body: info('MERGED') },
    ],
  });
  assert.equal(again.code, EXIT.ok);
  assert.equal(again.document.already_merged, true);
  assert.equal('help' in again.document, false);

  const refused = await runJson(['submit', '200102', '--host', 'review.example.org'], {
    fetchRoutes: [
      { path: '/a/changes/200102/submit', status: 409, body: 'submit requirement unsatisfied' },
      { path: '/a/changes/200102', body: `)]}'\n${JSON.stringify({ _number: 200102, status: 'NEW' })}` },
    ],
  });
  assert.equal(refused.code, EXIT.transport);
  assert.equal(refused.document.code, 'SUBMIT_REFUSED');
  assert.deepEqual(refused.document.help,
    ['Run `gerrit-axi show 200102 --host review.example.org` for the labels blocking it (blocked_on)']);
  assert.equal(/submit \d/.test(refused.document.help.join('\n')), false, 'a refused submit is never re-suggested');
}));

test('message follows the post with the conversation it joined', async () => {
  const { code, document } = await runJson(['message', '200101'], { stdin: 'What changed.\n' });
  assert.equal(code, EXIT.ok, JSON.stringify(document));
  assert.deepEqual(document.help,
    ['Run `gerrit-axi show 200101 --messages all` for the conversation including this message']);

  const tty = captureStream();
  const code2 = await main(['message', '200101', '--json'], {
    cwd: '/some/checkout',
    env: ENV,
    stdin: /** @type {any} */ ({ isTTY: true }),
    stdout: tty.stream,
    stderr: captureStream().stream,
    runner: fakeRunner([{ match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } }]),
    fetchImpl: fakeFetch([]),
  });
  assert.equal(code2, EXIT.usage);
  assert.deepEqual(JSON.parse(tty.text).help,
    ['Run `gerrit-axi message <change> --file <path>`, or pipe the text on stdin']);
});

test('a usage error names the corrected call; an unknown option already has its remedy and gets none', async () => {
  const cases = [
    [['show'], ['Run `gerrit-axi show <change>... [--messages <n|all>] [--comments]`']],
    [['comments'], ['Run `gerrit-axi comments <change>... [--bots | --humans]`']],
    [['submit'], ['Run `gerrit-axi submit <change>`']],
    [['publish'], ['Run `gerrit-axi publish --stack --topic <t>` or `gerrit-axi publish --squash` to propose the commits on HEAD']],
    [['publish', '--stack'], ['Run `gerrit-axi publish --stack --topic <t>` or `gerrit-axi publish --squash` to propose the commits on HEAD']],
    [['status', '200101', '--query', 'x'], ['Run `gerrit-axi status --query <query>`']],
  ];
  for (const [argv, help] of cases) {
    const { code, document } = await runJson(argv);
    assert.equal(code, EXIT.usage, argv.join(' '));
    assert.deepEqual(document.help, help, argv.join(' '));
  }
  const unknown = await runJson(['show', '200101', '--comment']);
  assert.match(unknown.document.remedy, /^Did you mean --comments\?/);
  assert.equal('help' in unknown.document, false);

  // An unknown command lists the commands: the fix is one of them.
  const nope = await runJson(['nope']);
  assert.equal(nope.document.code, 'BAD_USAGE');
  assert.equal(nope.document.help.length, 1);
  assert.match(nope.document.help[0], /^Run one of: `gerrit-axi`, `gerrit-axi status`, `gerrit-axi show <change>\.\.\.`, /);
  assert.match(nope.document.help[0], /`gerrit-axi message <change>`, `gerrit-axi watch <change>\.\.\.`, `gerrit-axi setup hooks`$/);
  assert.equal(nope.document.help[0].includes('--help'), false);
});

test('a failure the caller can fix with a flag gets that call, carrying its own argv', async () => {
  // No remote, no env: the host cannot be resolved, and the hint is this very
  // call with --host added.
  const unresolved = await runJson(['status', 'mine'], { gitRemote: '' });
  assert.equal(unresolved.code, EXIT.config);
  assert.equal(unresolved.document.code, 'HOST_UNRESOLVED');
  assert.match(unresolved.document.remedy, /--host <host>/, 'core\'s remedy stays');
  assert.deepEqual(unresolved.document.help, ['Run `gerrit-axi status mine --host <host>`']);

  const bare = await runJson([], { gitRemote: '' });
  assert.deepEqual(bare.document.help, ['Run `gerrit-axi --host <host>`']);
});

test('a rejected query is answered with a corrected one only when the caller wrote the query', async () => {
  const rejected = '{"type":"error","message":"Unsupported operator: nosuchoperator:x"}\n';
  const raw = await runJson(['status', '--query', 'nosuchoperator:x'], { sshText: rejected });
  assert.equal(raw.document.code, 'GERRIT_ERROR');
  assert.deepEqual(raw.document.help, [
    'Run `gerrit-axi status --query <query>` with a query Gerrit accepts; spell negation NOT, never a leading -',
  ]);

  // A bare status builds its own query; the caller has nothing to rewrite.
  const bare = await runJson(['status'], { sshText: rejected });
  assert.equal(bare.document.code, 'GERRIT_ERROR');
  assert.equal('help' in bare.document, false);
});

test('a 404 and a refused message point at show, which tells gone from failed', withToken(async () => {
  const missing = await runJson(['comments', '200103', '--rest-base', 'https://review.example.org'], {
    fetchRoutes: [{ path: /comments$/, status: 404, body: 'Not found' }],
  });
  assert.equal(missing.document.code, 'NOT_FOUND');
  assert.deepEqual(missing.document.help, [
    'Run `gerrit-axi show 200103 --rest-base https://review.example.org`; a number the server does not return is listed under missing',
  ]);

  const redirected = await runJson(['comments', '200103'], {
    fetchRoutes: [{ path: /comments$/, status: 302, body: '' }],
  });
  assert.equal(redirected.document.code, 'HTTP_ERROR');
  assert.deepEqual(redirected.document.help, ['Run `gerrit-axi comments 200103 --rest-base https://<host>`']);

  // A failure nothing in this tool fixes carries its remedy and no help.
  const forbidden = await runJson(['comments', '200103'], {
    fetchRoutes: [{ path: /comments$/, status: 403, body: 'Forbidden' }],
  });
  assert.equal(forbidden.document.code, 'FORBIDDEN');
  assert.equal('help' in forbidden.document, false);
}));

test('auth status without a working credential names the login, and nothing else', async () => {
  const { code, document } = await runJson(['auth', 'status']);
  assert.equal(code, EXIT.ok);
  assert.equal(document.stored, false);
  assert.deepEqual(document.help,
    ['Run `gerrit auth login` to store a token that works, then `gerrit-axi auth status` to confirm']);
});

const BASE = '0'.repeat(40);

/**
 * A repository and a server for a publish through the entry point, as git and
 * ssh would report them: one commit on HEAD carrying its Change-Id, the push
 * answered as `push` says, the readback answered from the recorded stack, and a
 * stack's query for its topic's open changes answered from `topic`.
 *
 * @param {{push?: any, readback?: string, topic?: string}} [opts]
 */
function publishRunner({ push, readback = 'query-stack.txt', topic = 'query-empty.txt' } = {}) {
  const c1 = 'a'.repeat(40);
  const record = [c1, c1, BASE, 'Ada', 'ada@example.com', '1785600000 +0000', 'Ada', 'ada@example.com',
    '1785600000 +0000', `Split the queue reader out of the daemon\n\nChange-Id: I${c1}\n`].join('\0') + '\0';
  return fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    {
      match: (f, a) => f === 'git' && a.includes('ls-remote'),
      result: { stdout: `ref: refs/heads/main\tHEAD\n${BASE}\tHEAD\n` },
    },
    { match: (f, a) => f === 'git' && a.includes(`${BASE}^{commit}`), result: { stdout: BASE } },
    { match: (f, a) => f === 'git' && a.includes('HEAD^{commit}'), result: { stdout: c1 } },
    { match: (f, a) => f === 'git' && a.includes('merge-base'), result: { stdout: BASE } },
    { match: (f, a) => f === 'git' && a.includes('log'), result: { stdout: record } },
    {
      match: (f, a) => f === 'git' && a.includes('push'),
      result: push ?? ((_f, a) => ({ stdout: `To x\n*\t${a.at(-1)}\t[new reference]\nDone\n` })),
    },
    {
      match: (f, a) => f === 'ssh' && String(a.at(-2)).includes('status:open'),
      result: { stdout: fixture(topic) },
    },
    { match: (f) => f === 'ssh', result: { stdout: fixture(readback) } },
  ]);
}

/**
 * @param {string[]} argv
 * @param {ReturnType<typeof fakeRunner>} runner
 */
async function publishJson(argv, runner) {
  const stdout = captureStream();
  const code = await main([...argv, '--json'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner,
    fetchImpl: fakeFetch([]),
  });
  return { code, document: JSON.parse(stdout.text) };
}

test('publish follows the push with the changes to watch, and a stack with its topic query', async () => {
  // The readback is the recorded stack, so three changes come back for one
  // commit; the hint names what the server now holds, and the one change the
  // server marks submittable.
  const { code, document } = await publishJson(['publish', '--stack', '--topic', 'stack-of-three'], publishRunner());
  assert.equal(code, EXIT.ok, JSON.stringify(document));
  assert.equal(document.new_patch_sets, true);
  assert.deepEqual(document.help, [
    'Run `gerrit-axi show 200101 --comments` to follow the review',
    "Run `gerrit-axi status --query topic:stack-of-three` for the stack as the server lists it",
    'Run `gerrit-axi submit <change>` for a change the server marks submittable: 200101',
  ]);
});

test('a stack publish that left open changes in its topic names them, and never abandons one', async () => {
  // HEAD carries only 200101's commit; the topic still holds 200102 and 200103.
  const runner = publishRunner({ topic: 'query-stack.txt' });
  const { code, document } = await publishJson(
    ['publish', '--stack', '--topic', 'stack-of-three', '--host', 'review.example.org'], runner);
  assert.equal(code, EXIT.ok, JSON.stringify(document));
  assert.deepEqual(document.help, [
    'Run `gerrit-axi show 200101 --comments --host review.example.org` to follow the review',
    'Run `gerrit-axi status --query topic:stack-of-three --host review.example.org`'
      + ' for the stack as the server lists it',
    'Run `gerrit-axi show 200102 200103 --host review.example.org` for the open changes in topic'
      + ' stack-of-three whose commits are no longer on HEAD (left_behind); abandon each one dropped'
      + ' on purpose, since a server that submits topics whole would merge it too',
    'Run `gerrit-axi submit <change> --host review.example.org` for a change the server marks submittable: 200101',
  ]);
  // One push, and every other call to the server a read.
  assert.equal(runner.calls.filter((c) => c.file === 'git' && c.args.includes('push')).length, 1);
  for (const call of runner.calls.filter((c) => c.file === 'ssh')) {
    assert.ok(call.args.includes('query'), `only queries reach the server: ${call.args.join(' ')}`);
  }
});

test('a squash that made a patch set is followed by the message that says what it changed', async () => {
  const fresh = await publishJson(['publish', '--squash', '--host', 'review.example.org'], publishRunner());
  assert.equal(fresh.code, EXIT.ok, JSON.stringify(fresh.document));
  assert.deepEqual(fresh.document.help, [
    'Run `gerrit-axi show 200101 --comments --host review.example.org` to follow the review',
    'Run `gerrit-axi message 200101 --file <path> --host review.example.org` to say what this patch set changed,'
      + " since the squash carries the oldest commit's message",
    'Run `gerrit-axi submit <change> --host review.example.org` for a change the server marks submittable: 200101',
  ]);

  // The server already held the commit: nothing new to describe, so no message
  // line, and the state is still worth following.
  const same = await publishJson(['publish', '--squash'], publishRunner({
    push: {
      code: 1,
      stdout: `To x\n!\t${'a'.repeat(40)}:refs/for/main\t[remote rejected] (no new changes)\nDone\n`,
    },
  }));
  assert.equal(same.code, EXIT.ok, JSON.stringify(same.document));
  assert.equal(same.document.new_patch_sets, false);
  assert.deepEqual(same.document.help, [
    'Run `gerrit-axi show 200101 --comments` to follow the review',
    'Run `gerrit-axi submit <change>` for a change the server marks submittable: 200101',
  ]);
});
