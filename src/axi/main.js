// SPDX-License-Identifier: Apache-2.0

/**
 * The agent tier's entry point: dispatch, and the one place a failure becomes an
 * error record.
 *
 * This tier is a sibling of src/cli/, not a wrapper around it. It imports
 * src/core/ and nothing else, so there is no table to re-parse and no column to
 * shift: the human CLI's layout can change freely without changing a byte of
 * what a consumer here reads. That is why the human `gerrit` has no `--json`.
 */

import { AuthError, ConfigError, GerritError, TransportError } from '../core/errors.js';
import { createSession } from '../core/session.js';
import { parseArgs } from './args.js';
import {
  opAuth,
  opComments,
  opDashboard,
  opMessage,
  opPublish,
  opReady,
  opShow,
  opStatus,
  opSubmit,
  opWatch,
} from './commands.js';
import { COMMAND_HELP, USAGE } from './help.js';
import { COMMAND_TEMPLATES, errorHelp } from './hints.js';
import { opSetup } from './setup.js';
import { UsageError, errorRecord, serialize } from './output.js';
import { VERSION, VERSION_FLAGS } from './version.js';

/** Same codes the human CLI uses, so a caller can drive either interchangeably. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  config: 3,
  auth: 4,
  transport: 5,
  /** `watch` reached its --timeout with nothing changed: a record, not a failure. */
  timeout: 6,
};


/** Each command's options are `COMMAND_OPTIONS` in args.js; help.js lists them too. */
const OPS = {
  dashboard: opDashboard,
  status: opStatus,
  show: opShow,
  comments: opComments,
  auth: opAuth,
  publish: opPublish,
  ready: opReady,
  submit: opSubmit,
  message: opMessage,
  watch: opWatch,
  setup: opSetup,
};

/**
 * @param {string[]} argv          argv without node and script
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, stdin?: NodeJS.ReadStream,
 *          stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream,
 *          runner?: import('../core/exec.js').Runner, fetchImpl?: typeof fetch,
 *          execPath?: string, sleep?: (ms: number) => Promise<void>, now?: () => number}} [io]
 *          `stderr` is accepted and never written: a failure is a record on stdout.
 *          `execPath` is this binary, which `setup hooks` registers. `sleep` and
 *          `now` are the clock `watch` waits on.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    runner,
    fetchImpl,
    execPath = process.argv[1] ?? '',
    sleep,
    now,
  } = io;

  const [first, ...tail] = argv;
  /** @type {import('./args.js').ParsedArgs|undefined} */
  let args;
  const out = (/** @type {string} */ text) => { stdout.write(`${text}\n`); };
  const fail = (/** @type {unknown} */ error, /** @type {string|undefined} */ op) => {
    // Every record goes to stdout, an error record included, in the format the
    // caller asked for: the exit code and `ok` say which kind arrived, and stderr
    // carries nothing, so a caller that reads one stream has read everything.
    const json = argv.includes('--json');
    const help = errorHelp(error, { op, argv, args });
    out(serialize(errorRecord(error, { op, help }), { json }));
    return exitFor(error);
  };

  // Help and version must work with no config, no credential and no network.
  if (first === '--help' || first === '-h' || first === 'help') {
    out(USAGE);
    return EXIT.ok;
  }
  // A bare version flag is normally answered by bin/gerrit-axi.js before this
  // module loads; this is the same answer for a caller that imports main().
  if (first === 'version' || VERSION_FLAGS.includes(/** @type {any} */ (first))) {
    out(VERSION);
    return EXIT.ok;
  }

  // No command is the home view, and so is a bare option (`gerrit-axi --json`):
  // usage is for a caller who asked for it, not for one who asked for nothing.
  const named = first !== undefined && !first.startsWith('-');
  const command = named ? first : 'dashboard';
  const rest = named ? tail : argv;

  const op = /** @type {keyof typeof OPS|undefined} */ (
    Object.hasOwn(OPS, command) ? command : undefined
  );
  if (!op) {
    // The fix is one of the commands, so they are the help: a list to run, not
    // a pointer at --help.
    const help = [`Run one of: ${COMMAND_TEMPLATES.map((t) => `\`${t}\``).join(', ')}`];
    return fail(new UsageError(`unknown command: ${command}`, undefined, help), undefined);
  }

  try {
    args = parseArgs(rest, op);
    const [stray] = args.positional;
    if (!named && stray !== undefined && Object.hasOwn(OPS, stray)) {
      const at = argv.indexOf(stray);
      const fixed = [stray, ...argv.slice(0, at), ...argv.slice(at + 1)].join(' ');
      throw new UsageError(`options come after the command: gerrit-axi ${fixed}`);
    }
    if (args.help) {
      out(named ? COMMAND_HELP[op] : USAGE);
      return EXIT.ok;
    }
    if (args.version) {
      out(VERSION);
      return EXIT.ok;
    }
    const parsed = args;
    const connect = () => createSession({
      overrides: parsed.overrides,
      cwd,
      env,
      runner,
      fetchImpl,
    });
    // Setup and the ambient view must answer where no host resolves, so they
    // connect when and if they need to; every other command needs a server.
    const lazy = op === 'setup' || (op === 'dashboard' && args.flags['--ambient'] === true);
    const session = lazy ? undefined : await connect();
    const ctx = {
      session: /** @type {any} */ (session), args, stdin, connect, env, execPath, cwd, sleep, now,
    };
    const document = await OPS[op](ctx);
    out(serialize(document, { json: args.json }));
    return op === 'watch' && document.changed === false ? EXIT.timeout : EXIT.ok;
  } catch (error) {
    return fail(error, op);
  }
}

/**
 * @param {unknown} error
 * @returns {number}
 */
function exitFor(error) {
  if (error instanceof UsageError) return EXIT.usage;
  if (error instanceof ConfigError) return EXIT.config;
  if (error instanceof AuthError) return EXIT.auth;
  if (error instanceof TransportError) return EXIT.transport;
  if (error instanceof GerritError) return EXIT.error;
  return EXIT.error;
}
