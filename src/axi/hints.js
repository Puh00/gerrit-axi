// SPDX-License-Identifier: Apache-2.0

/**
 * Next-step hints: the `help[]` lines a record carries, and the one place a
 * suggested command is spelled.
 *
 * A hint is prose for whoever reads the log, never a field to branch on, and it
 * follows three rules. It names a complete command, carrying the connection
 * overrides of the current invocation (`--host` and its siblings) so the hinted
 * call reaches the same server; it uses a placeholder such as `<change>` for a
 * value the caller has yet to choose and a concrete value only for one the
 * record already holds; and it never suggests what this tool does not do -- no
 * hint names a vote, a label, a reviewer, or `submit` on a change the server
 * has not marked submittable. `--json` is a format, not a disambiguator, so it
 * is not carried: a caller adds it to any command it likes.
 */

/** The connection overrides, in the order a hint repeats them. */
const CARRIED = /** @type {const} */ ([
  ['host', '--host'],
  ['port', '--port'],
  ['user', '--user'],
  ['project', '--project'],
  ['restBase', '--rest-base'],
]);

/** The commands, as the unknown-command hint offers them. */
export const COMMAND_TEMPLATES = [
  'gerrit-axi',
  'gerrit-axi status',
  'gerrit-axi show <change>...',
  'gerrit-axi comments <change>...',
  'gerrit-axi auth status',
  'gerrit-axi publish --stack --topic <t>',
  'gerrit-axi publish --squash',
  'gerrit-axi submit <change>',
  'gerrit-axi message <change>',
  'gerrit-axi watch <change>...',
  'gerrit-axi setup hooks',
];

/**
 * A word of a hinted command line, quoted for a POSIX shell when it needs it.
 * A placeholder in angle brackets, or an optional group in square ones, is left
 * bare on purpose: it is for the reader to replace, not for a shell to read.
 *
 * @param {string|number} word
 * @returns {string}
 */
export function shellWord(word) {
  const text = String(word);
  if (/^(?:<[^<>\s]+>(?:\.\.\.)?|\[[^\]]*\])$/.test(text)) return text;
  if (/^[A-Za-z0-9_.:/@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * The connection overrides of the current invocation, as words to append to a
 * hinted command. Empty when none was given.
 *
 * @param {import('./args.js').ParsedArgs['overrides']|undefined} overrides
 * @returns {string[]}
 */
export function carriedWords(overrides) {
  if (!overrides) return [];
  /** @type {string[]} */
  const words = [];
  for (const [key, flag] of CARRIED) {
    const value = overrides[key];
    if (typeof value === 'string') words.push(flag, shellWord(value));
  }
  return words;
}

/**
 * A complete hinted command: `gerrit-axi`, the words given, then the carried
 * overrides.
 *
 * @param {Array<string|number>} words
 * @param {import('./args.js').ParsedArgs['overrides']|undefined} overrides
 * @returns {string}
 */
export function command(words, overrides) {
  return ['gerrit-axi', ...words.map(shellWord), ...carriedWords(overrides)].join(' ');
}

/**
 * The current invocation, rebuilt from its parsed form: command, positional
 * arguments, then the command's own options -- with `set` applied over the
 * options given and `drop` removed -- and the carried overrides last. Global
 * options other than the connection overrides are not repeated.
 *
 * @param {string} op
 * @param {import('./args.js').ParsedArgs} args
 * @param {{set?: Record<string, string|boolean>, drop?: readonly string[]}} [edit]
 * @returns {string}
 */
export function invocation(op, args, { set = {}, drop = [] } = {}) {
  const words = op === 'dashboard' ? [] : [op];
  words.push(...args.positional);
  const flags = { ...ownFlags(args.flags), ...set };
  for (const [flag, value] of Object.entries(flags)) {
    if (drop.includes(flag) || value === false) continue;
    words.push(flag);
    if (value !== true) words.push(String(value));
  }
  return command(words, args.overrides);
}

/** Options that name the connection or the format, never repeated by `invocation`. */
const GLOBAL_FLAGS = new Set(['--json', '--host', '--user', '--port', '--project', '--rest-base',
  '--help', '-h', '--version', '-V']);

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {Record<string, string|boolean>}
 */
function ownFlags(flags) {
  return Object.fromEntries(Object.entries(flags).filter(([flag]) => !GLOBAL_FLAGS.has(flag)));
}

/**
 * The line that reveals truncated bodies, or null when nothing was cut.
 *
 * @param {string} op
 * @param {import('./args.js').ParsedArgs} args
 * @param {ReadonlyArray<{truncated: unknown, chars: unknown}>} rows
 * @returns {string|null}
 */
export function truncationHint(op, args, rows) {
  const cut = rows.filter((row) => row.truncated === true);
  if (cut.length === 0) return null;
  const longest = Math.max(...cut.map((row) => Number(row.chars)));
  const noun = cut.length === 1 ? 'body' : 'bodies';
  return `Run \`${invocation(op, args, { set: { '--full': true } })}\``
    + ` for the full text of ${cut.length} truncated ${noun} (longest ${longest} chars)`;
}

/**
 * The submit hint for a list of changes: only the ones the server itself marks
 * submittable and still open are named, and no line at all when there is none.
 * The readiness on the row is the server's verdict, never recomputed here.
 *
 * @param {ReadonlyArray<{change: unknown, status: unknown, submittable: unknown}>} rows
 * @param {import('./args.js').ParsedArgs['overrides']|undefined} overrides
 * @returns {string|null}
 */
export function submittableHint(rows, overrides) {
  const ready = rows
    .filter((row) => row.status === 'NEW' && row.submittable === true)
    .map((row) => String(row.change));
  if (ready.length === 0) return null;
  return `Run \`${command(['submit', '<change>'], overrides)}\``
    + ` for a change the server marks submittable: ${ready.join(' ')}`;
}

/**
 * The help lines for a failure, when a gerrit-axi command fixes or diagnoses
 * it and the raiser's remedy does not already spell that command. A usage
 * error raised with its own `help` keeps it. Everything else answers `[]`, and
 * no line here ever says "see --help".
 *
 * @param {unknown} error
 * @param {{op?: string, argv: readonly string[], args?: import('./args.js').ParsedArgs}} ctx
 * @returns {string[]}
 */
export function errorHelp(error, { op, argv, args }) {
  const err = /** @type {any} */ (error);
  if (Array.isArray(err?.help)) return err.help.filter((line) => typeof line === 'string');
  const code = typeof err?.code === 'string' ? err.code : '';
  const message = String(err?.message ?? '');
  const again = `gerrit-axi ${argv.filter((word) => word !== '--json').map(shellWord).join(' ')}`.trim();
  const overrides = args?.overrides;
  const numbers = args?.positional.filter((word) => /^[0-9]+$/.test(word)) ?? [];
  const named = numbers.length > 0 ? numbers : ['<change>'];

  switch (code) {
    case 'HOST_UNRESOLVED':
      return /username/.test(message)
        ? [`Run \`${again} --user <name>\``]
        : [`Run \`${again} --host <host>\``];
    case 'PROJECT_UNRESOLVED':
      return [`Run \`${again} --project <project/path>\``];
    case 'NOT_FOUND':
      return [`Run \`${command(['show', ...named], overrides)}\`;`
        + ' a number the server does not return is listed under missing'];
    case 'HTTP_ERROR':
      return /redirect/.test(message) ? [`Run \`${again} --rest-base https://<host>\``] : [];
    case 'GERRIT_ERROR':
      return op === 'status' && typeof args?.flags['--query'] === 'string'
        ? [`Run \`${command(['status', '--query', '<query>'], overrides)}\``
          + ' with a query Gerrit accepts; spell negation NOT, never a leading -']
        : [];
    case 'NOTHING_TO_PUBLISH':
      return [`Run \`${command(['status', 'mine'], overrides)}\` for the changes you already have open`];
    case 'NO_SUCH_BRANCH':
      return /default/.test(message) ? [`Run \`${again} --branch <branch>\``] : [];
    case 'HEAD_MOVED':
      return [`Run \`${again}\` again`];
    case 'SUBMIT_REFUSED':
      return [`Run \`${command(['show', ...named], overrides)}\` for the labels blocking it (blocked_on)`];
    case 'MESSAGE_REFUSED':
      return [`Run \`${command(['show', ...named], overrides)}\` for the change's status;`
        + ' a closed change refuses messages'];
    default:
      return [];
  }
}
