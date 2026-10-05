import type { Page } from 'playwright';
import { BrowserSessionManager, sleepUntilAbort } from './browser.js';
import { ProviderError } from './backend.js';
import {
  FACEBOOK_ORIGIN,
  classifyFacebookSession,
  normalizeFacebookBaseUrl,
  readFacebookPage,
  type FacebookProbeCode,
  type FacebookSessionProbeResult
} from './facebook.js';

/**
 * Facebook's regular web login. The reference implementation we replace
 * (`BoPeng/ai-marketplace-monitor`) navigates here directly rather than relying on the
 * redirect from a logged-out Marketplace page.
 */
export const FACEBOOK_LOGIN_PATH = '/login/device-based/regular/login/';

/** Long enough to notice the prompt and approve it from the Facebook mobile app. */
export const FACEBOOK_LOGIN_WAIT_DEFAULT_MS = 180_000;
export const FACEBOOK_LOGIN_POLL_DEFAULT_MS = 2_000;

const EMAIL_SELECTOR = 'input[name="email"]';
const PASSWORD_SELECTOR = 'input[name="pass"]';
const CONSENT_BUTTON_PATTERN = /allow all cookies|allow cookies|accept all/i;

/**
 * Typed at a human cadence rather than filled in one shot. The reference implementation does the
 * same, and an instantaneous fill is a plausible cause of an anti-bot challenge.
 */
const TYPING_DELAY_MS = 250;

/** The consent banner is best-effort: it must never be the reason a login fails. */
const CONSENT_TIMEOUT_MS = 2_000;
const CONSENT_SETTLE_MS = 2_000;

export type FacebookLoginOutcome = 'authenticated' | 'challenge' | 'timeout' | 'ambiguous';

export interface FacebookLoginResult {
  outcome: FacebookLoginOutcome;
  code?: FacebookProbeCode;
}

export interface FacebookCredentialLoginOptions {
  browser: BrowserSessionManager;
  username: string;
  password: string;
  baseUrl?: string;
  loginPath?: string;
  waitMs?: number;
  pollIntervalMs?: number;
  navigationTimeoutMs?: number;
  logger?: Pick<Console, 'error'>;
}

export interface FacebookCredentials {
  username: string;
  password: string;
}

/**
 * Reads optional credentials from the environment. Credentials are env-only: they are never
 * persisted, returned, or logged by this service.
 *
 * A half-configured pair is a misconfiguration rather than a silent no-op, so it fails loudly at
 * startup instead of leaving an operator wondering why the login never runs.
 */
export function facebookCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): FacebookCredentials | undefined {
  const username = readCredential(env.FACEBOOK_USERNAME);
  const password = readCredential(env.FACEBOOK_PASSWORD);
  if (username === undefined && password === undefined) return undefined;
  if (username === undefined || password === undefined) {
    throw new TypeError('FACEBOOK_USERNAME and FACEBOOK_PASSWORD must be set together');
  }
  return { username, password };
}

/**
 * Submits optional credentials to Facebook's login form and waits for the out-of-band approval on
 * the operator's phone to land, polling the same page classification the session probe uses.
 *
 * This does not replace the probe: the caller probes first and only reaches here when the session
 * is specifically reported as needing a login. CAPTCHA and checkpoint states are never solved or
 * bypassed here -- they are reported back so the existing manual re-auth flow can take over.
 */
export class FacebookCredentialLogin {
  readonly baseUrl: string;
  readonly loginUrl: string;
  private readonly browser: BrowserSessionManager;
  private readonly username: string;
  private readonly password: string;
  private readonly waitMs: number;
  private readonly pollIntervalMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly logger: Pick<Console, 'error'>;

  constructor(options: FacebookCredentialLoginOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    if (!(options.browser instanceof BrowserSessionManager)) {
      throw new TypeError('options.browser must be a BrowserSessionManager');
    }
    if (typeof options.username !== 'string' || !options.username.trim()) {
      throw new TypeError('options.username must be a non-empty string');
    }
    if (typeof options.password !== 'string' || !options.password) {
      throw new TypeError('options.password must be a non-empty string');
    }

    this.browser = options.browser;
    this.baseUrl = normalizeFacebookBaseUrl(options.baseUrl ?? FACEBOOK_ORIGIN);
    this.loginUrl = new URL(options.loginPath ?? FACEBOOK_LOGIN_PATH, this.baseUrl).href;
    this.username = options.username;
    this.password = options.password;
    this.waitMs = options.waitMs ?? FACEBOOK_LOGIN_WAIT_DEFAULT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? FACEBOOK_LOGIN_POLL_DEFAULT_MS;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 15_000;
    this.logger = options.logger ?? console;

    validateTimeout(this.waitMs, 'waitMs');
    validateTimeout(this.pollIntervalMs, 'pollIntervalMs');
    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
  }

  async attempt(signal: AbortSignal): Promise<FacebookLoginResult> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));
    // One acquisition for the whole attempt: runExclusive is not re-entrant, so the fill and the
    // wait must share the page rather than nesting a second acquisition inside this one.
    return this.browser.runExclusive(signal, (page, taskSignal) => this.submitAndWait(page, taskSignal));
  }

  private async submitAndWait(page: Page, signal: AbortSignal): Promise<FacebookLoginResult> {
    await page.goto(this.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
      signal
    });

    await dismissConsentBanner(page, signal);
    await this.submitCredentials(page, signal);
    return this.waitForUsableSession(page, signal);
  }

  private async submitCredentials(page: Page, signal: AbortSignal): Promise<void> {
    try {
      const email = page.locator(EMAIL_SELECTOR);
      await email.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      await email.pressSequentially(this.username, { delay: TYPING_DELAY_MS });

      const password = page.locator(PASSWORD_SELECTOR);
      await password.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      await password.pressSequentially(this.password, { delay: TYPING_DELAY_MS });

      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      // Facebook removed the login button, so the form is submitted by pressing Enter.
      await page.keyboard.press('Enter');
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      // Deliberately not threading Playwright's message through: an error raised while typing can
      // quote the typed value, and a credential must never reach a log, an error, or a result.
      this.logger.error(
        'Facebook credential login could not submit the login form:',
        error instanceof Error ? error.name : 'UnknownError'
      );
      throw new ProviderError('LOGIN_REQUIRED', 'The Facebook login form could not be submitted automatically.');
    }
  }

  private async waitForUsableSession(page: Page, signal: AbortSignal): Promise<FacebookLoginResult> {
    const deadline = Date.now() + this.waitMs;
    let last: FacebookSessionProbeResult = { status: 'session_unknown', outcome: 'ambiguous' };

    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

      try {
        last = classifyFacebookSession(await readFacebookPage(page), this.baseUrl);
      } catch {
        // A read taken mid-navigation is not decisive; keep waiting rather than failing the login.
        last = { status: 'session_unknown', outcome: 'ambiguous' };
      }

      if (last.status === 'session_usable') {
        this.browser.assessSession('session_usable');
        return { outcome: 'authenticated' };
      }
      if (last.outcome === 'captcha') {
        // A captcha cannot be satisfied from the phone, so stop rather than burning the window.
        this.browser.assessSession('session_needs_reauth');
        return { outcome: 'challenge', code: 'CAPTCHA_REQUIRED' };
      }
      if (Date.now() >= deadline) break;
      await sleepUntilAbort(this.pollIntervalMs, signal);
    }

    // A checkpoint is not treated as fatal while the window is open: Facebook uses one as the gate
    // for the very approval we are waiting on. Only once the window closes is it reported as a
    // challenge needing a human.
    if (last.outcome === 'checkpoint') {
      this.browser.assessSession('session_needs_reauth');
      return { outcome: 'challenge', code: 'SESSION_INVALID' };
    }
    if (last.outcome === 'login_required' || last.outcome === 'login_redirect') {
      // Still on the login form: credentials were not enough, or the approval never came.
      this.browser.assessSession('session_unknown');
      return { outcome: 'timeout', code: 'LOGIN_REQUIRED' };
    }
    this.browser.assessSession('session_unknown');
    return { outcome: 'ambiguous' };
  }
}

/**
 * Best-effort consent dismissal, mirroring the reference implementation. Every failure mode is
 * swallowed: a missing or differently-labelled banner must not fail the login.
 */
async function dismissConsentBanner(page: Page, signal: AbortSignal): Promise<void> {
  try {
    const button = page.getByRole('button', { name: CONSENT_BUTTON_PATTERN }).first();
    await button.click({ timeout: CONSENT_TIMEOUT_MS });
    await sleepUntilAbort(CONSENT_SETTLE_MS, signal);
  } catch {
    // No banner, no permission to click it, or the click raced a navigation: none of it matters.
  }
}

function readCredential(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
