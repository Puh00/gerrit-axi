// SPDX-License-Identifier: Apache-2.0

/**
 * Guards on the two architectural rules, and on the vote ban. These are the tests
 * that fail if a later change quietly dissolves the layering or opens a path to a
 * vote, which is the failure mode worth catching mechanically rather than in
 * review.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SRC_DIR } from './helpers.js';

const REPO_ROOT = path.join(SRC_DIR, '..');

/**
 * @param {string} dir
 * @returns {string[]}
 */
function jsFilesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const coreFiles = jsFilesUnder(path.join(SRC_DIR, 'core'));

test('src/core does not print anything', () => {
  // Rule 1: the moment core knows what a table looks like, the layering is gone.
  assert.ok(coreFiles.length >= 8, 'expected core to have modules to check');
  for (const file of coreFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/\bconsole\s*\./.test(code), false, `${path.basename(file)} must not use console`);
    assert.equal(/process\.stdout\b/.test(code), false, `${path.basename(file)} must not write to stdout`);
    assert.equal(/process\.stderr\b/.test(code), false, `${path.basename(file)} must not write to stderr`);
  }
});

test('src/core does not import anything from src/cli', () => {
  for (const file of coreFiles) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/from\s+['"][^'"]*\/cli\//.test(text), false,
      `${path.basename(file)} must not depend on the presentation layer`);
  }
});

test('src/core contains no rendering vocabulary', () => {
  // A weak proxy, but it catches the obvious regressions: colour codes and
  // column padding leaking into the data layer.
  for (const file of coreFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/\\u001b\[/.test(code), false, `${path.basename(file)} must not emit ANSI escapes`);
    assert.equal(/\bpadEnd\b|\bpadStart\b/.test(code), false,
      `${path.basename(file)} must not pad columns`);
  }
});

test('there is no hardcoded hostname anywhere in the codebase', () => {
  // Tier 2's central promise. `example.com` and friends are RFC 2606 reserved
  // documentation names and are allowed in usage text.
  const allowedHosts = /^(?:[a-z0-9-]+\.)?example\.(?:com|org|net)$/;
  const hostLike = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|internal|local|corp|lan|intranet)\b/gi;

  const files = [
    ...jsFilesUnder(SRC_DIR),
    path.join(REPO_ROOT, 'bin', 'gerrit.js'),
  ];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const match of code.match(hostLike) ?? []) {
      assert.ok(
        allowedHosts.test(match.toLowerCase()),
        `${path.relative(REPO_ROOT, file)} contains a hostname literal: ${match}`,
      );
    }
  }
});

test('no hardcoded project-path prefix', () => {
  // Path shortening is derived from the result set. A constant listing one
  // server's top-level project directories -- `/^(one|two)\//` and friends --
  // is wrong on every other server, so it must not appear.
  const prefixLiteral = /\^?\(\s*[a-z0-9][a-z0-9._-]*\s*(?:\|\s*[a-z0-9][a-z0-9._-]*\s*)+\)\s*\\?\//;
  const files = [...jsFilesUnder(SRC_DIR), path.join(REPO_ROOT, 'bin', 'gerrit.js')];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(prefixLiteral.test(code), false,
      `${path.relative(REPO_ROOT, file)} must not hardcode a project-path prefix`);
  }
});

test('src/axi imports core, and never the presentation layer', () => {
  // Rule 2, now that the second binary exists. The agent tier is a sibling of
  // src/cli/, not a wrapper around it: the moment it imports a renderer it has
  // started depending on the human CLI's layout, which is the coupling this
  // whole design exists to avoid.
  const axiFiles = jsFilesUnder(path.join(SRC_DIR, 'axi'));
  assert.ok(axiFiles.length >= 4, 'expected the agent tier to have modules to check');
  let importsCore = false;
  for (const file of axiFiles) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/from\s+['"][^'"]*\/cli\//.test(text), false,
      `${path.basename(file)} must not import the presentation layer`);
    for (const match of text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      assert.match(match[1], /^\.\.\/core\/|^\.\//,
        `${path.basename(file)} may only import src/core and its own siblings`);
      if (match[1].startsWith('../core/')) importsCore = true;
    }
  }
  assert.ok(importsCore, 'the agent tier exists in order to import the core library');
});

test('src/axi re-derives nothing core already decides', () => {
  // Readiness comes from the server's submit records via core's deriveReadiness,
  // and no label is ever recognised by name. A tier that recomputed either would
  // be a second oracle, wrong in its own way.
  const forbidden = [/\bVerified\b/, /\bCode-Review\b/, /\bAI-review\b/i, /submitRecords/,
    /BLOCKING_LABEL_STATUSES/];
  for (const file of jsFilesUnder(path.join(SRC_DIR, 'axi'))) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of forbidden) {
      assert.equal(pattern.test(code), false,
        `${path.basename(file)} must not re-derive readiness: ${pattern}`);
    }
  }
});

test('both binaries exist and each is a thin shell over its own tier', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { gerrit: 'bin/gerrit.js', 'gerrit-axi': 'bin/gerrit-axi.js' });
  for (const [bin, tier] of [['gerrit.js', 'cli'], ['gerrit-axi.js', 'axi']]) {
    const file = path.join(REPO_ROOT, 'bin', bin);
    assert.ok(existsSync(file), `bin/${bin} should exist`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, new RegExp(`(?:from |import\\()'\\.\\./src/${tier}/main\\.js'`));
  }
});

test('a request for machine-readable output does not become a flag on the human CLI', () => {
  // The rule that keeps the two tiers apart. `--json` belongs to gerrit-axi;
  // adding it to `gerrit` would put a second output contract inside the renderer.
  for (const file of jsFilesUnder(path.join(SRC_DIR, 'cli'))) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/--json/.test(code), false,
      `${path.basename(file)} must not grow a --json flag; that is what src/axi is for`);
  }
});

test('the package has no runtime dependencies and does not depend on axi-sdk-js', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
  assert.equal(JSON.stringify(pkg).includes('axi-sdk-js'), false);
});

test('the core entry point exposes the library API a second binary would import', async () => {
  const core = await import('../src/core/index.js');
  for (const name of [
    'createSession',
    'Session',
    'resolveConfig',
    'queryChanges',
    'listComments',
    'deriveReadiness',
    'authStatus',
    'loginWithToken',
    'logout',
    'publishChanges',
    'submitChange',
    'postChangeMessage',
    'GerritError',
  ]) {
    assert.equal(typeof core[name] !== 'undefined', true, `core must export ${name}`);
  }
  // ...and nothing that renders.
  for (const name of ['table', 'makeColorizer', 'runStatus', 'main']) {
    assert.equal(name in core, false, `core must not export the presentation helper ${name}`);
  }
});

/** Only these modules may spell the command that can vote. */
const REVIEW_MODULES = [path.join(SRC_DIR, 'core', 'message.js'), path.join(SRC_DIR, 'core', 'ready.js')];

test('voting is structurally impossible: no voting command or voting path exists anywhere', () => {
  // THE PROPERTY THIS TEST HOLDS. gerrit-axi publishes and submits, and it cannot
  // vote. Submitting cannot get round the votes: the server evaluates its own
  // submit rules and refuses a change they do not support. Voting is what would
  // get round them. A tool that can record an approval lets an agent manufacture
  // one and then submit legitimately against it, and that vote reads -- to
  // colleagues and to any audit of the repository -- as a named person having
  // approved. The durable control is the account's label permissions on the
  // server; this test keeps the tool's own path from ever being what tests them.
  //
  // So this is a ban, not a review note: a later change that adds a way to vote
  // fails here, whatever it was meant for. It is a universal claim -- no path
  // anywhere names a voting command -- which only a scan of the whole codebase
  // can state, so it reads source text on purpose.
  //
  // test/vote-ban.test.js is its runtime complement, not a duplicate: it drives
  // every agent-tier operation and checks what actually leaves the process,
  // which catches a value assembled at runtime that no grep can see, but only on
  // the paths it drives. This test covers the whole source, which no test that
  // runs code can. Each catches failures the other misses; delete neither.
  const WHY = 'gerrit-axi must be structurally unable to vote: a tool that can record an '
    + 'approval lets an agent manufacture one and submit against it, and the vote reads '
    + 'as a person having approved. No voting command or voting path may appear anywhere '
    + 'in the code. This source scan and the runtime check in test/vote-ban.test.js catch '
    + 'different failures -- this one covers the whole source, that one sees values '
    + 'assembled at runtime -- and neither is redundant.';
  const files = [
    ...jsFilesUnder(SRC_DIR),
    path.join(REPO_ROOT, 'bin', 'gerrit.js'),
    path.join(REPO_ROOT, 'bin', 'gerrit-axi.js'),
  ];
  const code = new Map(files.map((file) => [file, stripComments(readFileSync(file, 'utf8'))]));
  const rel = (/** @type {string} */ file) => path.relative(REPO_ROOT, file);

  // No voting vocabulary, in any spelling a caller could reach. Only the
  // message and ready modules may spell the review command. Their runtime
  // tests pin the argv and stdin payload; scoring patterns remain banned.
  // Help may name the command in prose, but cannot spell review as an argv element.
  const votingPaths = [
    [/\bgerrit\b[\s'"`,]*\breview\b/, 'the gerrit review SSH command, as a string or as argv',
      [...REVIEW_MODULES, path.join(SRC_DIR, 'axi', 'help.js')]],
    [/['"`]review['"`\s]/, 'review as an argv element', REVIEW_MODULES],
    [/--(?:code-review|verified)\b|--label[\s'"`,=]+['"`]?(?:\$\{|[A-Za-z0-9-]+=)/,
      'a gerrit review scoring flag (--label NAME=VALUE; secret-tool\'s --label=<text> is not one)'],
    [/\/review/, 'a REST path to the review endpoint, where votes are recorded'],
    [/\/votes\b/, 'a REST path to the votes endpoint, where votes are deleted'],
    [/[%,](?:l|label)=/, 'a label option on a push, which votes as the push lands'],
    [/set-reviewers/, 'gerrit set-reviewers'],
    [/set-topic/, 'gerrit set-topic (a topic is set on the push instead)'],
  ];
  for (const [file, text] of code) {
    for (const [pattern, what, exempt] of votingPaths) {
      if (Array.isArray(exempt) && exempt.includes(file)) continue;
      assert.equal(/** @type {RegExp} */ (pattern).test(text), false,
        `${rel(file)} contains ${what} (${pattern}). ${WHY}`);
    }
  }
});
