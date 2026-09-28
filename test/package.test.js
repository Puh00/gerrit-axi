// SPDX-License-Identifier: Apache-2.0

/**
 * The README and docs ship inside the release tarball, so every file they link
 * to must ship too. This asks npm itself what it would pack, rather than
 * reading the `files` list, so it answers for the tarball a user actually
 * installs.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SRC_DIR } from './helpers.js';

const REPO_ROOT = path.join(SRC_DIR, '..');

test('every relative link in a packed markdown file resolves inside the tarball', () => {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [manifest] = Object.values(JSON.parse(pack.stdout));
  const packed = new Set(manifest.files.map((/** @type {{path: string}} */ f) => f.path));
  assert.ok(packed.has('README.md'), 'the README is packed');

  const docs = [...packed].filter((p) => p.endsWith('.md'));
  let checked = 0;
  for (const doc of docs) {
    const text = readFileSync(path.join(REPO_ROOT, doc), 'utf8');
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1].split('#')[0])
      .filter((t) => t !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(t));
    for (const target of targets) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(doc), target));
      assert.ok(packed.has(resolved), `${doc} links to ${target}, which is not packed`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'the packed docs link to other files');
});
