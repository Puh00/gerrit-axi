// SPDX-License-Identifier: Apache-2.0

/**
 * The release job publishes a version's CHANGELOG.md section as its release
 * notes, through scripts/changelog-section.js. These run that extraction here, so
 * a missing section fails before a tag is pushed rather than in the release job.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { changelogSection } from '../scripts/changelog-section.js';
import { SRC_DIR } from './helpers.js';

const REPO_ROOT = path.join(SRC_DIR, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'changelog-section.js');

test('a section runs from its heading to the next version heading', () => {
  const text = [
    '# Changelog',
    '',
    '## [1.1.0]',
    '',
    '### Added',
    '',
    '- the newer thing',
    '',
    '## [1.0.0] - 2026-01-01',
    '',
    '### Fixed',
    '',
    '- the older thing',
    '',
    '[1.1.0]: https://example.com/compare/v1.0.0...v1.1.0',
    '[1.0.0]: https://example.com/tag/v1.0.0',
    '',
  ].join('\n');

  assert.equal(changelogSection(text, '1.1.0'), '### Added\n\n- the newer thing');
  assert.equal(changelogSection(text, '1.0.0'), '### Fixed\n\n- the older thing');
});

test('a version with no section, or an empty one, has none', () => {
  const text = '# Changelog\n\n## [1.1.0]\n\n## [1.0.0]\n\n- the older thing\n';

  assert.equal(changelogSection(text, '1.1.0'), null);
  assert.equal(changelogSection(text, '2.0.0'), null);
  assert.equal(changelogSection(text, '1.0'), null, 'a prefix of a version is not that version');
  assert.equal(changelogSection('## [1.0.0]\r\n\r\n- windows\r\n', '1.0.0'), '- windows');
});

test('the script prints the section, and exits 1 naming the version when there is none', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-'));
  const file = path.join(dir, 'CHANGELOG.md');
  writeFileSync(file, '# Changelog\n\n## [1.0.0]\n\n- the thing\n');

  const found = spawnSync(process.execPath, [SCRIPT, '1.0.0', file], { encoding: 'utf8' });
  assert.equal(found.status, 0);
  assert.equal(found.stdout, '- the thing\n');

  const missing = spawnSync(process.execPath, [SCRIPT, '9.9.9', file], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no section for 9\.9\.9/);
});

test('CHANGELOG.md has a section for the version package.json declares', () => {
  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const text = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');

  assert.notEqual(changelogSection(text, version), null, `CHANGELOG.md needs a "## [${version}]" section`);
});
