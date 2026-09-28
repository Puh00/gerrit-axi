// SPDX-License-Identifier: Apache-2.0

/**
 * Session integration: `setup hooks`, its removal, `setup config`, and the
 * `dashboard --ambient` view the hooks run.
 *
 * Every test writes into its own temporary home directory, passed in as HOME,
 * so nothing here can reach the agent configuration of whoever runs the suite.
 * The binary a hook names is a stand-in file in that home, so the
 * PATH-resolution rule runs against real files.
 */

import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { COMMAND_OPTIONS } from '../src/axi/args.js';
import { EXIT, main } from '../src/axi/main.js';
import { withCodexHooksFeature } from '../src/axi/setup.js';
import { SRC_DIR, captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const DASHBOARD = {
  'attention:self': 'query-detail.txt',
  'owner:self': 'query-stack.txt',
  'reviewer:self': 'query-incoming.txt',
  'cc:self': 'query-empty.txt',
};

/**
 * A fresh home with a stand-in gerrit-axi binary in it, and the environment
 * that points everything there. PATH is empty unless a test puts the binary on
 * it, so no keyring is found and the credential store is the home's files.
 */
function tempHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gerrit-axi-setup-'));
  const exec = path.join(home, 'install', 'bin', 'gerrit-axi.js');
  mkdirSync(path.dirname(exec), { recursive: true });
  writeFileSync(exec, '#!/usr/bin/env node\n');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '' };
  return { home, exec, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * @param {string[]} argv
 * @param {{env: Record<string, string>, exec: string, remote?: string|null,
 *          ssh?: 'dashboard'|'fail', fetchRoutes?: any[]}} opts
 */
async function run(argv, { env, exec, remote = REMOTE, ssh = 'dashboard', fetchRoutes = [] }) {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    {
      match: (f, a) => f === 'git' && a.includes('remote'),
      result: remote === null ? { code: 2 } : { stdout: remote },
    },
    {
      match: (f) => f === 'ssh',
      result: (_f, args) => {
        if (ssh === 'fail') return { code: 255, stderr: 'Permission denied (publickey).\n' };
        const query = args.at(-2) ?? '';
        const prefix = Object.keys(DASHBOARD).find((p) => query.startsWith(p));
        assert.ok(prefix, `no fixture answers the query: ${query}`);
        return { stdout: fixture(DASHBOARD[/** @type {keyof typeof DASHBOARD} */ (prefix)]) };
      },
    },
  ]);
  const code = await main(argv, {
    cwd: '/some/checkout',
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner,
    fetchImpl: fakeFetch(fetchRoutes),
    execPath: exec,
  });
  return { code, out: stdout.text, err: stderr.text, runner };
}

/** @param {string} file */
function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('setup hooks registers the ambient view for Claude Code, Codex and OpenCode', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const { code, out, err } = await run(['setup', 'hooks', '--json'], { env, exec });
    assert.equal(code, EXIT.ok, out);
    assert.equal(err, '');
    const record = JSON.parse(out);
    assert.equal(record.op, 'setup hooks');
    assert.equal(record.status, 'installed');
    assert.equal(record.hook, `${exec} dashboard --ambient`);
    assert.deepEqual(record.targets.map((/** @type {any} */ t) => [t.agent, t.path, t.action]), [
      ['claude', '~/.claude/settings.json', 'installed'],
      ['codex', '~/.codex/hooks.json', 'installed'],
      ['codex-feature', '~/.codex/config.toml', 'installed'],
      ['opencode', '~/.config/opencode/plugins/axi-gerrit-axi.js', 'installed'],
    ]);
    assert.equal(record.help[0], 'Restart your agent session to receive gerrit-axi ambient context');

    const expected = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: `${exec} dashboard --ambient`, timeout: 10 }],
        }],
      },
    };
    assert.deepEqual(json(path.join(home, '.claude', 'settings.json')), expected);
    assert.deepEqual(json(path.join(home, '.codex', 'hooks.json')), expected);
    assert.equal(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), '[features]\nhooks = true\n');
    const plugin = readFileSync(path.join(home, '.config', 'opencode', 'plugins', 'axi-gerrit-axi.js'), 'utf8');
    assert.match(plugin, /^\/\/ gerrit-axi managed opencode plugin/);
    assert.ok(plugin.includes(`const file = ${JSON.stringify(exec)};`));
    assert.ok(plugin.includes('const args = ["dashboard","--ambient"];'));
  } finally {
    cleanup();
  }
});

test('setup hooks keeps every setting and hook it did not write', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const settings = path.join(home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    const theirs = {
      theme: 'dark',
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'other-axi', timeout: 10 }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify' }] }],
      },
    };
    writeFileSync(settings, JSON.stringify(theirs));
    const toml = path.join(home, '.codex', 'config.toml');
    mkdirSync(path.dirname(toml), { recursive: true });
    writeFileSync(toml, 'model = "x"\n\n[features]\nother = true\n\n[profiles.fast]\nmodel = "y"\n');

    const { code } = await run(['setup', 'hooks'], { env, exec });
    assert.equal(code, EXIT.ok);

    const after = json(settings);
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.hooks.Stop, theirs.hooks.Stop);
    assert.deepEqual(after.hooks.SessionStart[0], theirs.hooks.SessionStart[0]);
    assert.equal(after.hooks.SessionStart[1].hooks[0].command, `${exec} dashboard --ambient`);
    assert.equal(readFileSync(toml, 'utf8'),
      'model = "x"\n\n[features]\nother = true\n\nhooks = true\n[profiles.fast]\nmodel = "y"\n');
  } finally {
    cleanup();
  }
});

test('a repeated setup hooks changes nothing and says so', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    await run(['setup', 'hooks'], { env, exec });
    const files = [
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.codex', 'hooks.json'),
      path.join(home, '.codex', 'config.toml'),
      path.join(home, '.config', 'opencode', 'plugins', 'axi-gerrit-axi.js'),
    ];
    const before = files.map((file) => readFileSync(file, 'utf8'));

    const { code, out } = await run(['setup', 'hooks', '--json'], { env, exec });
    assert.equal(code, EXIT.ok);
    const record = JSON.parse(out);
    assert.equal(record.status, 'unchanged');
    assert.deepEqual(record.targets.map((/** @type {any} */ t) => t.action),
      ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    assert.equal(record.help.some((/** @type {string} */ line) => line.startsWith('Restart')), false);
    assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), before);
  } finally {
    cleanup();
  }
});

test('setup hooks repairs the path of a binary that moved, keeping one entry', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    await run(['setup', 'hooks'], { env, exec });
    const moved = path.join(home, 'elsewhere', 'gerrit-axi.js');
    mkdirSync(path.dirname(moved), { recursive: true });
    writeFileSync(moved, '#!/usr/bin/env node\n');

    const { out } = await run(['setup', 'hooks', '--json'], { env, exec: moved });
    const record = JSON.parse(out);
    assert.equal(record.status, 'installed');
    assert.equal(record.targets[0].action, 'updated');
    const groups = json(path.join(home, '.claude', 'settings.json')).hooks.SessionStart;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks[0].command, `${moved} dashboard --ambient`);
  } finally {
    cleanup();
  }
});

test('setup hooks folds duplicate ambient hooks into one entry', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const settings = path.join(home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    const theirs = { type: 'command', command: 'echo hello' };
    writeFileSync(settings, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: '/old/gerrit-axi dashboard --ambient', timeout: 10 }] },
          { matcher: '', hooks: [theirs, { type: 'command', command: '/copy/gerrit-axi dashboard --ambient' }] },
        ],
      },
    }));

    const { out } = await run(['setup', 'hooks', '--json'], { env, exec });
    assert.equal(JSON.parse(out).targets[0].action, 'updated');
    assert.deepEqual(json(settings).hooks.SessionStart, [
      { matcher: '', hooks: [{ type: 'command', command: `${exec} dashboard --ambient`, timeout: 10 }] },
      { matcher: '', hooks: [theirs] },
    ]);

    const { out: again } = await run(['setup', 'hooks', '--json'], { env, exec });
    assert.equal(JSON.parse(again).targets[0].action, 'unchanged');
  } finally {
    cleanup();
  }
});

test('the hook names the bare binary when gerrit-axi on PATH is this executable', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const bin = path.join(home, 'bin');
    mkdirSync(bin);
    symlinkSync(exec, path.join(bin, 'gerrit-axi'));
    const onPath = { ...env, PATH: bin };

    const { out } = await run(['setup', 'hooks', '--json'], { env: onPath, exec });
    assert.equal(JSON.parse(out).hook, 'gerrit-axi dashboard --ambient');

    // A gerrit-axi on PATH that is some other file is not trusted with the hook.
    const other = path.join(home, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'gerrit-axi'), '#!/bin/sh\n');
    const { out: second } = await run(['setup', 'hooks', '--json'], { env: { ...env, PATH: other }, exec });
    assert.equal(JSON.parse(second).hook, `${exec} dashboard --ambient`);
  } finally {
    cleanup();
  }
});

test('setup hooks --remove takes out only what setup hooks put in', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const settings = path.join(home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    const handWritten = { type: 'command', command: 'gerrit-axi status mine' };
    writeFileSync(settings, JSON.stringify({
      theme: 'dark',
      hooks: { SessionStart: [{ matcher: '', hooks: [handWritten] }] },
    }));
    await run(['setup', 'hooks'], { env, exec });

    const { code, out, err } = await run(['setup', 'hooks', '--remove', '--json'], { env, exec });
    assert.equal(code, EXIT.ok, out);
    assert.equal(err, '');
    const record = JSON.parse(out);
    assert.equal(record.op, 'setup hooks --remove');
    assert.equal(record.status, 'removed');
    assert.deepEqual(record.targets.map((/** @type {any} */ t) => [t.agent, t.action]), [
      ['claude', 'removed'],
      ['codex', 'removed'],
      ['codex-feature', 'kept'],
      ['opencode', 'removed'],
    ]);

    // The hand-written hook mentions gerrit-axi but is not the ambient hook: it stays.
    assert.deepEqual(json(settings), {
      theme: 'dark',
      hooks: { SessionStart: [{ matcher: '', hooks: [handWritten] }] },
    });
    assert.deepEqual(json(path.join(home, '.codex', 'hooks.json')), {});
    // Other tools' Codex hooks need the flag, so it outlives ours.
    assert.equal(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), '[features]\nhooks = true\n');
    assert.equal(existsSync(path.join(home, '.config', 'opencode', 'plugins', 'axi-gerrit-axi.js')), false);

    const { out: again } = await run(['setup', 'hooks', '--remove', '--json'], { env, exec });
    const repeat = JSON.parse(again);
    assert.equal(repeat.status, 'absent');
    assert.equal('help' in repeat, false);
  } finally {
    cleanup();
  }
});

test('a file setup cannot read, or a plugin it did not write, is reported and left as it was', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const settings = path.join(home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, '{ not json');
    const plugin = path.join(home, '.config', 'opencode', 'plugins', 'axi-gerrit-axi.js');
    mkdirSync(path.dirname(plugin), { recursive: true });
    writeFileSync(plugin, 'export const Mine = 1;\n');

    const { code, out } = await run(['setup', 'hooks', '--json'], { env, exec });
    assert.equal(code, EXIT.ok);
    const record = JSON.parse(out);
    assert.equal(record.status, 'partial');
    assert.deepEqual(record.targets.map((/** @type {any} */ t) => [t.agent, t.action]), [
      ['claude', 'failed'],
      ['codex', 'installed'],
      ['codex-feature', 'installed'],
      ['opencode', 'failed'],
    ]);
    assert.deepEqual(record.failures.map((/** @type {any} */ f) => f.path),
      ['~/.claude/settings.json', '~/.config/opencode/plugins/axi-gerrit-axi.js']);
    assert.match(record.help[0], /^Fix the files under failures, then run `gerrit-axi setup hooks` again$/);
    assert.equal(readFileSync(settings, 'utf8'), '{ not json');
    assert.equal(readFileSync(plugin, 'utf8'), 'export const Mine = 1;\n');

    const { out: removal } = await run(['setup', 'hooks', '--remove', '--json'], { env, exec });
    assert.equal(JSON.parse(removal).status, 'partial');
    assert.equal(readFileSync(plugin, 'utf8'), 'export const Mine = 1;\n');
  } finally {
    cleanup();
  }
});

test('setup hooks names what is missing and the human command that fixes it', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    // A Gerrit checkout, no credential stored, no config file.
    const { out } = await run(['setup', 'hooks', '--json'], { env, exec });
    const record = JSON.parse(out);
    assert.equal(record.host, 'gerrit.example.com');
    assert.equal(record.port, 29418);
    assert.equal(record.user, 'ada');
    assert.equal(record.signed_in, false);
    assert.ok(record.help.includes('Not signed in: run `gerrit auth login`'), record.help.join('\n'));
    assert.ok(record.help.includes('Run `gerrit-axi setup config` to save this checkout\'s host, port and'
      + ' user to ~/.config/gerrit-axi/config.json, so gerrit-axi resolves outside it too'));
    assert.equal(record.help.at(-1), 'Run `gerrit-axi setup hooks --remove` to take the hooks out again');

    // Signed in, with a config file already there: neither line.
    const credentials = path.join(home, '.config', 'gerrit-axi', 'credentials');
    mkdirSync(credentials, { recursive: true });
    writeFileSync(path.join(credentials, 'gerrit.example.com_ada.token'), 'placeholder-not-a-real-token\n');
    writeFileSync(path.join(home, '.config', 'gerrit-axi', 'config.json'), '{}\n');
    const { out: ready } = await run(['setup', 'hooks', '--json'], {
      env,
      exec,
      fetchRoutes: [{ path: '/a/accounts/self', body: ")]}'\n{\"_account_id\":1000,\"username\":\"ada\"}" }],
    });
    const signedIn = JSON.parse(ready);
    assert.equal(signedIn.signed_in, true);
    assert.deepEqual(signedIn.help, ['Run `gerrit-axi setup hooks --remove` to take the hooks out again']);
    assert.equal(ready.includes('placeholder-not-a-real-token'), false);

    // A credential the server rejects is named as such.
    const { out: rejected } = await run(['setup', 'hooks', '--json'], {
      env,
      exec,
      fetchRoutes: [{ path: '/a/accounts/self', status: 401, body: 'Unauthorized' }],
    });
    assert.ok(JSON.parse(rejected).help.includes(
      'gerrit.example.com rejected the stored credential: run `gerrit auth login`'));
  } finally {
    cleanup();
  }
});

test('setup hooks outside any Gerrit checkout still installs, and says what does not resolve', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const { code, out } = await run(['setup', 'hooks', '--json'], { env, exec, remote: null });
    assert.equal(code, EXIT.ok);
    const record = JSON.parse(out);
    assert.equal(record.status, 'installed');
    assert.equal(record.host, null);
    assert.equal(record.signed_in, null);
    assert.ok(record.help.includes('No Gerrit host resolves here: run setup in a checkout whose origin is a'
      + ' Gerrit remote, or `export GERRIT_HOST=<host>`'));
    assert.ok(existsSync(path.join(home, '.claude', 'settings.json')));
  } finally {
    cleanup();
  }
});

test('setup refuses what it does not do, and a missing HOME, before writing anything', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const bad = await run(['setup', 'plugins', '--json'], { env, exec });
    assert.equal(bad.code, EXIT.usage);
    const record = JSON.parse(bad.out);
    assert.equal(record.code, 'BAD_USAGE');
    assert.deepEqual(record.help, ['Run one of: `gerrit-axi setup hooks`, `gerrit-axi setup hooks --remove`,'
      + ' `gerrit-axi setup config`']);

    const bare = await run(['setup', '--json'], { env, exec });
    assert.equal(bare.code, EXIT.usage);

    const flag = await run(['setup', 'config', '--remove', '--json'], { env, exec });
    assert.equal(flag.code, EXIT.usage);

    const noHome = await run(['setup', 'hooks', '--json'], {
      env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, PATH: '' },
      exec,
    });
    assert.equal(noHome.code, EXIT.config);
    assert.equal(JSON.parse(noHome.out).code, 'NO_HOME');

    assert.deepEqual(readdir(home), ['install']);
  } finally {
    cleanup();
  }
});

test('no command but setup writes into an agent\'s configuration', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    for (const argv of [[], ['dashboard', '--ambient'], ['status'], ['auth', 'status']]) {
      await run(argv, { env, exec });
    }
    assert.deepEqual(readdir(home), ['install']);
  } finally {
    cleanup();
  }
});

test('setup config saves host, port and user from the origin, and never overwrites', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const file = path.join(home, '.config', 'gerrit-axi', 'config.json');
    const { code, out } = await run(['setup', 'config', '--json'], { env, exec });
    assert.equal(code, EXIT.ok, out);
    const record = JSON.parse(out);
    assert.equal(record.status, 'written');
    assert.equal(record.path, '~/.config/gerrit-axi/config.json');
    assert.deepEqual(json(file), { host: 'gerrit.example.com', port: 29418, user: 'ada' });

    writeFileSync(file, '{"host": "hand.example.com"}\n');
    const { out: again } = await run(['setup', 'config', '--json'], { env, exec });
    assert.equal(JSON.parse(again).status, 'exists');
    assert.equal(readFileSync(file, 'utf8'), '{"host": "hand.example.com"}\n');
  } finally {
    cleanup();
  }
});

test('setup config outside a Gerrit checkout is an error record, not a guess', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const { code, out } = await run(['setup', 'config', '--json'], {
      env: { ...env, GERRIT_HOST: 'gerrit.example.com' },
      exec,
      remote: null,
    });
    assert.equal(code, EXIT.config);
    const record = JSON.parse(out);
    assert.equal(record.ok, false);
    assert.equal(record.code, 'NOT_A_GERRIT_CHECKOUT');
    assert.equal(existsSync(path.join(home, '.config', 'gerrit-axi', 'config.json')), false);
  } finally {
    cleanup();
  }
});

test('setup config where no host resolves points at a Gerrit checkout, not at --host', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const { code, out } = await run(['setup', 'config', '--json'], { env, exec, remote: null });
    assert.equal(code, EXIT.config);
    const record = JSON.parse(out);
    assert.equal(record.ok, false);
    assert.equal(record.code, 'NOT_A_GERRIT_CHECKOUT');
    assert.equal(record.remedy, 'Run it in a checkout whose origin remote points at Gerrit.');
    assert.equal(record.help, undefined);
    assert.equal(existsSync(path.join(home, '.config', 'gerrit-axi', 'config.json')), false);
  } finally {
    cleanup();
  }
});

test('the bare home view opens with the bin and description the ambient view prints', async () => {
  const { exec, env, cleanup } = tempHome();
  try {
    const home = await run(['--json'], { env, exec });
    assert.equal(home.code, EXIT.ok, home.out);
    const view = JSON.parse(home.out);
    assert.deepEqual(Object.keys(view).slice(0, 4), ['ok', 'op', 'bin', 'description']);
    assert.equal(view.op, 'dashboard');
    assert.equal(view.bin, '~/install/bin/gerrit-axi.js');

    const ambient = JSON.parse((await run(['dashboard', '--ambient', '--json'], { env, exec })).out);
    assert.deepEqual({ bin: view.bin, description: view.description },
      { bin: ambient.bin, description: ambient.description });

    // TOON, the default, names the tool before the live data.
    const toon = await run([], { env, exec });
    assert.match(toon.out, /^ok: true\nop: dashboard\nbin: ~\/install\/bin\/gerrit-axi\.js\ndescription: /);
  } finally {
    cleanup();
  }
});

test('the ambient view in a Gerrit checkout is counts and next steps, never rows', async () => {
  const { exec, env, cleanup } = tempHome();
  try {
    const { code, out, err } = await run(['dashboard', '--ambient', '--json'], { env, exec });
    assert.equal(code, EXIT.ok, out);
    assert.equal(err, '');
    const view = JSON.parse(out);
    assert.deepEqual(Object.keys(view), ['bin', 'description', 'host', 'user', 'sections', 'help']);
    assert.equal(view.bin, '~/install/bin/gerrit-axi.js');
    assert.match(view.description, /cannot vote/);
    assert.deepEqual(view.sections, [
      { section: 'your_turn', count: 1 },
      { section: 'wip', count: 1 },
      { section: 'outgoing', count: 2 },
      { section: 'incoming', count: 2 },
      { section: 'cced', count: 0 },
    ]);
    assert.deepEqual(view.help, [
      'Run `gerrit-axi show 184458 --comments` for the full state of what awaits you',
      'Run `gerrit-axi` for the changes in each section',
      'Not signed in: run `gerrit auth login` so inline comments and submit can reach the server',
    ]);

    // TOON, the default, is what a hook puts into a session.
    const { out: toon } = await run(['dashboard', '--ambient'], { env, exec });
    assert.match(toon, /^bin: ~\/install\/bin\/gerrit-axi\.js\n/);
    assert.match(toon, /\nsections\[5\]\{section,count\}:\n {2}your_turn,1\n/);
  } finally {
    cleanup();
  }
});

test('the ambient view never fails: an unreachable server is one line, and exit 0', async () => {
  const { exec, env, cleanup } = tempHome();
  try {
    const { code, out, err } = await run(['dashboard', '--ambient', '--json'], { env, exec, ssh: 'fail' });
    assert.equal(code, EXIT.ok);
    assert.equal(err, '');
    const view = JSON.parse(out);
    assert.equal('sections' in view, false);
    assert.match(view.help[0],
      /^Could not read your changes from gerrit\.example\.com: ssh to Gerrit failed: "Permission denied \(publickey\)\."; run `gerrit-axi` for the error and its remedy$/);
  } finally {
    cleanup();
  }
});

test('the ambient view bounds its queries well inside the hook timeout', async () => {
  const { exec, env, cleanup } = tempHome();
  try {
    /** @type {Array<{args: string[], timeoutMs?: number}>} */
    const ssh = [];
    const runner = fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      {
        match: (f) => f === 'ssh',
        result: (_f, args, opts) => {
          ssh.push({ args, timeoutMs: opts?.timeoutMs });
          return { code: 255, stderr: 'ssh: connect to host gerrit.example.com port 29418: Connection timed out\n' };
        },
      },
    ]);
    const stdout = captureStream();
    const code = await main(['dashboard', '--ambient', '--json'], {
      cwd: '/some/checkout', env, stdout: stdout.stream, stderr: captureStream().stream, runner, execPath: exec,
    });
    assert.equal(code, EXIT.ok);
    assert.match(JSON.parse(stdout.text).help[0], /^Could not read your changes from gerrit\.example\.com: /);
    assert.equal(ssh.length, 1);
    assert.ok((ssh[0].timeoutMs ?? Infinity) <= 5_000, `ssh timeout ${ssh[0].timeoutMs}ms`);
    const connect = ssh[0].args.find((a) => a.startsWith('ConnectTimeout='));
    assert.ok(Number(connect?.split('=')[1]) <= 5, String(connect));
  } finally {
    cleanup();
  }
});

test('a connection that cannot be resolved in a Gerrit checkout says why, not where to go', async () => {
  const { home, exec, env, cleanup } = tempHome();
  try {
    const config = path.join(home, '.config', 'gerrit-axi', 'config.json');
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, '{ not json');
    const { code, out, runner } = await run(['dashboard', '--ambient', '--json'], { env, exec });
    assert.equal(code, EXIT.ok);
    assert.match(JSON.parse(out).help[0],
      /^Could not resolve the Gerrit connection: invalid JSON in .*config\.json.*; run `gerrit-axi` for the error and its remedy$/);
    assert.equal(runner.calls.some((call) => call.file === 'ssh'), false);
  } finally {
    cleanup();
  }
});

test('--host alone does not make the ambient view query a server', async () => {
  const { exec, env, cleanup } = tempHome();
  try {
    const { code, out, runner } = await run(
      ['dashboard', '--ambient', '--host', 'gerrit.example.com', '--user', 'ada', '--json'],
      { env, exec, remote: null },
    );
    assert.equal(code, EXIT.ok, out);
    assert.equal(JSON.parse(out).help.length, 1);
    assert.match(JSON.parse(out).help[0], /for your review dashboard on gerrit\.example\.com$/);
    assert.equal(runner.calls.some((call) => call.file === 'ssh'), false);
  } finally {
    cleanup();
  }
});

test('outside a Gerrit checkout the ambient view asks nothing of any server', async () => {
  const { exec, env, cleanup } = tempHome();
  try {
    const none = await run(['dashboard', '--ambient', '--json'], { env, exec, remote: null });
    assert.equal(none.code, EXIT.ok);
    assert.deepEqual(JSON.parse(none.out).help,
      ['Run `gerrit-axi` in a checkout whose origin is a Gerrit remote for your review dashboard']);
    assert.equal(none.runner.calls.some((call) => call.file === 'ssh'), false);

    // A host from the environment or config file answers anywhere, so the
    // session hears where to look, but the queries wait for an explicit call.
    const elsewhere = await run(['dashboard', '--ambient', '--json'], {
      env: { ...env, GERRIT_HOST: 'gerrit.example.com' },
      exec,
      remote: null,
    });
    assert.equal(elsewhere.code, EXIT.ok);
    assert.deepEqual(JSON.parse(elsewhere.out).help,
      ['Run `gerrit-axi` for your review dashboard on gerrit.example.com']);
    assert.equal(elsewhere.runner.calls.some((call) => call.file === 'ssh'), false);

    const rows = await run(['dashboard', '--ambient', '--rows', '3', '--json'], { env, exec });
    assert.equal(rows.code, EXIT.usage);
  } finally {
    cleanup();
  }
});

test('the codex feature flag is set without disturbing the rest of config.toml', () => {
  assert.deepEqual(withCodexHooksFeature(''), ['[features]\nhooks = true\n', true]);
  assert.deepEqual(withCodexHooksFeature('[features]\nhooks = true\n'), ['[features]\nhooks = true\n', false]);
  assert.deepEqual(withCodexHooksFeature('[features]\nhooks = false # off\n'),
    ['[features]\nhooks = true # off\n', true]);
  assert.deepEqual(withCodexHooksFeature('model = "x"'), ['model = "x"\n\n[features]\nhooks = true\n', true]);
  assert.deepEqual(withCodexHooksFeature('[features]\nother = 1\n'),
    ['[features]\nother = 1\nhooks = true\n', true]);
});

test('the installable skill names every command and no command that does not exist', () => {
  const file = path.join(SRC_DIR, '..', 'skills', 'gerrit-axi', 'SKILL.md');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^---\nname: gerrit-axi\ndescription: "[^"\n]+"\n/);
  for (const name of Object.keys(COMMAND_OPTIONS)) {
    assert.ok(text.includes(`gerrit-axi ${name}`), `SKILL.md should name gerrit-axi ${name}`);
  }
  const named = new Set([...text.matchAll(/(?:^|`)gerrit-axi ([a-z]+)\b/gm)].map((m) => m[1]));
  for (const name of named) {
    assert.ok(Object.hasOwn(COMMAND_OPTIONS, name), `SKILL.md names gerrit-axi ${name}, which is no command`);
  }
});

/** @param {string} dir */
function readdir(dir) {
  return /** @type {string[]} */ (existsSync(dir) ? readdirSync(dir).sort() : []);
}
