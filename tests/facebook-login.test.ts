import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager, type BrowserSessionOptions } from '../src/browser.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import {
  FACEBOOK_LOGIN_WAIT_DEFAULT_MS,
  FacebookCredentialLogin,
  facebookCredentialsFromEnv
} from '../src/facebook-login.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { ProviderError } from '../src/backend.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

/**
 * A real Chromium launch plus the login wait window runs well past vitest's 5s default, so every
 * test in this file carries an explicit timeout rather than relying on the runner default.
 */
const itWithTimeout = (name: string, body: () => void | Promise<void>): void => {
  it(name, body, 30_000);
};

/** The path the reference implementation navigates to. */
const LOGIN_PATH = '/login/device-based/regular/login/';

/** Distinctive values so a leak assertion cannot pass by accident. */
const USERNAME_SENTINEL = 'USER-SENTINEL-1234';
const PASSWORD_SENTINEL = 'PASS-SENTINEL-5678';

const APPROVAL_DELAY_MS = 400;
const POLL_INTERVAL_MS = 100;
const TEST_WAIT_MS = 3_000;

type LoginMode = 'authenticated' | 'login-required' | 'approve-after-submit' | 'never-approves' | 'captcha-after-submit' | 'checkpoint-after-submit';

interface SyntheticLoginServer {
  server: Server;
  origin: string;
  requests: string[];
  /** Raw request URLs of every form submission, in order. */
  submissions: string[];
  setMode(mode: LoginMode): void;
  close(): Promise<void>;
}

const profileDirs: string[] = [];
const managers: BrowserSessionManager[] = [];
const servers: SyntheticLoginServer[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe('facebookCredentialsFromEnv', () => {
  itWithTimeout('reads a complete pair', () => {
    expect(facebookCredentialsFromEnv({ FACEBOOK_USERNAME: 'someone', FACEBOOK_PASSWORD: 'secret' }))
      .toEqual({ username: 'someone', password: 'secret' });
  });

  itWithTimeout('treats both-unset and both-blank as no credentials', () => {
    expect(facebookCredentialsFromEnv({})).toBeUndefined();
    expect(facebookCredentialsFromEnv({ FACEBOOK_USERNAME: '  ', FACEBOOK_PASSWORD: '\t' })).toBeUndefined();
  });

  itWithTimeout('rejects a half-configured pair rather than silently skipping the login', () => {
    expect(() => facebookCredentialsFromEnv({ FACEBOOK_USERNAME: 'someone' })).toThrow(TypeError);
    expect(() => facebookCredentialsFromEnv({ FACEBOOK_PASSWORD: 'secret' })).toThrow(TypeError);
  });

  itWithTimeout('defaults the wait window to three minutes and validates options', () => {
    expect(FACEBOOK_LOGIN_WAIT_DEFAULT_MS).toBe(180_000);
    const manager = new BrowserSessionManager({ profileDir: mkdtempSync(join(tmpdir(), 'marketplace-login-ctor-')), logger: { error: () => undefined } });
    expect(() => new FacebookCredentialLogin({ browser: manager, username: '', password: 'x' })).toThrow(TypeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: '' })).toThrow(TypeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', waitMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', baseUrl: 'https://evil.example' })).toThrow(TypeError);
    void manager.close();
  });
});

describe.skipIf(!browserAvailable)('Facebook credential login', () => {
  itWithTimeout('skips the credential login entirely when the profile is already authenticated', async () => {
    const { manager, login, server } = await harness('authenticated');
    server.setMode('authenticated');

    const probe = new FacebookSessionProbe({ browser: manager, baseUrl: server.origin, navigationTimeoutMs: 2_000, settleTimeoutMs: 150 });
    await expect(probe.probeSession(new AbortController().signal)).resolves.toMatchObject({ status: 'session_usable' });

    // The backend only reaches for credentials on a plain login requirement, so a usable session
    // must go straight to the search. The fixture page carries no listing cards, so the search
    // itself fails on the page layout -- what matters here is that it never touched the login.
    const backend = new FacebookMarketplaceBackend({ browser: manager, probe, login, logger: { error: () => undefined } });
    await expect(backend.search({ query: 'bike', location: 'NYC', limit: 5 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    expect(server.submissions).toEqual([]);
    expect(server.requests).not.toContain(LOGIN_PATH);
  });

  itWithTimeout('fills and submits the credentials when the session requires a login', async () => {
    const { manager, login, server } = await harness('never-approves');

    const result = await login.attempt(new AbortController().signal);

    expect(server.submissions).toHaveLength(1);
    const submitted = new URL(server.submissions[0]!, server.origin);
    expect(submitted.searchParams.get('email')).toBe(USERNAME_SENTINEL);
    expect(submitted.searchParams.get('pass')).toBe(PASSWORD_SENTINEL);
    // The approval never arrives, so the attempt must fail closed rather than report success.
    expect(result).toEqual({ outcome: 'timeout', code: 'LOGIN_REQUIRED' });
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  itWithTimeout('transitions to session_usable once the login is approved out of band', async () => {
    const { manager, login, server } = await harness('approve-after-submit');

    await expect(login.attempt(new AbortController().signal)).resolves.toEqual({ outcome: 'authenticated' });
    expect(manager.getInfo().status).toBe('session_usable');
    expect(server.submissions).toHaveLength(1);

    // The authenticated profile is what makes the next search skip the login.
    const probe = new FacebookSessionProbe({ browser: manager, baseUrl: server.origin, navigationTimeoutMs: 2_000, settleTimeoutMs: 150 });
    await expect(probe.probeSession(new AbortController().signal)).resolves.toMatchObject({ status: 'session_usable' });
  });

  itWithTimeout('leaves the session safely unauthenticated when the wait window expires', async () => {
    const { manager, login } = await harness('never-approves');

    await expect(login.attempt(new AbortController().signal)).resolves.toEqual({ outcome: 'timeout', code: 'LOGIN_REQUIRED' });
    expect(manager.getInfo().status).toBe('session_unknown');
    expect(manager.getInfo().status).not.toBe('session_usable');
  });

  itWithTimeout('hands a captcha back to manual re-auth instead of resubmitting credentials', async () => {
    const { manager, login, server } = await harness('captcha-after-submit');

    const result = await login.attempt(new AbortController().signal);

    expect(result).toEqual({ outcome: 'challenge', code: 'CAPTCHA_REQUIRED' });
    // Exactly one submission: a challenge must never trigger a retry loop.
    expect(server.submissions).toHaveLength(1);
    expect(manager.getInfo().status).toBe('session_needs_reauth');
  });

  itWithTimeout('reports a checkpoint as a challenge once the window closes, without resubmitting', async () => {
    const { manager, login, server } = await harness('checkpoint-after-submit');

    const result = await login.attempt(new AbortController().signal);

    expect(result).toEqual({ outcome: 'challenge', code: 'SESSION_INVALID' });
    expect(server.submissions).toHaveLength(1);
    expect(manager.getInfo().status).toBe('session_needs_reauth');
  });

  itWithTimeout('never puts the credentials in a log, an error, or a result', async () => {
    const logged: string[] = [];
    const { manager, login, server } = await harness('captcha-after-submit', {
      error: (...args: unknown[]) => { logged.push(args.map((value) => String(value)).join(' ')); }
    });

    const result = await login.attempt(new AbortController().signal);

    // The backend error is the string that reaches a caller, so assert on it too.
    const probe = new FacebookSessionProbe({ browser: manager, baseUrl: server.origin, navigationTimeoutMs: 2_000, settleTimeoutMs: 150 });
    const backend = new FacebookMarketplaceBackend({ browser: manager, probe, login, logger: { error: () => undefined } });
    const failure = await backend.search({ query: 'bike', location: 'NYC', limit: 5 }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error as ProviderError);

    const surfaces = [JSON.stringify(result), ...logged, failure?.message ?? '', JSON.stringify(failure ?? {})].join('\n');
    expect(surfaces).not.toContain(USERNAME_SENTINEL);
    expect(surfaces).not.toContain(PASSWORD_SENTINEL);
  });
});

async function harness(
  mode: LoginMode,
  logger: Pick<Console, 'error'> = { error: () => undefined }
): Promise<{ manager: BrowserSessionManager; login: FacebookCredentialLogin; server: SyntheticLoginServer }> {
  const server = await startLoginServer();
  servers.push(server);
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-login-test-'));
  profileDirs.push(parent);
  const manager = new BrowserSessionManager({
    profileDir: join(parent, 'profile'),
    logger: { error: () => undefined }
  });
  managers.push(manager);
  server.setMode(mode);
  const login = new FacebookCredentialLogin({
    browser: manager,
    username: USERNAME_SENTINEL,
    password: PASSWORD_SENTINEL,
    baseUrl: server.origin,
    waitMs: TEST_WAIT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    navigationTimeoutMs: 2_000,
    logger
  });
  return { manager, login, server };
}

async function startLoginServer(): Promise<SyntheticLoginServer> {
  const requests: string[] = [];
  const submissions: string[] = [];
  let mode: LoginMode = 'authenticated';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);

    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/login/submit/') {
      submissions.push(request.url ?? '');
      const redirect = (location: string): void => {
        response.writeHead(302, { location });
        response.end();
      };
      if (mode === 'approve-after-submit') {
        // Hold the navigation briefly, standing in for the operator approving on their phone.
        setTimeout(() => redirect('/marketplace/'), APPROVAL_DELAY_MS);
        return;
      }
      if (mode === 'captcha-after-submit') {
        redirect('/captcha/');
        return;
      }
      if (mode === 'checkpoint-after-submit') {
        redirect('/checkpoint/');
        return;
      }
      redirect(LOGIN_PATH);
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === LOGIN_PATH) {
      response.end(loginFormPage());
      return;
    }
    if (url.pathname === '/captcha/') {
      response.end('<!doctype html><html><body><iframe src="/captcha/challenge"></iframe><p>Please complete the captcha to continue.</p></body></html>');
      return;
    }
    if (url.pathname === '/checkpoint/') {
      response.end('<!doctype html><html><body><form action="/checkpoint/"></form><p>We detected unusual activity. Please confirm your identity.</p></body></html>');
      return;
    }
    if (url.pathname.startsWith('/marketplace/')) {
      response.end(mode === 'login-required' ? loginFormPage() : authenticatedPage());
      return;
    }
    response.end(authenticatedPage());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    submissions,
    setMode: (nextMode) => { mode = nextMode; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function loginFormPage(): string {
  return [
    '<!doctype html><html><body><form action="/login/submit/" method="get">',
    '<input type="text" name="email" aria-label="Email address">',
    '<input type="password" name="pass" aria-label="Password">',
    // Facebook no longer renders a button named "login", but Enter only submits a form that has a
    // submit control, so the fixture keeps one.
    '<button type="submit">Log in</button>',
    '</form></body></html>'
  ].join('');
}

function authenticatedPage(): string {
  return '<!doctype html><html><body><header><div aria-label="Your account"></div></header><main><h1>Marketplace</h1><a href="/marketplace/category/1">Cars</a></main></body></html>';
}
