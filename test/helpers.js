// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers.
 *
 * Every test in this directory runs offline. Nothing here opens a socket, and
 * nothing here contacts a Gerrit server: the HTTP client and the subprocess
 * runner are both parameters of the core API, so tests supply recorded fixtures
 * instead. Any token-shaped string below is a placeholder, not a credential.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Not a credential. Used only to satisfy the shape of an authenticated call. */
export const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-token';

/**
 * @param {string} name
 * @returns {string}
 */
export function fixture(name) {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/**
 * @param {string} name
 * @returns {any}
 */
export function fixtureJson(name) {
  return JSON.parse(fixture(name));
}

/**
 * A `Runner` that answers from a table of expectations instead of spawning
 * anything. Unmatched commands fail loudly, so a test can never accidentally
 * shell out for real. A route's result may be a function of the call, for a
 * command whose answer depends on its input.
 *
 * @typedef {{code?: number, stdout?: string, stderr?: string}} FakeResult
 * @param {Array<{match: (file: string, args: string[]) => boolean,
 *                result: FakeResult | ((file: string, args: string[],
 *                                       opts: {input?: string, env?: NodeJS.ProcessEnv}) => FakeResult)}>} routes
 */
export function fakeRunner(routes) {
  /** @type {Array<{file: string, args: string[], input?: string, env?: NodeJS.ProcessEnv}>} */
  const calls = [];
  /** @type {import('../src/core/exec.js').Runner} */
  const runner = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input, env: opts.env });
    const route = routes.find((r) => r.match(file, args));
    if (!route) throw new Error(`fakeRunner: unexpected command: ${file} ${args.join(' ')}`);
    const result = typeof route.result === 'function' ? route.result(file, args, opts) : route.result;
    return { code: result.code === undefined ? 0 : result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return Object.assign(runner, { calls });
}

/**
 * A `fetch` that answers from a table instead of using the network.
 *
 * @param {Array<{path: string|RegExp, status?: number, body?: string,
 *                headers?: Record<string, string>}>} routes
 */
export function fakeFetch(routes) {
  /** @type {Array<{url: string, method: string|undefined, headers: Record<string, string>,
   *                 body: string|undefined, redirect: string|undefined}>} */
  const calls = [];
  /** @type {any} */
  const impl = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}));
    calls.push({ url: String(url), method: init.method, headers, body: init.body, redirect: init.redirect });
    const route = routes.find((r) => (
      typeof r.path === 'string' ? String(url).endsWith(r.path) : r.path.test(String(url))
    ));
    if (!route) throw new Error(`fakeFetch: unexpected URL: ${url}`);
    return {
      status: route.status ?? 200,
      headers: new Map(Object.entries(route.headers ?? {})),
      text: async () => route.body ?? '',
    };
  };
  return Object.assign(impl, { calls });
}

/** Collects lines written by the CLI. */
export function captureStream() {
  /** @type {string[]} */
  const chunks = [];
  return {
    chunks,
    get text() { return chunks.join(''); },
    get lines() { return chunks.join('').split('\n'); },
    /** @type {any} */
    stream: {
      isTTY: false,
      columns: 120,
      write: (/** @type {string} */ s) => { chunks.push(s); return true; },
    },
  };
}
