import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { FACEBOOK_ORIGIN, FacebookSessionProbe } from '../src/facebook.js';
import {
  FACEBOOK_LOGIN_WAIT_DEFAULT_MS,
  FacebookCredentialLogin,
  facebookCredentialsFromEnv
} from '../src/facebook-login.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { ProviderError } from '../src/backend.js';
import { runBackendOperation } from '../src/tools.js';

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

type LoginMode =
  | 'authenticated'
  | 'login-required'
  | 'approve-after-submit'
  | 'approve-home-after-submit'
  | 'deadline-then-approve'
  | 'never-approves'
  | 'captcha-after-submit'
  | 'checkpoint-after-submit'
  /** Serves a login form with no email field, forcing the fill step to time out. */
  | 'missing-email';

interface SyntheticLoginServer {
  server: Server;
  origin: string;
  requests: string[];
  /** Raw request bodies of every form submission, in order. */
  submissions: string[];
  setMode(mode: LoginMode): void;
  setApprovalDelay(milliseconds: number): void;
  setApprovalPage(path: '/' | '/marketplace/'): void;
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
    const manager = createManager();
    expect(() => new FacebookCredentialLogin({ browser: manager, username: '', password: 'x' })).toThrow(TypeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: '' })).toThrow(TypeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', waitMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', pollIntervalMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', typingDelayMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', consentTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', consentSettleMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', baseUrl: 'https://evil.example' })).toThrow(TypeError);
    expect(() => new FacebookCredentialLogin({ browser: manager, username: 'x', password: 'y', loginPath: 'https://evil.example/login' })).toThrow(TypeError);
  });

  itWithTimeout('does not expose the credentials when the login object is serialized', () => {
    const login = new FacebookCredentialLogin({
      browser: createManager(),
      username: USERNAME_SENTINEL,
      password: PASSWORD_SENTINEL
    });

    const serialized = JSON.stringify(login);
    expect(serialized).not.toContain(USERNAME_SENTINEL);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
  });

  itWithTimeout('rejects a login path that escapes a production base to a loopback origin', () => {
    // assertFacebookOrigin accepts either Facebook or any loopback host, so it alone would let the
    // credential sink be pointed at loopback from a production base. The login must be same-origin.
    expect(() => new FacebookCredentialLogin({
      browser: createManager(),
      username: USERNAME_SENTINEL,
      password: PASSWORD_SENTINEL,
      baseUrl: FACEBOOK_ORIGIN,
      loginPath: 'http://127.0.0.1:12345/login'
    })).toThrow(TypeError);
  });

  itWithTimeout('rejects a login path on a different loopback port than the base', () => {
    expect(() => new FacebookCredentialLogin({
      browser: createManager(),
      username: USERNAME_SENTINEL,
      password: PASSWORD_SENTINEL,
      baseUrl: 'http://127.0.0.1:1111',
      loginPath: 'http://127.0.0.1:2222/login'
    })).toThrow(TypeError);
  });
});

/**
 * A browser manager that hands the task a scripted page instead of launching Chromium, so a
 * submission failure can be reproduced exactly -- including one whose message quotes the typed
 * value, which is the only realistic route for a credential to reach a surface.
 */
class ScriptedPageBrowser extends BrowserSessionManager {
  constructor(private readonly scriptedPage: Page) {
    super({ profileDir: mkdtempSync(join(tmpdir(), 'marketplace-login-scripted-')), logger: { error: () => undefined } });
  }

  override runExclusive<T>(signal: AbortSignal, task: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(this.scriptedPage, signal);
  }
}

describe('Facebook credential login submission failures', () => {
  itWithTimeout('sanitizes a fill failure whose message quotes the typed value', async () => {
    // Playwright's pressSequentially timeout message echoes the text it was typing, which is the
    // concrete way a credential could escape. Nothing else in this suite can produce that message,
    // so this is the test that actually pins the redaction.
    const leaking = `locator.pressSequentially: Timeout 1000ms exceeded. Call log: elementHandle.type("${USERNAME_SENTINEL}")`;
    const scriptedPage = {
      goto: async () => undefined,
      getByRole: () => ({ first: () => ({ click: async () => { throw new Error('no consent banner'); } }) }),
      locator: () => ({
        waitFor: async () => undefined,
        pressSequentially: async () => { throw new Error(leaking); }
      }),
      keyboard: { press: async () => undefined }
    } as unknown as Page;

    const logged: string[] = [];
    const login = new FacebookCredentialLogin({
      browser: new ScriptedPageBrowser(scriptedPage),
      username: USERNAME_SENTINEL,
      password: PASSWORD_SENTINEL,
      logger: { error: (...args: unknown[]) => { logged.push(args.map((value) => String(value)).join(' ')); } }
    });

    const failure = await login.attempt(new AbortController().signal)
      .then(() => undefined, (error: unknown) => error as ProviderError);

    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure?.code).toBe('LOGIN_REQUIRED');
    const surfaces = [failure?.message ?? '', ...logged].join('\n');
    expect(surfaces).not.toContain(USERNAME_SENTINEL);
    expect(surfaces).not.toContain(PASSWORD_SENTINEL);
  });
});

describe.skipIf(!browserAvailable)('Facebook credential login', () => {
  itWithTimeout('keeps the credential login alive after the search deadline expires', async () => {
    // Timings are test-scaled but keep the invariant relationships: the approval (2.5s after
    // submit) lands after the search deadline (1.5s), and the post-timeout sleep lands after the
    // approval yet inside the login's 4s wait window, so the login is still the same in-flight
    // attempt when the approval arrives.
    const { manager, login, server } = await harness('deadline-then-approve', undefined, {
      username: 'u',
      password: 'p',
      waitMs: 4_000
    });
    server.setApprovalDelay(2_500);
    server.setApprovalPage('/');
    const probe = new FacebookSessionProbe({ browser: manager, baseUrl: server.origin, navigationTimeoutMs: 2_000, settleTimeoutMs: 150 });
    const backend = new FacebookMarketplaceBackend({ browser: manager, probe, login, logger: { error: () => undefined } });
    const operation = runBackendOperation(
      (signal) => backend.search({ query: 'bike', location: 'NYC', limit: 5 }, signal),
      1_500,
      new AbortController().signal
    );

    // The search overruns its own backend deadline, so the existing contract surfaces TIMEOUT.
    // What matters is that the in-flight login is not cancelled along with it.
    await expect(operation).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(server.submissions).toHaveLength(1);
    expect(manager.getInfo().status).not.toBe('session_usable');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await expect(probe.probeSession(new AbortController().signal)).resolves.toMatchObject({ status: 'session_usable' });
    expect(server.submissions).toHaveLength(1);
    await backend.close();
  });

  itWithTimeout('skips the credential login entirely when the profile is already authenticated', async () => {
    const { manager, login, server } = await harness('authenticated');

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
    const submitted = new URLSearchParams(server.submissions[0]!);
    expect(submitted.get('email')).toBe(USERNAME_SENTINEL);
    expect(submitted.get('pass')).toBe(PASSWORD_SENTINEL);
    // The approval never arrives, so the attempt must fail closed rather than report success.
    expect(result).toEqual({ outcome: 'timeout', code: 'LOGIN_REQUIRED' });
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  itWithTimeout('transitions to session_usable once the login is approved out of band', async () => {
    const { manager, login, server } = await harness('approve-after-submit');

    await expect(login.attempt(new AbortController().signal)).resolves.toEqual({ outcome: 'authenticated' });
    expect(manager.getInfo().status).toBe('session_unknown');
    expect(server.submissions).toHaveLength(1);

    // The authenticated profile is what makes the next probe verify the login.
    const probe = new FacebookSessionProbe({ browser: manager, baseUrl: server.origin, navigationTimeoutMs: 2_000, settleTimeoutMs: 150 });
    await expect(probe.probeSession(new AbortController().signal)).resolves.toMatchObject({ status: 'session_usable' });
  });

  itWithTimeout('navigates to Marketplace when approval lands on the authenticated home page', async () => {
    const { manager, login, server } = await harness('approve-home-after-submit');

    await expect(login.attempt(new AbortController().signal)).resolves.toEqual({ outcome: 'authenticated' });
    expect(server.requests).toContain('/');
    expect(server.requests).toContain('/marketplace/');
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  itWithTimeout('preserves whitespace in the submitted password exactly', async () => {
    const server = await startLoginServer();
    servers.push(server);
    server.setMode('never-approves');
    const manager = createManager();
    const password = '  opaque password  ';
    const login = new FacebookCredentialLogin({
      browser: manager,
      username: USERNAME_SENTINEL,
      password,
      baseUrl: server.origin,
      waitMs: 200,
      pollIntervalMs: 20,
      navigationTimeoutMs: 2_000,
      typingDelayMs: 1,
      consentTimeoutMs: 50,
      consentSettleMs: 50,
      logger: { error: () => undefined }
    });

    await login.attempt(new AbortController().signal);
    const submitted = new URLSearchParams(server.submissions[0]!);
    expect(submitted.get('pass')).toBe(password);
  });

  itWithTimeout('leaves the session safely unauthenticated when the wait window expires', async () => {
    const { manager, login } = await harness('never-approves');

    await expect(login.attempt(new AbortController().signal)).resolves.toEqual({ outcome: 'timeout', code: 'LOGIN_REQUIRED' });
    expect(manager.getInfo().status).toBe('session_unknown');
    expect(manager.getInfo().status).not.toBe('session_usable');
  });

  itWithTimeout('fails closed when the attempt is aborted mid-wait', async () => {
    const { manager, login } = await harness('never-approves');

    const controller = new AbortController();
    const attempt = login.attempt(controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    controller.abort();

    await expect(attempt).rejects.toBeDefined();
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

  itWithTimeout('does not leak the credentials when the login form cannot be filled', async () => {
    const logged: string[] = [];
    const { manager, login } = await harness('missing-email', {
      error: (...args: unknown[]) => { logged.push(args.map((value) => String(value)).join(' ')); }
    });

    // No email field ever appears, so the fill step times out and the catch block runs. This covers
    // the realistic shape of a fill failure failing closed; the redaction itself is pinned by the
    // scripted-page test, the only one that can produce a message quoting the typed value.
    const failure = await login.attempt(new AbortController().signal)
      .then(() => undefined, (error: unknown) => error as ProviderError);

    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure?.code).toBe('LOGIN_REQUIRED');
    const surfaces = [failure?.message ?? '', ...logged].join('\n');
    expect(surfaces).not.toContain(USERNAME_SENTINEL);
    expect(surfaces).not.toContain(PASSWORD_SENTINEL);
    expect(manager.getInfo().status).not.toBe('session_usable');
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

function createManager(): BrowserSessionManager {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-login-test-'));
  profileDirs.push(parent);
  const manager = new BrowserSessionManager({
    profileDir: join(parent, 'profile'),
    logger: { error: () => undefined }
  });
  managers.push(manager);
  return manager;
}

async function harness(
  mode: LoginMode,
  logger: Pick<Console, 'error'> = { error: () => undefined },
  credentials: { username: string; password: string; waitMs?: number } = {
    username: USERNAME_SENTINEL,
    password: PASSWORD_SENTINEL
  }
): Promise<{ manager: BrowserSessionManager; login: FacebookCredentialLogin; server: SyntheticLoginServer }> {
  const server = await startLoginServer();
  servers.push(server);
  const manager = createManager();
  server.setMode(mode);
  const login = new FacebookCredentialLogin({
    browser: manager,
    username: credentials.username,
    password: credentials.password,
    baseUrl: server.origin,
    waitMs: credentials.waitMs ?? TEST_WAIT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    navigationTimeoutMs: 2_000,
    // Test-only timing overrides: instant typing and a token consent window. Production defaults
    // stay untouched; see the option docs in facebook-login.ts.
    typingDelayMs: 1,
    consentTimeoutMs: 50,
    consentSettleMs: 50,
    logger
  });
  return { manager, login, server };
}

async function startLoginServer(): Promise<SyntheticLoginServer> {
  const requests: string[] = [];
  const submissions: string[] = [];
  let mode: LoginMode = 'authenticated';
  let approved = true;
  let approvalDelayMs = APPROVAL_DELAY_MS;
  let approvalPath: '/' | '/marketplace/' = '/marketplace/';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);

    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/login/submit/') {
      // The real form posts; collecting the body keeps the credentials out of the request URL.
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        submissions.push(Buffer.concat(chunks).toString('utf8'));
        const redirect = (location: string): void => {
          response.writeHead(302, { location });
          response.end();
        };
        if (mode === 'approve-after-submit' || mode === 'approve-home-after-submit' || mode === 'deadline-then-approve') {
          approved = false;
          // Hold the navigation briefly, standing in for the operator approving on their phone.
          setTimeout(() => {
            approved = true;
            redirect(mode === 'approve-home-after-submit' ? '/' : approvalPath);
          }, approvalDelayMs);
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
      });
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === LOGIN_PATH) {
      response.end(mode === 'missing-email' ? loginFormWithoutEmailPage() : loginFormPage());
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
      response.end(mode === 'login-required' || !approved ? loginFormPage() : authenticatedPage());
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
    setMode: (nextMode) => { mode = nextMode; approved = nextMode === 'authenticated'; },
    setApprovalDelay: (milliseconds) => { approvalDelayMs = milliseconds; },
    setApprovalPage: (path) => { approvalPath = path; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function loginFormPage(): string {
  return [
    '<!doctype html><html><body><form action="/login/submit/" method="post">',
    '<input type="text" name="email" aria-label="Email address">',
    '<input type="password" name="pass" aria-label="Password">',
    // Facebook no longer renders a button named "login", but Enter only submits a form that has a
    // submit control, so the fixture keeps one.
    '<button type="submit">Log in</button>',
    '</form></body></html>'
  ].join('');
}

/** A password field with no email field: the fill step cannot complete. */
function loginFormWithoutEmailPage(): string {
  return [
    '<!doctype html><html><body><form action="/login/submit/" method="post">',
    '<input type="password" name="pass" aria-label="Password">',
    '<button type="submit">Log in</button>',
    '</form></body></html>'
  ].join('');
}

function authenticatedPage(): string {
  return '<!doctype html><html><body><header><div aria-label="Your account"></div></header><main><h1>Marketplace</h1><a href="/marketplace/category/1">Cars</a></main></body></html>';
}
