import { errors } from 'playwright';
import { BrowserSessionManager, BrowserUnavailableError, sleepUntilAbort } from './browser.js';
import {
  fetchInputSchema,
  searchInputSchema,
  type Listing
} from './domain.js';
import { ProviderError, type MarketplaceBackend } from './backend.js';
import {
  extractMarketplaceItem,
  extractMarketplacePage,
  MARKETPLACE_EXTRACT_LIMITS,
  MARKETPLACE_ITEM_EXTRACT_LIMITS,
  type ExtractedMarketplaceItem,
  type ExtractedMarketplacePage
} from './facebook-marketplace-extract.js';
import {
  classifyMarketplaceItem,
  classifyMarketplacePage,
  interpretMarketplaceItem,
  interpretMarketplacePage
} from './facebook-marketplace-parse.js';
import {
  DEFAULT_FACEBOOK_MARKETS,
  MARKETPLACE_ITEM_PATH,
  buildMarketplaceSearchUrl,
  resolveFacebookMarket,
  validateFacebookMarkets,
  resolveMarketplaceItemInput,
  type FacebookMarket
} from './facebook-marketplace-url.js';
import { assertFacebookOrigin, FacebookSessionProbe, type FacebookProbeCode } from './facebook.js';
import { FacebookCredentialLogin } from './facebook-login.js';

export interface FacebookMarketplaceBackendOptions {
  browser: BrowserSessionManager;
  probe: FacebookSessionProbe;
  /**
   * Optional credential login. When present and the probe reports a plain login requirement,
   * credentials are submitted and the session is re-probed before the search fails.
   */
  login?: FacebookCredentialLogin;
  markets?: readonly FacebookMarket[];
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxCards?: number;
  logger?: Pick<Console, 'error'>;
}

export class FacebookMarketplaceBackend implements MarketplaceBackend {
  readonly name = 'facebook';
  private readonly browser: BrowserSessionManager;
  private readonly probe: FacebookSessionProbe;
  private readonly login: FacebookCredentialLogin | undefined;
  private readonly markets: readonly FacebookMarket[];
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly maxCards: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly loginController = new AbortController();
  private credentialRecovery: Promise<{ recovered: boolean; code?: FacebookProbeCode }> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: FacebookMarketplaceBackendOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    if (!(options.browser instanceof BrowserSessionManager)) {
      throw new TypeError('options.browser must be a BrowserSessionManager');
    }
    if (!(options.probe instanceof FacebookSessionProbe)) {
      throw new TypeError('options.probe must be a FacebookSessionProbe');
    }
    if (options.login !== undefined && !(options.login instanceof FacebookCredentialLogin)) {
      throw new TypeError('options.login must be a FacebookCredentialLogin');
    }

    this.browser = options.browser;
    this.probe = options.probe;
    this.login = options.login;
    this.markets = options.markets ?? DEFAULT_FACEBOOK_MARKETS;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 8_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 3_000;
    this.maxCards = options.maxCards ?? MARKETPLACE_EXTRACT_LIMITS.maxCards;
    this.logger = options.logger ?? console;

    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
    validateTimeout(this.settleTimeoutMs, 'settleTimeoutMs');
    if (!Number.isSafeInteger(this.maxCards) || this.maxCards < 1 || this.maxCards > MARKETPLACE_EXTRACT_LIMITS.maxCards) {
      throw new RangeError(`maxCards must be an integer from 1 to ${MARKETPLACE_EXTRACT_LIMITS.maxCards}`);
    }
    if (!Array.isArray(this.markets)) throw new TypeError('markets must be an array');
    // Validate during construction, with the same rules a configured markets file is held to, so
    // a bad map fails at startup instead of resolving ambiguously on every search.
    validateFacebookMarkets(this.markets);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.loginController.abort(new Error('Facebook backend is shutting down'));
    this.closePromise = (async () => {
      await this.credentialRecovery?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  async search(input: ReturnType<typeof searchInputSchema.parse>, signal: AbortSignal): Promise<Listing[]> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

    const resolution = resolveFacebookMarket(input.location, this.markets);
    if (!resolution.ok) {
      throw new ProviderError('UPSTREAM_ERROR', 'The location is not a configured Facebook Marketplace market.');
    }
    const market = resolution.market;

    await this.ensureUsableSession(signal);

    const searchUrl = assertFacebookOrigin(buildMarketplaceSearchUrl({
      baseUrl: this.probe.baseUrl,
      market,
      query: input.query,
      ...(input.min_price !== undefined ? { minPrice: input.min_price } : {}),
      ...(input.max_price !== undefined ? { maxPrice: input.max_price } : {})
    }));

    let extracted: ExtractedMarketplacePage;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });

        const extractOptions = {
          itemPath: MARKETPLACE_ITEM_PATH,
          limits: { ...MARKETPLACE_EXTRACT_LIMITS, maxCards: this.maxCards }
        };
        let result = await page.evaluate(extractMarketplacePage, extractOptions);
        const deadline = Date.now() + this.settleTimeoutMs;
        while (classifyMarketplacePage(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) {
            // Playwright 1.63 page.evaluate accepts no abort signal. An in-flight evaluation cannot be cancelled, but in-page work is bounded by construction and the outer deadline still rejects the caller.
            result = await page.evaluate(extractMarketplacePage, extractOptions);
          }
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new ProviderError('TIMEOUT', 'The Facebook Marketplace search page did not load in time.');
      }
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Marketplace search failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace search could not be completed.');
    }

    const outcome = interpretMarketplacePage({
      page: extracted,
      baseUrl: this.probe.baseUrl,
      market,
      limit: input.limit,
      ...(input.min_price !== undefined ? { minPrice: input.min_price } : {}),
      ...(input.max_price !== undefined ? { maxPrice: input.max_price } : {})
    });
    if (outcome.kind === 'error') throw new ProviderError(outcome.code, outcome.message);
    if (outcome.kind === 'empty') return [];
    return [...outcome.listings];
  }

  private async ensureUsableSession(signal: AbortSignal): Promise<void> {
    let session: Awaited<ReturnType<FacebookSessionProbe['probeSession']>>;
    try {
      session = await this.probe.probeSession(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
    }

    if (session.status === 'session_needs_reauth') {
      // Credentials are submitted only for a plain login requirement. A captcha or checkpoint
      // already means a human is needed, and re-submitting credentials there is exactly the loop
      // the manual re-auth flow exists to avoid.
      const recovery = await this.waitForCredentialLogin(session.code, signal);
      if (!recovery.recovered) {
        const code = recovery.code ?? session.code ?? 'SESSION_INVALID';
        const messages = {
          LOGIN_REQUIRED: 'Facebook Marketplace requires login.',
          CAPTCHA_REQUIRED: 'Facebook Marketplace requires a captcha challenge.',
          SESSION_INVALID: 'The Facebook session requires a security check.'
        } as const;
        throw new ProviderError(code, messages[code]);
      }
      session = await this.confirmCredentialLogin(signal);
      if (session.status !== 'session_usable') {
        const code = session.code ?? 'SESSION_INVALID';
        const messages = {
          LOGIN_REQUIRED: 'Facebook Marketplace requires login.',
          CAPTCHA_REQUIRED: 'Facebook Marketplace requires a captcha challenge.',
          SESSION_INVALID: 'The Facebook session requires a security check.'
        } as const;
        throw new ProviderError(code, messages[code]);
      }
    }
    if (session.status === 'session_unknown') {
      // The frozen error contract has no "unverified" code; SESSION_INVALID points an operator at the re-auth console, and the message states plainly that verification failed.
      throw new ProviderError('SESSION_INVALID', 'The Facebook session could not be verified, so the request was not attempted.');
    }
  }

  /**
   * Submits optional credentials when the probe reported a plain login requirement, then confirms
   * the outcome with the probe rather than trusting the login attempt's own classification.
   *
   * Returns the code to surface when recovery did not happen, so a challenge encountered during
   * the attempt is reported as itself rather than as the original login requirement.
   */
  private async waitForCredentialLogin(
    code: FacebookProbeCode | undefined,
    signal: AbortSignal
  ): Promise<{ recovered: boolean; code?: FacebookProbeCode }> {
    if (!this.login || code !== 'LOGIN_REQUIRED') return { recovered: false };
    if (this.closePromise || this.loginController.signal.aborted) {
      throw this.loginController.signal.reason ?? new Error('Facebook backend is shutting down');
    }

    const recovery = this.credentialRecovery ?? this.startCredentialLogin();
    let outcome: { recovered: boolean; code?: FacebookProbeCode } | undefined;
    try {
      outcome = await waitForRequestBudget(recovery, signal);
    } catch (error) {
      if (signal.aborted) return { recovered: false, code: 'LOGIN_REQUIRED' };
      throw error;
    }
    if (outcome === undefined) return { recovered: false, code: 'LOGIN_REQUIRED' };
    return outcome;
  }

  private async confirmCredentialLogin(signal: AbortSignal): Promise<Awaited<ReturnType<FacebookSessionProbe['probeSession']>>> {
    try {
      return await this.probe.probeSession(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
    }
  }

  private startCredentialLogin(): Promise<{ recovered: boolean; code?: FacebookProbeCode }> {
    const attempt = Promise.resolve().then(() => this.performCredentialLogin());
    this.credentialRecovery = attempt;
    void attempt.finally(() => {
      if (this.credentialRecovery === attempt) this.credentialRecovery = undefined;
    }).catch(() => undefined);
    return attempt;
  }

  private async performCredentialLogin(): Promise<{ recovered: boolean; code?: FacebookProbeCode }> {
    try {
      const outcome = await this.login!.attempt(this.loginController.signal);
      if (outcome.outcome !== 'authenticated') {
        return { recovered: false, ...(outcome.code !== undefined ? { code: outcome.code } : {}) };
      }
      return { recovered: true };
    } catch (error) {
      if (this.loginController.signal.aborted) throw this.loginController.signal.reason ?? error;
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook session could not be established.');
    }
  }

  async fetch(input: ReturnType<typeof fetchInputSchema.parse>, signal: AbortSignal): Promise<Listing | null> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

    const resolved = resolveMarketplaceItemInput(input, this.probe.baseUrl);
    if (!resolved) return null;

    await this.ensureUsableSession(signal);

    let extracted: ExtractedMarketplaceItem;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(resolved.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });

        const extractOptions = {
          itemPath: MARKETPLACE_ITEM_PATH,
          limits: MARKETPLACE_ITEM_EXTRACT_LIMITS
        };
        let result = await page.evaluate(extractMarketplaceItem, extractOptions);
        const deadline = Date.now() + this.settleTimeoutMs;
        while (classifyMarketplaceItem(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) {
            // Playwright page.evaluate cannot be cancelled directly; the extracted page work is bounded.
            result = await page.evaluate(extractMarketplaceItem, extractOptions);
          }
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new ProviderError('TIMEOUT', 'The Facebook Marketplace listing page did not load in time.');
      }
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Marketplace fetch failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace listing could not be fetched.');
    }

    const locationMarket = extracted.locationText?.trim()
      ? resolveFacebookMarket(extracted.locationText, this.markets)
      : null;
    const outcome = interpretMarketplaceItem({
      page: extracted,
      id: resolved.id,
      url: resolved.url,
      ...(locationMarket?.ok ? { fallbackCurrency: locationMarket.market.currency } : {})
    });
    if (outcome.kind === 'error') throw new ProviderError(outcome.code, outcome.message);
    if (outcome.kind === 'unavailable') return null;
    return outcome.listing;
  }
}

function waitForRequestBudget<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error: unknown) => { cleanup(); reject(error); }
    );
  });
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
