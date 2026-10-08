import { errors } from 'playwright';
import { BrowserSessionManager, BrowserUnavailableError, sleepUntilAbort } from './browser.js';
import type { ConversationBackend } from './backend.js';
import { ProviderError as MarketplaceProviderError } from './backend.js';
import {
  threadsListInputSchema,
  threadReadInputSchema,
  type ConversationThread,
  type ConversationThreadMessages,
  type ProviderErrorCode
} from './domain.js';
import {
  extractMessengerInboxPage,
  extractMessengerThreadPage,
  MESSENGER_EXTRACT_LIMITS,
  type ExtractedInboxPage,
  type ExtractedThreadPage
} from './facebook-messenger-extract.js';
import {
  classifyMessengerInboxPage,
  classifyMessengerThreadPage,
  interpretMessengerInboxPage,
  interpretMessengerThreadPage
} from './facebook-messenger-parse.js';
import {
  buildMessengerInboxUrl,
  buildMessengerThreadUrl,
  MESSENGER_THREAD_PATH
} from './facebook-messenger-url.js';
import { assertFacebookOrigin, FacebookSessionProbe, type FacebookProbeCode } from './facebook.js';
import { FacebookCredentialLogin } from './facebook-login.js';

export interface FacebookMessengerBackendOptions {
  browser: BrowserSessionManager;
  probe: FacebookSessionProbe;
  /** Optional env-backed login instance isolated to the Messenger browser profile. */
  login?: FacebookCredentialLogin;
  inboxPath?: string;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxThreads?: number;
  logger?: Pick<Console, 'error'>;
}

export class FacebookMessengerBackend implements ConversationBackend {
  readonly name = 'facebook';
  private readonly browser: BrowserSessionManager;
  private readonly probe: FacebookSessionProbe;
  private readonly login: FacebookCredentialLogin | undefined;
  private readonly inboxPath: string;
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly maxThreads: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly loginController = new AbortController();
  private credentialRecovery: Promise<{ recovered: boolean; code?: FacebookProbeCode }> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: FacebookMessengerBackendOptions) {
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
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 8_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 3_000;
    this.maxThreads = options.maxThreads ?? MESSENGER_EXTRACT_LIMITS.maxThreads;
    this.logger = options.logger ?? console;
    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
    validateTimeout(this.settleTimeoutMs, 'settleTimeoutMs');
    if (!Number.isSafeInteger(this.maxThreads) || this.maxThreads < 1 || this.maxThreads > MESSENGER_EXTRACT_LIMITS.maxThreads) {
      throw new RangeError(`maxThreads must be an integer from 1 to ${MESSENGER_EXTRACT_LIMITS.maxThreads}`);
    }
    this.inboxPath = options.inboxPath ?? '/marketplace/inbox/';
    // Validate the configured path at startup, not in the middle of a browser operation.
    buildMessengerInboxUrl({ baseUrl: this.probe.baseUrl, inboxPath: this.inboxPath });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.loginController.abort(new Error('Facebook Messenger backend is shutting down'));
    this.closePromise = (async () => {
      await this.credentialRecovery?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  async listThreads(
    input: ReturnType<typeof threadsListInputSchema.parse>,
    signal: AbortSignal
  ): Promise<ConversationThread[]> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    await this.ensureUsableSession(signal);

    const inboxUrl = assertFacebookOrigin(buildMessengerInboxUrl({ baseUrl: this.probe.baseUrl, inboxPath: this.inboxPath }));
    let extracted: ExtractedInboxPage;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(inboxUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });
        const extractOptions = {
          threadPath: MESSENGER_THREAD_PATH,
          limits: { ...MESSENGER_EXTRACT_LIMITS, maxThreads: this.maxThreads }
        };
        let result = await page.evaluate(extractMessengerInboxPage, extractOptions);
        const deadline = Date.now() + this.settleTimeoutMs;
        while (classifyMessengerInboxPage(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) result = await page.evaluate(extractMessengerInboxPage, extractOptions);
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new MarketplaceProviderError('TIMEOUT', 'The Facebook Marketplace inbox page did not load in time.');
      }
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Messenger inbox read failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace inbox could not be read.');
    }

    const outcome = interpretMessengerInboxPage({
      page: extracted,
      baseUrl: this.probe.baseUrl,
      inboxPath: this.inboxPath,
      limit: input.limit
    });
    if (outcome.kind === 'error') throw new MarketplaceProviderError(outcome.code, outcome.message);
    if (outcome.kind === 'empty') return [];
    return [...outcome.threads];
  }

  async readThread(
    input: ReturnType<typeof threadReadInputSchema.parse>,
    signal: AbortSignal
  ): Promise<ConversationThreadMessages | null> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    await this.ensureUsableSession(signal);

    let threadUrl: string;
    try {
      threadUrl = assertFacebookOrigin(buildMessengerThreadUrl({ baseUrl: this.probe.baseUrl, threadId: input.thread_id }));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The requested Facebook Messenger thread id is invalid.');
      }
      throw error;
    }

    let extracted: ExtractedThreadPage;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(threadUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });
        const extractOptions = { limits: MESSENGER_EXTRACT_LIMITS };
        let result = await page.evaluate(extractMessengerThreadPage, extractOptions);
        const deadline = Date.now() + this.settleTimeoutMs;
        while (classifyMessengerThreadPage(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) result = await page.evaluate(extractMessengerThreadPage, extractOptions);
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new MarketplaceProviderError('TIMEOUT', 'The Facebook Messenger thread page did not load in time.');
      }
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Messenger thread read failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Messenger thread could not be read.');
    }

    const outcome = interpretMessengerThreadPage({ page: extracted, baseUrl: this.probe.baseUrl, threadId: input.thread_id });
    if (outcome.kind === 'error') throw new MarketplaceProviderError(outcome.code, outcome.message);
    return { thread_id: input.thread_id, messages: [...outcome.messages] };
  }

  private async ensureUsableSession(signal: AbortSignal): Promise<void> {
    let session: Awaited<ReturnType<FacebookSessionProbe['probeSession']>>;
    try {
      session = await this.probe.probeSession(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      if (error instanceof MarketplaceProviderError) throw error;
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
    }

    if (session.status === 'session_needs_reauth') {
      const recovery = await this.waitForCredentialLogin(session.code, signal);
      if (!recovery.recovered) {
        const code = recovery.code ?? session.code ?? 'SESSION_INVALID';
        throw new MarketplaceProviderError(code, messengerSessionMessage(code));
      }
      session = await this.confirmCredentialLogin(signal);
      if (session.status !== 'session_usable') {
        const code = session.code ?? 'SESSION_INVALID';
        throw new MarketplaceProviderError(code, messengerSessionMessage(code));
      }
    }
    if (session.status === 'session_unknown') {
      throw new MarketplaceProviderError('SESSION_INVALID', 'The Facebook session could not be verified, so the request was not attempted.');
    }
  }

  private async waitForCredentialLogin(
    code: FacebookProbeCode | undefined,
    signal: AbortSignal
  ): Promise<{ recovered: boolean; code?: FacebookProbeCode }> {
    if (!this.login || code !== 'LOGIN_REQUIRED') return { recovered: false };
    if (this.closePromise || this.loginController.signal.aborted) {
      throw this.loginController.signal.reason ?? new Error('Facebook Messenger backend is shutting down');
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
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
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
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook session could not be established.');
    }
  }
}

function messengerSessionMessage(code: FacebookProbeCode): string {
  const messages = {
    LOGIN_REQUIRED: 'Facebook login is required to read Marketplace conversations.',
    CAPTCHA_REQUIRED: 'Facebook requires a captcha challenge.',
    SESSION_INVALID: 'The Facebook session requires a security check.'
  } as const;
  return messages[code];
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
