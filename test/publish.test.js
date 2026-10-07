// SPDX-License-Identifier: Apache-2.0

/**
 * Publication, offline. Every git and ssh call goes to a fake runner that answers
 * the way git and Gerrit do, so the real code path runs -- reading the commits,
 * stamping Change-Ids, rebuilding the branch, building the squash, pushing, and
 * reading the result back -- without a repository or a server anywhere.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { GerritError } from '../src/core/errors.js';
import {
  buildPushArgs,
  footerChangeIds,
  parsePushResult,
  publishChanges,
  pushUrl,
  stampChangeId,
} from '../src/core/publish.js';
import { Session } from '../src/core/session.js';
import { fakeRunner } from './helpers.js';

const URL = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console';
const CONFIG = /** @type {any} */ ({
  host: 'gerrit.example.com',
  port: 29418,
  user: 'ada',
  project: 'acme/apps/widget-console',
});
const BASE = '0'.repeat(40);
const ADA = ['Ada', 'ada@example.com', '1785600000 +0000'];
const GRACE = ['Grace', 'grace@example.com', '1785700000 -0600'];

/**
 * One `git log -z` record in the field order publish.js asks for.
 *
 * @param {{sha: string, parent: string, message: string, tree?: string,
 *          author?: string[], committer?: string[]}} commit
 */
function logRecord({ sha, parent, message, tree = `${sha.slice(0, 1)}`.repeat(40), author = ADA, committer = ADA }) {
  return [sha, tree, parent, ...author, ...committer, message].join('\0') + '\0';
}

/**
 * A `gerrit query` row as the readback sees it.
 *
 * @param {number} number
 * @param {string} id
 * @param {string} revision
 * @param {number} [patchSet]
 */
function changeRowJson(number, id, revision, patchSet = 1) {
  return JSON.stringify({
    project: CONFIG.project,
    branch: 'main',
    topic: 'stack-of-three',
    id,
    number,
    subject: `change ${number}`,
    status: 'NEW',
    currentPatchSet: { number: patchSet, revision, ref: `refs/changes/00/${number}/${patchSet}` },
    submitRecords: [{ status: 'NOT_READY', labels: [{ label: 'Quokka-Review', status: 'NEED' }] }],
  });
}

/**
 * A repository and a server, as git and ssh would report them. `commits` is the
 * log from the base up to HEAD; `rebuilt` is what successive `commit-tree` calls
 * return. Anything a test does not override answers as a healthy repo would.
 *
 * @param {{log: string, head: string, rebuilt?: string[], push?: any, readback?: string[],
 *          routes?: any[]}} repo
 */
function fakeRepo({ log, head, rebuilt = [], push, readback = [], routes = [] }) {
  const queue = [...rebuilt];
  return fakeRunner([
    ...routes,
    {
      match: (f, a) => f === 'git' && a.includes('ls-remote') && a.includes('--symref'),
      result: { stdout: `ref: refs/heads/main\tHEAD\n${BASE}\tHEAD\n` },
    },
    {
      match: (f, a) => f === 'git' && a.includes('ls-remote'),
      result: (_f, a) => ({ stdout: `${BASE}\t${a[a.length - 1]}\n` }),
    },
    { match: (f, a) => f === 'git' && a.includes(`${BASE}^{commit}`), result: { stdout: `${BASE}\n` } },
    { match: (f, a) => f === 'git' && a.includes('HEAD^{commit}'), result: { stdout: `${head}\n` } },
    { match: (f, a) => f === 'git' && a.includes('merge-base'), result: { stdout: `${BASE}\n` } },
    { match: (f, a) => f === 'git' && a.includes('log'), result: { stdout: log } },
    {
      match: (f, a) => f === 'git' && a.includes('commit-tree'),
      result: () => ({ stdout: `${queue.shift()}\n` }),
    },
    { match: (f, a) => f === 'git' && a.includes('update-ref'), result: { code: 0 } },
    {
      match: (f, a) => f === 'git' && a.includes('push'),
      result: push ?? ((_f, a) => ({
        stdout: `To ${URL}\n*\t${a[a.length - 1]}\t[new reference]\nDone\n`,
        stderr: 'remote: Processing changes: done\n',
      })),
    },
    {
      match: (f) => f === 'ssh',
      result: { stdout: `${[...readback, '{"type":"stats","rowCount":0}'].join('\n')}\n` },
    },
  ]);
}

/**
 * @param {ReturnType<typeof fakeRunner>} runner
 * @param {string} sub
 */
function gitCalls(runner, sub) {
  return runner.calls.filter((c) => c.file === 'git' && c.args.includes(sub));
}

test('the Change-Id is read from the footer only, the last paragraph', () => {
  const id = `I${'1'.repeat(40)}`;
  assert.deepEqual(footerChangeIds(`Subject\n\nBody.\n\nChange-Id: ${id}\n`), [id]);
  assert.deepEqual(footerChangeIds(`Subject\n\nChange-Id: ${id}\nSigned-off-by: Ada <ada@example.com>\n`), [id]);
  // A Change-Id in the body is not one Gerrit reads, so neither does this.
  assert.deepEqual(footerChangeIds(`Subject\n\nChange-Id: ${id}\n\nMore body.\n`), []);
  // A lone subject line has no footer at all.
  assert.deepEqual(footerChangeIds(`Change-Id: ${id}\n`), []);
  // A malformed one is reported as it is, so it can be refused rather than doubled.
  assert.deepEqual(footerChangeIds('Subject\n\nChange-Id: not-an-id\n'), ['not-an-id']);
});

test('a stamped Change-Id joins a trailer block, or starts one, and changes nothing else', () => {
  const id = `I${'e'.repeat(40)}`;
  assert.equal(stampChangeId('Subject\n\nBody text.\n', id), `Subject\n\nBody text.\n\nChange-Id: ${id}\n`);
  assert.equal(
    stampChangeId('Subject\n\nBody.\n\nSigned-off-by: Ada <ada@example.com>\n', id),
    `Subject\n\nBody.\n\nSigned-off-by: Ada <ada@example.com>\nChange-Id: ${id}\n`,
  );
  assert.equal(stampChangeId('Subject only\n', id), `Subject only\n\nChange-Id: ${id}\n`);
  assert.throws(() => stampChangeId('Subject\n', 'I-too-short'), GerritError);
});

test('the push is exactly one commit to refs/for/<branch>, with a topic and nothing else', () => {
  const commit = 'c'.repeat(40);
  assert.deepEqual(buildPushArgs(URL, commit, 'main', { topic: 'stack-of-three' }), [
    '-c', 'push.pushOption=',
    'push', '--porcelain', '--no-follow-tags', '--no-recurse-submodules',
    URL, `${commit}:refs/for/main%topic=stack-of-three`,
  ]);
  assert.equal(buildPushArgs(URL, commit, 'release/7.2').at(-1), `${commit}:refs/for/release/7.2`);
});

test('neither a branch nor a topic can smuggle a vote, a submit, or another ref onto the push', () => {
  const commit = 'c'.repeat(40);
  for (const branch of ['main%l=Quokka-Review+2', 'main%submit', 'main:refs/heads/main', '-main',
    'main,l=Quokka-Review+2', 'a/../b', 'main ', '']) {
    assert.throws(() => buildPushArgs(URL, commit, branch), (err) => {
      assert.ok(err instanceof GerritError);
      assert.equal(/** @type {GerritError} */ (err).code, 'BAD_REF_NAME');
      return true;
    }, `branch ${JSON.stringify(branch)} must be refused`);
  }
  for (const topic of ['t,l=Quokka-Review+2', 't%submit', 't,r=grace', 'two words']) {
    assert.throws(() => buildPushArgs(URL, commit, 'main', { topic }), GerritError,
      `topic ${JSON.stringify(topic)} must be refused`);
  }
  assert.throws(() => buildPushArgs(URL, 'HEAD', 'main'), GerritError, 'only a commit id is pushed');
});

test('the push goes to the resolved Gerrit endpoint, and a hostile part is refused', () => {
  assert.equal(pushUrl(CONFIG), URL);
  assert.throws(() => pushUrl({ ...CONFIG, project: null }), (err) => {
    assert.equal(/** @type {GerritError} */ (err).code, 'PROJECT_UNRESOLVED');
    return true;
  });
  for (const hostile of [{ user: '-oProxyCommand=x' }, { host: '-oProxyCommand=x' },
    { user: 'ada@evil' }, { project: '-upload-pack=x' }, { project: 'two words' }]) {
    assert.throws(() => pushUrl({ ...CONFIG, ...hostile }), (err) => {
      assert.equal(/** @type {GerritError} */ (err).code, 'BAD_REMOTE_URL');
      return true;
    }, JSON.stringify(hostile));
  }
});

test('the push result is read from git\'s porcelain, and the server\'s refusal is kept verbatim', () => {
  assert.deepEqual(parsePushResult({
    code: 0,
    stdout: `To ${URL}\n*\tc:refs/for/main\t[new reference]\nDone\n`,
    stderr: 'remote: \nremote: SUCCESS\nremote:   https://gerrit.example.com/c/x/+/200101 one [NEW]   \n',
  }), { newPatchSets: true, messages: ['SUCCESS', 'https://gerrit.example.com/c/x/+/200101 one [NEW]'] });

  // Every commit is already a patch set: the state publishing exists to reach.
  assert.equal(parsePushResult({
    code: 1,
    stdout: `To ${URL}\n!\tc:refs/for/main\t[remote rejected] (no new changes)\nDone\n`,
    stderr: 'error: failed to push some refs\n',
  }).newPatchSets, false);

  assert.throws(() => parsePushResult({
    code: 1,
    stdout: `To ${URL}\n!\tc:refs/for/main\t[remote rejected] (missing Change-Id in message footer)\nDone\n`,
    stderr: 'remote: ERROR: commit c: missing Change-Id in message footer\nerror: failed to push\n',
  }), (err) => {
    const e = /** @type {GerritError} */ (err);
    assert.equal(e.code, 'PUSH_REJECTED');
    assert.equal(e.message, 'Gerrit rejected the push: missing Change-Id in message footer');
    assert.equal(e.remedy, 'ERROR: commit c: missing Change-Id in message footer');
    return true;
  });

  assert.throws(() => parsePushResult({
    code: 128,
    stdout: '',
    stderr: 'ada@gerrit.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n',
  }), (err) => {
    const e = /** @type {GerritError} */ (err);
    assert.equal(e.code, 'PUSH_FAILED');
    assert.match(e.message, /Permission denied \(publickey\)/);
    return true;
  });
});

test('a stack keeps every existing Change-Id verbatim and stamps, and keeps, the missing ones', async () => {
  const [c1, c2, c3] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const [n1, n2, n3] = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
  const kept = `I${'4'.repeat(40)}`;
  const fresh = [`I${'e'.repeat(40)}`, `I${'f'.repeat(40)}`];
  const second = `Give the reader a retry ceiling\n\nChange-Id: ${kept}\n`;
  const runner = fakeRepo({
    head: c3,
    log: logRecord({ sha: c1, parent: BASE, message: 'Split the reader out\n\nBody.\n' })
      + logRecord({ sha: c2, parent: c1, message: second, committer: GRACE })
      + logRecord({ sha: c3, parent: c2, message: 'Wire the ceiling\n' }),
    rebuilt: [n1, n2, n3],
    readback: [changeRowJson(200101, fresh[0], n1), changeRowJson(200102, kept, 'd'.repeat(40), 3)],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });
  const ids = [...fresh];

  const result = await publishChanges(session, {
    shape: 'stack',
    topic: 'stack-of-three',
    newChangeId: () => /** @type {string} */ (ids.shift()),
  });

  // Every rebuilt commit keeps its tree, sits on the rebuilt parent, is pinned
  // unsigned whatever the configuration, and keeps its author and committer to
  // the second.
  const rebuilt = gitCalls(runner, 'commit-tree');
  assert.deepEqual(rebuilt.map((c) => c.args.slice(-5)),
    [['commit-tree', '--no-gpg-sign', 'a'.repeat(40), '-p', BASE],
      ['commit-tree', '--no-gpg-sign', 'b'.repeat(40), '-p', n1],
      ['commit-tree', '--no-gpg-sign', 'c'.repeat(40), '-p', n2]]);
  assert.equal(rebuilt[0].input, `Split the reader out\n\nBody.\n\nChange-Id: ${fresh[0]}\n`);
  assert.equal(rebuilt[1].input, second, 'a message that already had a Change-Id is passed through byte for byte');
  assert.equal(rebuilt[2].input, `Wire the ceiling\n\nChange-Id: ${fresh[1]}\n`);
  assert.equal(rebuilt[1].env?.GIT_COMMITTER_NAME, 'Grace');
  assert.equal(rebuilt[1].env?.GIT_COMMITTER_DATE, '@1785700000 -0600');
  assert.equal(rebuilt[1].env?.GIT_AUTHOR_DATE, '@1785600000 +0000');

  // The branch is moved only if it is still where it was read.
  assert.deepEqual(gitCalls(runner, 'update-ref')[0].args.slice(-3), ['HEAD', n3, c3]);

  const push = gitCalls(runner, 'push');
  assert.equal(push.length, 1);
  assert.equal(push[0].args.at(-1), `${n3}:refs/for/main%topic=stack-of-three`);
  assert.equal(push[0].args.at(-2), URL);

  // The readback names the project and branch, since a cherry-pick shares its
  // original's Change-Id.
  const query = runner.calls.find((c) => c.file === 'ssh')?.args ?? [];
  assert.ok(query.includes(
    `project:acme/apps/widget-console branch:main (change:${fresh[0]} OR change:${kept} OR change:${fresh[1]})`,
  ));

  assert.equal(result.head, n3);
  assert.equal(result.rewrittenFrom, c3);
  assert.equal(result.commit, n3);
  assert.equal(result.newPatchSets, true);
  assert.deepEqual(result.published.map((p) => [p.commit, p.changeId, p.stamped, p.subject]), [
    [n1, fresh[0], true, 'Split the reader out'],
    [n2, kept, false, 'Give the reader a retry ceiling'],
    [n3, fresh[1], true, 'Wire the ceiling'],
  ]);
  assert.deepEqual(result.published.map((p) => [p.change?.number ?? null, p.isCurrentPatchSet]), [
    [200101, true],
    [200102, false],
    [null, null],
  ]);
});

test('a stack whose commits all carry a Change-Id is pushed as it stands, and the branch is untouched', async () => {
  const [c1, c2] = ['a'.repeat(40), 'b'.repeat(40)];
  const runner = fakeRepo({
    head: c2,
    log: logRecord({ sha: c1, parent: BASE, message: `One\n\nChange-Id: I${'1'.repeat(40)}\n` })
      + logRecord({ sha: c2, parent: c1, message: `Two\n\nChange-Id: I${'2'.repeat(40)}\n` }),
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const result = await publishChanges(session, { shape: 'stack', topic: 'pair', branch: 'release/7.2' });

  assert.equal(gitCalls(runner, 'commit-tree').length, 0);
  assert.equal(gitCalls(runner, 'update-ref').length, 0);
  assert.deepEqual(gitCalls(runner, 'ls-remote')[0].args.slice(-2), [URL, 'refs/heads/release/7.2']);
  assert.equal(gitCalls(runner, 'push')[0].args.at(-1), `${c2}:refs/for/release/7.2%topic=pair`);
  assert.equal(result.rewrittenFrom, null);
  assert.equal(result.head, c2);
  assert.deepEqual(result.published.map((p) => p.stamped), [false, false]);
});

test('a stack reports the open changes its topic still holds for commits no longer on HEAD', async () => {
  // A three-commit stack, republished after its middle commit was dropped.
  const [c1, c3] = ['a'.repeat(40), 'c'.repeat(40)];
  const [id1, id2, id3] = ['1', '2', '3'].map((x) => `I${x.repeat(40)}`);
  const runner = fakeRepo({
    head: c3,
    log: logRecord({ sha: c1, parent: BASE, message: `One\n\nChange-Id: ${id1}\n` })
      + logRecord({ sha: c3, parent: c1, message: `Three\n\nChange-Id: ${id3}\n` }),
    routes: [{
      match: (/** @type {string} */ f, /** @type {string[]} */ a) => f === 'ssh'
        && a.includes('project:acme/apps/widget-console branch:main topic:stack-of-three status:open'),
      result: {
        stdout: `${[
          changeRowJson(200101, id1, c1),
          changeRowJson(200102, id2, 'b'.repeat(40), 2),
          changeRowJson(200103, id3, c3),
          '{"type":"stats","rowCount":3}',
        ].join('\n')}\n`,
      },
    }],
    readback: [changeRowJson(200101, id1, c1), changeRowJson(200103, id3, c3)],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const result = await publishChanges(session, { shape: 'stack', topic: 'stack-of-three' });

  assert.deepEqual(result.leftBehind?.map((c) => [c.number, c.id, c.currentPatchSet?.number]), [
    [200102, id2, 2],
  ]);
  assert.equal(result.leftBehindError, null);
  // Reported, never acted on: the one push is the only write.
  assert.equal(gitCalls(runner, 'push').length, 1);
  assert.equal(runner.calls.filter((c) => c.file === 'ssh').length, 2);
});

test('a stack whose topic holds nothing else reports an empty left-behind list, and a squash none', async () => {
  const c1 = 'a'.repeat(40);
  const id = `I${'1'.repeat(40)}`;
  const runner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: ${id}\n` }),
    readback: [changeRowJson(200101, id, c1)],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const stack = await publishChanges(session, { shape: 'stack', topic: 'stack-of-three' });
  assert.deepEqual(stack.leftBehind, [], 'the topic query returned only the change just published');
  assert.equal(stack.leftBehindError, null);

  const squashRunner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: ${id}\n` }),
    readback: [changeRowJson(200101, id, c1)],
  });
  const squash = await publishChanges(new Session({ config: CONFIG, runner: squashRunner, cwd: '/work' }),
    { shape: 'squash' });
  assert.equal(squash.leftBehind, null);
  assert.equal(squash.leftBehindError, null);
  assert.equal(squashRunner.calls.filter((c) => c.file === 'ssh').length, 1, 'a squash has no topic to ask');
});

test('a stack whose topic cannot be asked is still published, with the failure as a warning', async () => {
  const c1 = 'a'.repeat(40);
  const id = `I${'1'.repeat(40)}`;
  const runner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: ${id}\n` }),
    routes: [{
      match: (/** @type {string} */ f, /** @type {string[]} */ a) => f === 'ssh'
        && a.some((word) => word.includes('status:open')),
      result: { code: 255, stderr: 'ssh: connect to host gerrit.example.com port 29418: Connection refused\n' },
    }],
    readback: [changeRowJson(200101, id, c1)],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const result = await publishChanges(session, { shape: 'stack', topic: 'stack-of-three' });

  assert.equal(result.published[0].change?.number, 200101);
  assert.equal(result.leftBehind, null, 'unknown, not empty');
  assert.equal(result.leftBehindError?.code, 'SSH_FAILED');
  assert.match(String(result.leftBehindError?.message), /Connection refused/);
});

test('a squash is HEAD\'s tree on the base, under the oldest message, and only that one needs a Change-Id', async () => {
  const [c1, c2, c3] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const oldest = `Split the reader out\n\nBody.\n\nChange-Id: I${'1'.repeat(40)}\n`;
  const squashed = '5'.repeat(40);
  const runner = fakeRepo({
    head: c3,
    log: logRecord({ sha: c1, parent: BASE, message: oldest })
      + logRecord({ sha: c2, parent: c1, message: 'Address review\n' })
      + logRecord({ sha: c3, parent: c2, message: 'Fix the lint\n', committer: GRACE }),
    rebuilt: [squashed],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const result = await publishChanges(session, { shape: 'squash' });

  // Later commits without a Change-Id are not rewritten: they never become changes.
  assert.equal(gitCalls(runner, 'update-ref').length, 0);
  const built = gitCalls(runner, 'commit-tree');
  assert.equal(built.length, 1);
  assert.deepEqual(built[0].args.slice(-5), ['commit-tree', '--no-gpg-sign', 'c'.repeat(40), '-p', BASE]);
  assert.equal(built[0].input, oldest);
  // Author of the work, committer of its latest state: the same branch always
  // squashes to the same commit.
  assert.equal(built[0].env?.GIT_AUTHOR_NAME, 'Ada');
  assert.equal(built[0].env?.GIT_COMMITTER_NAME, 'Grace');
  assert.equal(built[0].env?.GIT_COMMITTER_DATE, '@1785700000 -0600');

  assert.equal(gitCalls(runner, 'push')[0].args.at(-1), `${squashed}:refs/for/main`);
  assert.deepEqual(result.published.map((p) => [p.commit, p.changeId, p.stamped]),
    [[squashed, `I${'1'.repeat(40)}`, false]]);
  assert.equal(result.head, c3);
});

test('a squash whose oldest commit has no Change-Id stamps it into the branch before squashing', async () => {
  const [c1, c2] = ['a'.repeat(40), 'b'.repeat(40)];
  const [n1, n2, squashed] = ['1'.repeat(40), '2'.repeat(40), '5'.repeat(40)];
  const fresh = `I${'e'.repeat(40)}`;
  const runner = fakeRepo({
    head: c2,
    log: logRecord({ sha: c1, parent: BASE, message: 'Split the reader out\n' })
      + logRecord({ sha: c2, parent: c1, message: 'Address review\n' }),
    rebuilt: [n1, n2, squashed],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const result = await publishChanges(session, { shape: 'squash', newChangeId: () => fresh });

  // Without the write-back, the next publish would generate a different id and
  // create a different change.
  const built = gitCalls(runner, 'commit-tree');
  assert.equal(built[0].input, `Split the reader out\n\nChange-Id: ${fresh}\n`);
  assert.equal(built[1].input, 'Address review\n');
  assert.deepEqual(gitCalls(runner, 'update-ref')[0].args.slice(-3), ['HEAD', n2, c2]);
  assert.equal(built[2].input, `Split the reader out\n\nChange-Id: ${fresh}\n`);
  assert.deepEqual(built[2].args.slice(-2), ['-p', BASE]);
  assert.equal(result.rewrittenFrom, c2);
  assert.deepEqual(result.published.map((p) => [p.commit, p.changeId, p.stamped]), [[squashed, fresh, true]]);
});

test('a squash of one commit pushes that commit as it is', async () => {
  const c1 = 'a'.repeat(40);
  const runner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: I${'1'.repeat(40)}\n` }),
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  await publishChanges(session, { shape: 'squash' });

  assert.equal(gitCalls(runner, 'commit-tree').length, 0);
  assert.equal(gitCalls(runner, 'push')[0].args.at(-1), `${c1}:refs/for/main`);
});

test('a squash with a topic is refused before anything is pushed', async () => {
  const c1 = 'a'.repeat(40);
  const runner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: I${'1'.repeat(40)}\n` }),
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  await assert.rejects(publishChanges(session, { shape: 'squash', topic: 'solo' }), TypeError);

  assert.equal(runner.calls.length, 0);
});

test('a push the server answers with "no new changes" is a publish that is already done', async () => {
  const c1 = 'a'.repeat(40);
  const id = `I${'1'.repeat(40)}`;
  const runner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: ${id}\n` }),
    push: {
      code: 1,
      stdout: `To ${URL}\n!\t${c1}:refs/for/main\t[remote rejected] (no new changes)\nDone\n`,
    },
    readback: [changeRowJson(200101, id, c1, 4)],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  const result = await publishChanges(session, { shape: 'squash' });

  assert.equal(result.newPatchSets, false);
  assert.equal(result.published[0].change?.number, 200101);
  assert.equal(result.published[0].isCurrentPatchSet, true);
});

test('a push the server refuses is an error in the server\'s words, and nothing is read back', async () => {
  const c1 = 'a'.repeat(40);
  const runner = fakeRepo({
    head: c1,
    log: logRecord({ sha: c1, parent: BASE, message: `Only\n\nChange-Id: I${'1'.repeat(40)}\n` }),
    push: {
      code: 1,
      stdout: `To ${URL}\n!\t${c1}:refs/for/main\t[remote rejected] (prohibited by Gerrit: create change not permitted)\nDone\n`,
    },
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/work' });

  await assert.rejects(publishChanges(session, { shape: 'squash' }), (err) => {
    const e = /** @type {GerritError} */ (err);
    assert.equal(e.code, 'PUSH_REJECTED');
    assert.equal(e.message, 'Gerrit rejected the push: prohibited by Gerrit: create change not permitted');
    return true;
  });
  assert.equal(runner.calls.filter((c) => c.file === 'ssh').length, 0);
});

test('what cannot be published is refused before anything is rewritten or pushed', async () => {
  const [c1, c2] = ['a'.repeat(40), 'b'.repeat(40)];
  const cases = [
    {
      code: 'NOTHING_TO_PUBLISH',
      repo: { head: BASE, log: '' },
    },
    {
      code: 'NONLINEAR_HISTORY',
      repo: {
        head: c2,
        log: logRecord({ sha: c1, parent: BASE, message: 'One\n' })
          + logRecord({ sha: c2, parent: `${c1} ${'9'.repeat(40)}`, message: 'Merge\n' }),
      },
    },
    {
      code: 'BAD_CHANGE_ID',
      repo: {
        head: c1,
        log: logRecord({
          sha: c1,
          parent: BASE,
          message: `Two ids\n\nChange-Id: I${'1'.repeat(40)}\nChange-Id: I${'2'.repeat(40)}\n`,
        }),
      },
    },
    {
      code: 'BAD_CHANGE_ID',
      repo: { head: c1, log: logRecord({ sha: c1, parent: BASE, message: 'Bad\n\nChange-Id: 12345\n' }) },
    },
    {
      code: 'BASE_NOT_FETCHED',
      repo: {
        head: c1,
        log: logRecord({ sha: c1, parent: BASE, message: 'One\n' }),
        routes: [{ match: (/** @type {string} */ f, /** @type {string[]} */ a) => f === 'git'
          && a.includes(`${BASE}^{commit}`), result: { code: 1 } }],
      },
    },
    {
      code: 'NO_SUCH_BRANCH',
      repo: {
        head: c1,
        log: logRecord({ sha: c1, parent: BASE, message: 'One\n' }),
        routes: [{ match: (/** @type {string} */ f, /** @type {string[]} */ a) => f === 'git'
          && a.includes('ls-remote'), result: { stdout: '' } }],
      },
    },
    {
      code: 'HEAD_MOVED',
      repo: {
        head: c1,
        log: logRecord({ sha: c1, parent: BASE, message: 'One\n' }),
        rebuilt: ['1'.repeat(40)],
        routes: [{ match: (/** @type {string} */ f, /** @type {string[]} */ a) => f === 'git'
          && a.includes('update-ref'), result: { code: 1, stderr: 'fatal: cannot lock ref' } }],
      },
    },
  ];
  for (const { code, repo } of cases) {
    const runner = fakeRepo(repo);
    const session = new Session({ config: CONFIG, runner, cwd: '/work' });
    await assert.rejects(publishChanges(session, { shape: 'stack', topic: 't' }), (err) => {
      assert.equal(/** @type {GerritError} */ (err).code, code);
      return true;
    }, code);
    assert.equal(gitCalls(runner, 'push').length, 0, `${code}: nothing may be pushed`);
    if (code !== 'HEAD_MOVED') {
      assert.equal(gitCalls(runner, 'update-ref').length, 0, `${code}: the branch is not touched`);
    }
  }
});

test('a directory that is not a repository fails before anything reaches the server', async () => {
  const runner = fakeRepo({
    head: BASE,
    log: '',
    routes: [{
      match: (/** @type {string} */ f, /** @type {string[]} */ a) => f === 'git' && a.includes('HEAD^{commit}'),
      result: { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' },
    }],
  });
  const session = new Session({ config: CONFIG, runner, cwd: '/not-a-repo' });

  await assert.rejects(publishChanges(session, { shape: 'squash' }), (err) => {
    const e = /** @type {GerritError} */ (err);
    assert.equal(e.code, 'GIT_FAILED');
    assert.match(e.message, /not a git repository/);
    return true;
  });
  assert.equal(gitCalls(runner, 'ls-remote').length, 0);
});

test('WIP composes only its fixed push option with the validated topic', () => {
  const sha = 'a'.repeat(40);
  assert.equal(buildPushArgs(URL, sha, 'main').at(-1), `${sha}:refs/for/main`);
  assert.equal(buildPushArgs(URL, sha, 'main', { wip: true }).at(-1), `${sha}:refs/for/main%wip`);
  assert.equal(buildPushArgs(URL, sha, 'main', { topic: 'demo', wip: true }).at(-1), `${sha}:refs/for/main%topic=demo,wip`);
  for (const injected of ['demo,submit', 'demo%l=Review+2', 'demo:refs/heads/main', 'demo,r=user']) {
    assert.throws(() => buildPushArgs(URL, sha, 'main', { topic: injected, wip: true }));
    assert.throws(() => buildPushArgs(URL, sha, injected, { wip: true }));
  }
  assert.equal(buildPushArgs(URL, sha, 'main', { wip: 'submit' }).at(-1), `${sha}:refs/for/main`);
});

test('WIP publication verifies every requested revision, including no-new-changes pushes', async () => {
  const sha = 'a'.repeat(40);
  const id = `I${'1'.repeat(40)}`;
  for (const noNewChanges of [false, true]) {
    for (const state of ['wip', 'active', 'missing', 'stale', 'closed']) {
      const row = JSON.parse(changeRowJson(200101, id, sha));
      row.wip = state !== 'active';
      if (state === 'stale') row.currentPatchSet.revision = 'b'.repeat(40);
      if (state === 'closed') row.status = 'ABANDONED';
      const runner = fakeRepo({
        head: sha,
        log: logRecord({ sha, parent: BASE, message: `Only\n\nChange-Id: ${id}\n` }),
        push: noNewChanges ? { code: 1, stdout: `!\t${sha}:refs/for/main\t[remote rejected] (no new changes)\n` } : undefined,
        readback: state === 'missing' ? [] : [JSON.stringify(row)],
      });
      const session = new Session({ config: CONFIG, runner, cwd: '/work' });
      if (state === 'wip') {
        const result = await publishChanges(session, { shape: 'squash', wip: true });
        assert.equal(result.published[0].change.wip, true);
        assert.equal(result.newPatchSets, !noNewChanges);
      } else {
        await assert.rejects(publishChanges(session, { shape: 'squash', wip: true }), { code: 'WIP_NOT_CONFIRMED' });
      }
      assert.equal(runner.calls.find((c) => c.args.includes('push')).args.at(-1), `${sha}:refs/for/main%wip`);
    }
  }
});
