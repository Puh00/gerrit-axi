// SPDX-License-Identifier: Apache-2.0

/**
 * REST transport.
 *
 * The REST channel exists because SSH cannot reach inline comments, and it
 * carries the submit, which needs no SSH subcommand that could also vote. Gerrit
 * answers `WWW-Authenticate: Basic realm="Gerrit Code Review"`: this is HTTP
 * Basic carrying a Gerrit authentication token, *not* an OAuth bearer token.
 *
 * Two things about Gerrit's REST API that bite everyone once:
 *   1. Every JSON body is prefixed with the XSSI guard line `)]}'`, which must be
 *      stripped before parsing.
 *   2. 401, 403 and 404 mean genuinely different things and must not collapse
 *      into one generic failure. 401 is "your credential is bad or expired" and
 *      is the only one that means "re-run auth login".
 *
 * Credentials travel in request headers of an in-process HTTP client. We never
 * shell out to curl, so they never touch a command line.
 *
 * Writes are limited to `restSubmit`, `restReady`, and `restWip`. There is no general-purpose
 * write here, so no other endpoint -- the review endpoint that records votes
 * above all -- can be reached by passing it a path.
 */

import { AuthError, TransportError } from './errors.js';

/** Gerrit's cross-site-script-inclusion guard, emitted as the first line. */
export const XSSI_PREFIX = ")]}'";

/**
 * Strip Gerrit's XSSI guard line, if present. A body without the guard is
 * returned untouched, so this is safe to apply unconditionally.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripXssiPrefix(body) {
  const text = String(body ?? '');
  if (!text.startsWith(XSSI_PREFIX)) return text;
  const newline = text.indexOf('\n', XSSI_PREFIX.length);
  return newline === -1 ? '' : text.slice(newline + 1);
}

/**
 * Strip the XSSI guard and parse.
 *
 * @template T
 * @param {string} body
 * @param {string} [what]  path or description, for the error message
 * @returns {T}
 */
export function parseGerritJson(body, what = 'response') {
  const json = stripXssiPrefix(body);
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new TransportError(`could not parse JSON from ${what}`, {
      code: 'BAD_RESPONSE',
      cause: err,
    });
  }
}

/**
 * Build the Basic credential header value.
 *
 * The returned string contains the token, so it must only ever be handed to the
 * HTTP client -- never logged, printed, or attached to an error.
 *
 * @param {string} user
 * @param {string} token
 * @returns {string}
 */
export function basicAuthHeader(user, token) {
  return `Basic ${Buffer.from(`${user}:${token}`, 'utf8').toString('base64')}`;
}

/**
 * @typedef {Object} RestTarget
 * @property {string} restBase   e.g. "https://gerrit.example.com"
 * @property {string} user
 * @property {string} token
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * The one place a request carrying the token is made. `init` supplies the method
 * and, for the submit below, a body; the credential header and the redirect
 * policy are added here and cannot be left out by a caller.
 *
 * @param {RestTarget} target
 * @param {string} apiPath   path beginning with "/a/"
 * @param {{method: string, headers?: Record<string, string>, body?: string}} init
 * @returns {Promise<{status: number, body: string, headers: Headers}>}
 */
async function authorizedFetch(target, apiPath, init) {
  const doFetch = target.fetchImpl ?? globalThis.fetch;
  const url = `${target.restBase.replace(/\/+$/, '')}${apiPath}`;
  let res;
  try {
    res = await doFetch(url, {
      ...init,
      headers: {
        ...init.headers,
        // The only place the token appears.
        Authorization: basicAuthHeader(target.user, target.token),
        Accept: 'application/json',
      },
      // Never follow a redirect while carrying an Authorization header.
      redirect: 'manual',
    });
  } catch (err) {
    throw new TransportError(`could not reach ${url}`, { code: 'HTTP_ERROR', cause: err });
  }
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/**
 * Authenticated GET returning the raw body plus status. Does not throw on HTTP
 * status; `restGetJson` applies the status policy.
 *
 * @param {RestTarget} target
 * @param {string} apiPath   path beginning with "/a/"
 * @returns {Promise<{status: number, body: string, headers: Headers}>}
 */
export function restGetRaw(target, apiPath) {
  return authorizedFetch(target, apiPath, { method: 'GET' });
}

/**
 * Authenticated GET returning parsed JSON, with 401/403/404 kept distinct.
 *
 * @template T
 * @param {RestTarget} target
 * @param {string} apiPath
 * @returns {Promise<T>}
 */
export async function restGetJson(target, apiPath) {
  const { status, body } = await restGetRaw(target, apiPath);
  assertRestOk(status, apiPath, target.restBase);
  return parseGerritJson(body, apiPath);
}

/**
 * The status policy, factored out so it is testable on its own.
 *
 * @param {number} status
 * @param {string} apiPath
 * @param {string} restBase
 */
export function assertRestOk(status, apiPath, restBase = '') {
  if (status >= 200 && status < 300) return;
  const host = restBase.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  switch (status) {
    case 401:
      throw new AuthError('Gerrit rejected the stored credential (HTTP 401)', {
        code: 'UNAUTHORIZED',
        remedy: [
          `The token is wrong, expired, or revoked. Generate a new one at`,
          `    https://${host}/settings/#HTTPCredentials`,
          'then run: gerrit auth login',
        ].join('\n'),
      });
    case 403:
      throw new TransportError(`not permitted to read ${apiPath} (HTTP 403)`, {
        code: 'FORBIDDEN',
        remedy: 'The credential authenticated, but this account lacks access to that resource.',
      });
    case 404:
      throw new TransportError(`no such resource: ${apiPath} (HTTP 404)`, {
        code: 'NOT_FOUND',
        remedy: 'Check the change number; a change you cannot see also reads as 404.',
      });
    default:
      if (status >= 300 && status < 400) {
        throw new TransportError(`unexpected redirect (HTTP ${status}) for ${apiPath}`, {
          code: 'HTTP_ERROR',
          remedy: 'The REST base URL may be wrong; set "restBase" in the config file.',
        });
      }
      throw new TransportError(`unexpected HTTP ${status} for ${apiPath}`, { code: 'HTTP_ERROR' });
  }
}

/**
 * Ask the server to submit a change.
 *
 * Whether the change may be submitted is not decided here. Gerrit evaluates its
 * submit rules on the server at the moment of the request and refuses, with HTTP
 * 409, a change the votes do not support; that refusal is the safety property, so
 * it is passed back in the server's own words rather than summarised. A 403 is
 * the account lacking the permission to submit at all, and is reported the same
 * way. Everything else follows the status policy above.
 *
 * @param {RestTarget} target
 * @param {number|string} change   change number
 * @returns {Promise<any>} the server's ChangeInfo for the submitted change
 */
export async function restSubmit(target, change) {
  const apiPath = `/a/changes/${encodeURIComponent(String(change))}/submit`;
  const { status, body } = await authorizedFetch(target, apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{}',
  });
  if (status === 409 || status === 403) {
    const said = stripXssiPrefix(body).trim() || `HTTP ${status}`;
    throw new TransportError(`Gerrit refused to submit change ${change}: ${said}`, {
      code: status === 409 ? 'SUBMIT_REFUSED' : 'FORBIDDEN',
    });
  }
  assertRestOk(status, apiPath, target.restBase);
  return parseGerritJson(body, apiPath);
}

/**
 * @typedef {Object} AccountInfo
 * @property {number|null} accountId
 * @property {string|null} name
 * @property {string|null} email
 * @property {string|null} username
 */

/**
 * Authenticate a token against `/a/accounts/self`.
 *
 * This is the "verify before persisting" step: `auth login` calls it before any
 * token reaches storage, so an unverified secret is never written to disk.
 *
 * @param {RestTarget} target
 * @returns {Promise<AccountInfo>}
 */
export async function verifyToken(target) {
  /** @type {any} */
  const account = await restGetJson(target, '/a/accounts/self');
  return {
    accountId: account._account_id ?? null,
    name: account.name ?? null,
    email: account.email ?? null,
    username: account.username ?? null,
  };
}

/** Activate an existing change. No caller-supplied body or endpoint.
 * @param {RestTarget} target
 * @param {number} change
 */
export function restReady(target, change) {
  return restWipState(target, change, false);
}

/** Mark an existing change work in progress. No caller-supplied body or endpoint.
 * @param {RestTarget} target
 * @param {number} change
 */
export function restWip(target, change) {
  return restWipState(target, change, true);
}

/**
 * @param {RestTarget} target
 * @param {number} change
 * @param {boolean} wip
 */
async function restWipState(target, change, wip) {
  if (!Number.isSafeInteger(change) || change <= 0) {
    throw new TransportError('state changes need a positive change number', { code: 'BAD_RESPONSE' });
  }
  const op = wip ? 'wip' : 'ready';
  const apiPath = `/a/changes/${change}/${op}`;
  const { status, body } = await authorizedFetch(target, apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{}',
  });
  if (status === 409 || status === 403) {
    const said = stripXssiPrefix(body).trim() || `HTTP ${status}`;
    throw new TransportError(`Gerrit refused to set ${op} state on change ${change}: ${said}`, {
      code: status === 403 ? 'FORBIDDEN' : wip ? 'WIP_REFUSED' : 'READY_REFUSED',
    });
  }
  assertRestOk(status, apiPath, target.restBase);
  // These endpoints return an empty success body. State is verified by readback.
}
