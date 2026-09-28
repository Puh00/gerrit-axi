// SPDX-License-Identifier: Apache-2.0

/**
 * Severity classification -- TIER 3.
 *
 * Some CI systems sort review comments into `[issue]` (blocking-ish) and
 * `[suggestion]` (advisory). That prefix is one organisation's CI job convention.
 * It is not part of Gerrit, and it is not part of any bot framework, so it cannot
 * be derived from anything: it has to be configured.
 *
 * Accordingly this defaults to *empty*, and empty is a strict no-op. Out of the
 * box the tool prints raw comments and the presentation layer shows no severity
 * column at all. See `severity.patterns` in docs/configuration.md.
 */

/**
 * Compile config patterns once per run. Compiling is separated from matching so a
 * bad regexp fails at config time, not halfway through a result set.
 *
 * @param {import('./config.js').SeverityPattern[]} patterns
 * @returns {Array<{name: string, regexp: RegExp}>}
 */
export function compileSeverityPatterns(patterns = []) {
  return patterns.map(({ name, pattern, flags = 'i' }) => ({
    name,
    regexp: new RegExp(pattern, flags),
  }));
}

/**
 * First matching pattern wins, so config order is precedence order.
 *
 * @param {string} message
 * @param {Array<{name: string, regexp: RegExp}>} compiled
 * @returns {string|null} the severity name, or null when nothing matched -- which
 *   is also what an empty pattern list always returns
 */
export function classifySeverity(message, compiled = []) {
  const text = String(message ?? '');
  for (const { name, regexp } of compiled) {
    // Guard against a sticky/global regexp carrying lastIndex between calls.
    regexp.lastIndex = 0;
    if (regexp.test(text)) return name;
  }
  return null;
}

/**
 * Attach `severity` to each comment. With no patterns configured every comment
 * comes back with `severity: null`, unchanged in every other respect.
 *
 * @template {{message: string}} T
 * @param {T[]} comments
 * @param {import('./config.js').SeverityPattern[]} patterns
 * @returns {Array<T & {severity: string|null}>}
 */
export function annotateSeverity(comments, patterns = []) {
  const compiled = compileSeverityPatterns(patterns);
  return comments.map((comment) => ({
    ...comment,
    severity: classifySeverity(comment.message, compiled),
  }));
}
