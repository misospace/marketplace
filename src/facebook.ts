import type { Page } from 'playwright';
import { ProviderError } from './backend.js';
import { BrowserSessionManager, BrowserUnavailableError, type BrowserSessionInfo, type ProviderSessionAssessment } from './browser.js';
import type { ProviderErrorCode } from './domain.js';

export const FACEBOOK_ORIGIN = 'https://www.facebook.com';
export const FACEBOOK_MARKETPLACE_PATH = '/marketplace/';

export const FACEBOOK_PROBE_OUTCOMES = ['marketplace_authenticated', 'login_required', 'login_redirect', 'checkpoint', 'captcha', 'ambiguous'] as const;
export type FacebookProbeOutcome = typeof FACEBOOK_PROBE_OUTCOMES[number];

export type FacebookProbeCode = Extract<ProviderErrorCode, 'LOGIN_REQUIRED' | 'CAPTCHA_REQUIRED' | 'SESSION_INVALID'>;

export interface FacebookSessionProbeResult {
  status: ProviderSessionAssessment;
  outcome: FacebookProbeOutcome;
  code?: FacebookProbeCode;
}

export interface FacebookPageSnapshot {
  url: string;
  hasPasswordInput: boolean;
  hasLoginForm: boolean;
  hasCheckpointForm: boolean;
  hasCaptchaFrame: boolean;
  hasMainLandmark: boolean;
  hasMarketplaceLink: boolean;
  hasAuthenticatedMarker: boolean;
  hasLoginPrompt: boolean;
  mentionsCheckpoint: boolean;
  mentionsCaptcha: boolean;
}

export interface FacebookSessionProbeOptions {
  browser: BrowserSessionManager;
  baseUrl?: string;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  logger?: Pick<Console, 'error'>;
}

export class FacebookSessionProbe {
  readonly baseUrl: string;
  readonly probeUrl: string;
  private readonly browser: BrowserSessionManager;
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly logger: Pick<Console, 'error'>;

  constructor(options: FacebookSessionProbeOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    if (!(options.browser instanceof BrowserSessionManager)) {
      throw new TypeError('options.browser must be a BrowserSessionManager');
    }

    this.browser = options.browser;
    this.baseUrl = normalizeFacebookBaseUrl(options.baseUrl ?? FACEBOOK_ORIGIN);
    this.probeUrl = new URL(FACEBOOK_MARKETPLACE_PATH, this.baseUrl).href;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 15_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 3_000;
    this.logger = options.logger ?? console;

    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
    validateTimeout(this.settleTimeoutMs, 'settleTimeoutMs');
  }

  async probeSession(signal: AbortSignal): Promise<FacebookSessionProbeResult> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));

    this.browser.assessSession('session_unknown');

    let snapshot: FacebookPageSnapshot;
    try {
      snapshot = await this.browser.runExclusive(signal, (page) => this.loadSnapshot(page, signal));
    } catch (error) {
      if (error instanceof BrowserUnavailableError || signal.aborted) throw error;
      this.logger.error(
        'Facebook session probe failed to load the Marketplace page:',
        error instanceof Error ? error.name : 'UnknownError'
      );
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace page could not be loaded for the session probe.');
    }

    const result = classifyFacebookSession(snapshot, this.baseUrl);
    this.browser.assessSession(result.status);
    return result;
  }

  private async loadSnapshot(page: Page, signal: AbortSignal): Promise<FacebookPageSnapshot> {
    await page.goto(this.probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
      signal
    });

    let snapshot = await readFacebookPage(page);
    const deadline = Date.now() + this.settleTimeoutMs;
    while (!hasDecisiveSignal(snapshot, this.baseUrl) && Date.now() < deadline && !signal.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      try {
        snapshot = await readFacebookPage(page);
      } catch {
        break;
      }
    }

    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    return snapshot;
  }
}

export function classifyFacebookSession(snapshot: FacebookPageSnapshot, baseUrl: string): FacebookSessionProbeResult {
  if (snapshot.hasCaptchaFrame || snapshot.mentionsCaptcha) {
    return { status: 'session_needs_reauth', outcome: 'captcha', code: 'CAPTCHA_REQUIRED' };
  }
  if (isCheckpointUrl(snapshot.url) || snapshot.hasCheckpointForm || snapshot.mentionsCheckpoint) {
    return { status: 'session_needs_reauth', outcome: 'checkpoint', code: 'SESSION_INVALID' };
  }
  if (isLoginUrl(snapshot.url) || snapshot.hasPasswordInput || snapshot.hasLoginForm) {
    return {
      status: 'session_needs_reauth',
      outcome: isLoginUrl(snapshot.url) ? 'login_redirect' : 'login_required',
      code: 'LOGIN_REQUIRED'
    };
  }
  if (isMarketplaceUrl(snapshot.url, baseUrl) && snapshot.hasMainLandmark && snapshot.hasMarketplaceLink && snapshot.hasAuthenticatedMarker) {
    return { status: 'session_usable', outcome: 'marketplace_authenticated' };
  }
  if (snapshot.hasLoginPrompt) {
    return { status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' };
  }
  return { status: 'session_unknown', outcome: 'ambiguous' };
}

export function toProviderSessionAssessment(info: BrowserSessionInfo): ProviderSessionAssessment {
  return info.status === 'session_usable' || info.status === 'session_needs_reauth'
    ? info.status
    : 'session_unknown';
}

async function readFacebookPage(page: Page): Promise<FacebookPageSnapshot> {
  const [passwordCount, loginCount, checkpointCount, captchaCount, mainCount, marketplaceLinkCount, authMarkerCount, logoutLinkCount, loginPromptLinkCount, loginPromptButtonCount, checkpointTextCount, captchaTextCount, url] = await Promise.all([
    page.locator('input[type="password"]').count(),
    page.locator('form[action*="/login"], input[name="pass"]').count(),
    page.locator('form[action*="checkpoint"], [data-testid*="checkpoint"]').count(),
    page.locator('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]').count(),
    page.locator('main, [role="main"]').count(),
    page.locator('a[href*="/marketplace"]').count(),
    page.locator('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]').count(),
    page.getByRole('link', { name: /^\s*log ?out\s*$/i }).count(),
    page.getByRole('link', { name: /^\s*log ?in( to facebook)?\s*$/i }).count(),
    page.getByRole('button', { name: /^\s*log ?in( to facebook)?\s*$/i }).count(),
    page.getByText(/security check|confirm your identity|unusual activity/i).count(),
    page.getByText(/captcha|i'?m not a robot|verify you are a human/i).count(),
    page.url()
  ]);

  return {
    url,
    hasPasswordInput: passwordCount > 0,
    hasLoginForm: loginCount > 0,
    hasCheckpointForm: checkpointCount > 0,
    hasCaptchaFrame: captchaCount > 0,
    hasMainLandmark: mainCount > 0,
    hasMarketplaceLink: marketplaceLinkCount > 0,
    hasAuthenticatedMarker: authMarkerCount > 0 || logoutLinkCount > 0,
    hasLoginPrompt: loginPromptLinkCount > 0 || loginPromptButtonCount > 0,
    mentionsCheckpoint: checkpointTextCount > 0,
    mentionsCaptcha: captchaTextCount > 0
  };
}

function hasDecisiveSignal(snapshot: FacebookPageSnapshot, baseUrl: string): boolean {
  return snapshot.hasPasswordInput || snapshot.hasLoginForm || snapshot.hasCheckpointForm || snapshot.hasCaptchaFrame || snapshot.hasLoginPrompt ||
    snapshot.mentionsCheckpoint || snapshot.mentionsCaptcha || isLoginUrl(snapshot.url) || isCheckpointUrl(snapshot.url) ||
    (isMarketplaceUrl(snapshot.url, baseUrl) && snapshot.hasMainLandmark && snapshot.hasMarketplaceLink && snapshot.hasAuthenticatedMarker);
}

function isLoginUrl(value: string): boolean {
  const pathname = getPathname(value);
  return pathname === '/login' || pathname?.startsWith('/login/') === true;
}

function isCheckpointUrl(value: string): boolean {
  const pathname = getPathname(value);
  return pathname === '/checkpoint' || pathname?.startsWith('/checkpoint/') === true;
}

function isMarketplaceUrl(value: string, baseUrl: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    return url.origin === base.origin && (url.pathname === '/marketplace' || url.pathname.startsWith('/marketplace/'));
  } catch {
    return false;
  }
}

function getPathname(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

export function assertFacebookOrigin(value: string): string {
  if (typeof value !== 'string') throw new TypeError('URL must be a valid HTTP(S) URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('URL must be a valid HTTP(S) URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password ||
      (url.origin !== FACEBOOK_ORIGIN && !isLoopbackHost(url.hostname))) {
    throw new TypeError('URL must use the Facebook origin or a loopback origin');
  }
  return value;
}

function normalizeFacebookBaseUrl(value: string): string {
  assertFacebookOrigin(value);
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new TypeError('baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
