#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Prints one version's section of CHANGELOG.md, for the release job to publish as
 * that release's notes. Exits 1 when the version has no section, or an empty one,
 * so a tag cannot publish a release that says nothing about what changed.
 *
 *   node scripts/changelog-section.js <version> [changelog]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The body under `## [<version>]`, up to the next `## ` heading or the link
 * reference definitions that close the file, trimmed; null when there is none.
 *
 * @param {string} text
 * @param {string} version
 * @returns {string | null}
 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## ') || /^\[[^\]]+\]: /.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version) {
    process.stderr.write('usage: changelog-section.js <version> [changelog]\n');
    process.exit(2);
  }
  const section = changelogSection(readFileSync(file, 'utf8'), version);
  if (section === null) {
    process.stderr.write(`${file} has no section for ${version}; add a "## [${version}]" section\n`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
