// SPDX-License-Identifier: Apache-2.0

/**
 * Argument parsing for the agent tier.
 *
 * Separate from the human CLI's parser rather than shared: this tier must not
 * import `src/cli/`, and its surface is different anyway -- there is no `--no-color`
 * because nothing here is coloured, and there is a `--json` because machine
 * output is what this binary is for. An unknown option is an error rather than a
 * positional, so a caller that misspells a flag hears about it instead of getting
 * a silently different query -- and the error names the command's options, so the
 * caller's next call is the right one rather than a `--help`.
 */

import { UsageError } from './output.js';
import { CHANGE_FIELDS, STATUS_FIELDS, STATUS_TABLES } from './records.js';

/** Applies to every subcommand; overrides every config tier. */
const GLOBAL_WITH_VALUE = new Set(['--host', '--user', '--port', '--project', '--rest-base']);
const GLOBAL_BOOLEAN = new Set(['--json', '--help', '-h', '--version', '-V', '-v']);

/** The global options as an unknown-option record lists them: long forms only. */
const GLOBAL_OPTIONS = ['--json', '--host', '--user', '--port', '--project', '--rest-base', '--help', '--version'];

/**
 * Every command's own options, the one catalogue: the parser rejects by it, the
 * unknown-option record lists from it, and test/axi.test.js checks that the
 * top-level help and that command's own help name all of it. Add an option
 * here, and in USAGE and COMMAND_HELP in help.js.
 *
 * @type {Record<string, {withValue: readonly string[], boolean: readonly string[]}>}
 */
export const COMMAND_OPTIONS = {
  dashboard: { withValue: ['--rows'], boolean: ['--ambient'] },
  status: { withValue: ['--query', '--limit', '--fields'], boolean: [] },
  show: { withValue: ['--messages'], boolean: ['--comments', '--bots', '--humans', '--full'] },
  comments: { withValue: [], boolean: ['--bots', '--humans', '--full'] },
  auth: { withValue: [], boolean: [] },
  publish: { withValue: ['--topic', '--branch'], boolean: ['--stack', '--squash', '--wip'] },
  ready: { withValue: ['--patch-set', '--revision'], boolean: ['--rest'] },
  wip: { withValue: ['--patch-set', '--revision'], boolean: [] },
  submit: { withValue: [], boolean: [] },
  message: { withValue: ['--file'], boolean: [] },
  watch: { withValue: ['--interval', '--timeout', '--since'], boolean: [] },
  setup: { withValue: [], boolean: ['--remove'] },
};

/**
 * @typedef {Object} ParsedArgs
 * @property {string[]} positional
 * @property {Record<string, string|boolean>} flags
 * @property {{host?: string, user?: string, port?: string, project?: string, restBase?: string}} overrides
 * @property {boolean} json
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * @param {string[]} argv
 * @param {keyof typeof COMMAND_OPTIONS} command  whose options, besides the global ones, are known
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, command) {
  const own = COMMAND_OPTIONS[command];
  const withValue = new Set([...GLOBAL_WITH_VALUE, ...own.withValue]);
  const booleans = new Set([...GLOBAL_BOOLEAN, ...own.boolean]);

  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (onlyPositional || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositional = true;
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq > 2) {
      const name = arg.slice(0, eq);
      if (booleans.has(name)) throw new UsageError(`${name} does not take a value`);
      if (!withValue.has(name)) throw unknownOption(name, command);
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    if (withValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith('-') && value !== '-')) {
        throw new UsageError(`${arg} needs a value`);
      }
      flags[arg] = value;
      i += 1;
      continue;
    }
    if (booleans.has(arg)) {
      flags[arg] = true;
      continue;
    }
    throw unknownOption(arg, command);
  }

  return {
    positional,
    flags,
    overrides: pruned({
      host: str(flags['--host']),
      user: str(flags['--user']),
      port: str(flags['--port']),
      project: str(flags['--project']),
      restBase: str(flags['--rest-base']),
    }),
    json: flags['--json'] === true,
    help: flags['--help'] === true || flags['-h'] === true,
    version: flags['--version'] === true || flags['-V'] === true || flags['-v'] === true,
  };
}

/**
 * The unknown-option error, self-correcting in one turn: it names the command and
 * the option, and its remedy lists every option the command does take, so the
 * caller's next move is the corrected call rather than a `--help` round trip.
 * A misspelling close to a valid option is pointed at that option.
 *
 * @param {string} arg
 * @param {keyof typeof COMMAND_OPTIONS} command
 * @returns {UsageError}
 */
function unknownOption(arg, command) {
  const own = [...COMMAND_OPTIONS[command].withValue, ...COMMAND_OPTIONS[command].boolean];
  const hints = [];
  const near = nearest(arg, [...own, ...GLOBAL_OPTIONS]);
  if (near) hints.push(`Did you mean ${near}?`);
  hints.push(own.length > 0
    ? `Options for ${command}: ${own.join(', ')}.`
    : `${command} takes no options of its own.`);
  hints.push(`Global options: ${GLOBAL_OPTIONS.join(', ')}.`);
  return new UsageError(`unknown option for ${command}: ${arg}`, hints.join(' '));
}

/**
 * The candidate a typo is most likely a typo of, or undefined when none is close
 * enough to name without guessing: within two edits (a transposition counting as
 * one), and never a word so short that two edits would reach most candidates.
 *
 * @param {string} word
 * @param {readonly string[]} candidates
 * @returns {string|undefined}
 */
export function nearest(word, candidates) {
  const limit = word.length >= 6 ? 2 : 1;
  let best;
  let bestDistance = limit + 1;
  for (const candidate of candidates) {
    if (candidate === word) continue;
    const d = editDistance(word, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and
 * adjacent transpositions, each costing one.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

/**
 * Change numbers, validated here so a bad one is a usage error with the offending
 * token in it rather than a query the server refuses.
 *
 * @param {readonly string[]} positional
 * @returns {number[]}
 */
export function changeNumbers(positional) {
  return positional.map((token) => {
    if (!/^[0-9]+$/.test(token)) throw new UsageError(`not a change number: ${token}`);
    return Number(token);
  });
}

/**
 * @param {string|boolean|undefined} value
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
export function positiveInt(value, fallback, name) {
  if (typeof value !== 'string') return fallback;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`${name} needs a whole number, got: ${value}`);
  return Number(value);
}

/**
 * `--messages all` means every one; a number means the newest that many.
 *
 * @param {string|boolean|undefined} value
 * @returns {number}
 */
export function messageCount(value) {
  if (typeof value !== 'string') return 0;
  if (value === 'all') return Infinity;
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`--messages needs a whole number or 'all', got: ${value}`);
  }
  return Number(value);
}

/**
 * `status --fields a,b` -- the columns and tables a `status` document carries
 * beyond its default. A name is a `changes` column, `labels` or `votes` for that
 * table, or `all` for every column and both tables. The default columns are
 * always carried, so a list names only what it adds. A name that is none of
 * these is refused before the server is asked, with the ones that are.
 *
 * @param {string|boolean|undefined} value
 * @returns {{columns: Set<string>, tables: Set<string>}}
 */
export function statusFields(value) {
  const columns = new Set(/** @type {readonly string[]} */ (STATUS_FIELDS));
  const tables = new Set();
  if (typeof value !== 'string') return { columns, tables };
  const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const known = [...CHANGE_FIELDS, ...STATUS_TABLES, 'all'];
  const valid = `Fields: ${known.join(', ')}.`;
  if (names.length === 0) throw new UsageError('--fields needs at least one field name', valid);
  for (const name of names) {
    if (name === 'all') {
      for (const field of CHANGE_FIELDS) columns.add(field);
      for (const table of STATUS_TABLES) tables.add(table);
    } else if ((/** @type {readonly string[]} */ (STATUS_TABLES)).includes(name)) {
      tables.add(name);
    } else if ((/** @type {readonly string[]} */ (CHANGE_FIELDS)).includes(name)) {
      columns.add(name);
    } else {
      const near = nearest(name, known);
      throw new UsageError(`unknown field for status: ${name}`,
        `${near ? `Did you mean ${near}? ` : ''}${valid}`);
    }
  }
  return { columns, tables };
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} obj
 * @returns {T}
 */
function pruned(obj) {
  return /** @type {T} */ (
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
  );
}

/**
 * @param {string|boolean|undefined} value
 * @returns {string|undefined}
 */
function str(value) {
  return typeof value === 'string' ? value : undefined;
}
