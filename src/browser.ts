import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

export const BROWSER_SESSION_STATUSES = [
  'browser_unavailable',
  'profile_missing',
  'session_unknown',
  'session_usable',
  'session_needs_reauth'
] as const;

export type BrowserSessionStatus = typeof BROWSER_SESSION_STATUSES[number];
export const PROVIDER_SESSION_ASSESSMENTS = ['session_unknown', 'session_usable', 'session_needs_reauth'] as const;
export type ProviderSessionAssessment = typeof PROVIDER_SESSION_ASSESSMENTS[number];

export interface BrowserSessionInfo {
  status: BrowserSessionStatus;
  profileDir: string;
  profileExisted: boolean;
  browserStarted: boolean;
  interactive?: boolean;
  reason?: string;
}

export interface InteractiveBrowserOptions {
  display?: string;
  headless?: boolean;
  signal?: AbortSignal;
}

export interface BrowserSessionOptions {
  profileDir?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  settleTimeoutMs?: number;
  launchArgs?: string[];
  logger?: Pick<Console, 'error'>;
}

export class BrowserUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'BrowserUnavailableError';
    this.reason = reason;
  }
}

const providerSessionAssessmentSet = new Set<ProviderSessionAssessment>(PROVIDER_SESSION_ASSESSMENTS);

export class BrowserSessionManager {
  readonly profileDir: string;
  private profileExisted: boolean;
  private readonly headless: boolean;
  private readonly launchTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly launchArgs: string[];
  private readonly logger: Pick<Console, 'error'>;
  private context: BrowserContext | undefined;
  private interactiveBrowserContext: BrowserContext | undefined;
  private interactive = false;
  private interactiveLaunchInvalidated = false;
  private interactiveBegin: Promise<void> | undefined;
  private interactiveLaunch: Promise<BrowserContext> | undefined;
  private interactiveLaunchGeneration = 0;
  private headlessLaunch: Promise<BrowserContext> | undefined;
  private headlessLaunchGeneration = 0;
  private lastAssessment: ProviderSessionAssessment = 'session_unknown';
  private lastFailure: string | undefined;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private pendingTeardown: Promise<void> | undefined;

  constructor(options: BrowserSessionOptions = {}) {
    const configuredProfileDir = options.profileDir ?? process.env.BROWSER_PROFILE_DIR;
    this.profileDir = resolveProfileDir(configuredProfileDir);
    this.profileExisted = existsSync(this.profileDir);
    this.headless = options.headless ?? true;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 5_000;
    this.launchArgs = [...(options.launchArgs ?? [])];
    this.logger = options.logger ?? console;
    if (!Number.isSafeInteger(this.launchTimeoutMs) || this.launchTimeoutMs <= 0) {
      throw new RangeError('launchTimeoutMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.settleTimeoutMs) || this.settleTimeoutMs <= 0) {
      throw new RangeError('settleTimeoutMs must be a positive integer');
    }
    if (!Array.isArray(this.launchArgs) || this.launchArgs.some((argument) => typeof argument !== 'string')) {
      throw new TypeError('launchArgs must be an array of strings');
    }
    if (this.launchArgs.some((argument) => /^--?remote-(?:debugging|allow-origins)/i.test(argument))) {
      throw new TypeError('launchArgs must not expose remote debugging');
    }
  }

  getInfo(): BrowserSessionInfo {
    if (this.interactive) {
      return {
        status: 'session_unknown',
        profileDir: this.profileDir,
        profileExisted: this.profileExisted,
        browserStarted: this.interactiveBrowserContext !== undefined,
        interactive: true
      };
    }
    if (this.closed) {
      return {
        status: 'browser_unavailable',
        profileDir: this.profileDir,
        profileExisted: this.profileExisted,
        browserStarted: false,
        reason: 'Browser session is closed'
      };
    }
    if (this.context) {
      return {
        status: this.lastAssessment,
        profileDir: this.profileDir,
        profileExisted: this.profileExisted,
        browserStarted: true
      };
    }
    if (this.lastFailure) {
      return {
        status: 'browser_unavailable',
        profileDir: this.profileDir,
        profileExisted: this.profileExisted,
        browserStarted: false,
        reason: this.lastFailure
      };
    }
    return {
      status: this.profileExisted ? 'session_unknown' : 'profile_missing',
      profileDir: this.profileDir,
      profileExisted: this.profileExisted,
      browserStarted: false
    };
  }

  assessSession(status: ProviderSessionAssessment): void {
    if (!providerSessionAssessmentSet.has(status)) {
      throw new RangeError('Invalid provider session assessment');
    }
    this.lastAssessment = status;
  }

  runExclusive<T>(signal: AbortSignal, task: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.interactive) return Promise.reject(new BrowserUnavailableError('Interactive reauth session owns the browser profile'));
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));
    return this.enqueue(async () => {
      if (this.interactive) throw new BrowserUnavailableError('Interactive reauth session owns the browser profile');
      if (this.closed) throw new BrowserUnavailableError('Browser session is closed');
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      const context = await this.ensureContext(signal);
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      const pagePromise = context.newPage();
      const acquired = await this.settle(pagePromise);
      if (!acquired.settled) {
        void pagePromise.then(
          (latePage) => this.settleIgnoring(latePage.close().catch(() => undefined)),
          () => undefined
        );
        this.discardContext('Browser did not provide a page in time');
        throw new BrowserUnavailableError('Browser did not provide a page in time');
      }
      const page = acquired.value;
      if (signal.aborted) {
        await this.settleIgnoring(page.close().catch(() => undefined));
        throw signal.reason ?? new Error('Browser operation aborted');
      }
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      let abortClose: Promise<void> | undefined;
      const onAbort = (): void => {
        abortClose = page.close().catch(() => undefined);
        rejectAbort(signal.reason ?? new Error('Browser operation aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        return await Promise.race([Promise.resolve().then(() => {
          if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
          return task(page, signal);
        }), aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
        const closed = await this.settle(abortClose ?? page.close().catch(() => undefined));
        if (!closed.settled) this.discardContext('Browser did not close a page in time');
      }
    });
  }

  beginInteractive(): Promise<void> {
    if (this.closed) return Promise.reject(new BrowserUnavailableError('Browser session is closed'));
    if (this.interactiveBegin) return this.interactiveBegin;
    if (this.interactive) return Promise.resolve();
    this.interactive = true;
    this.interactiveLaunchInvalidated = false;
    this.headlessLaunchGeneration += 1;
    this.lastAssessment = 'session_unknown';
    this.lastFailure = undefined;
    const headlessLaunch = this.headlessLaunch;
    const queuedWork = this.queue;
    const begin = (async (): Promise<void> => {
      await queuedWork;
      if (headlessLaunch) await headlessLaunch.catch(() => undefined);
      if (this.pendingTeardown) {
        const teardown = this.pendingTeardown;
        this.pendingTeardown = undefined;
        await teardown;
      }
      const context = this.context;
      this.context = undefined;
      if (context) await this.settleIgnoring(context.close().catch(() => undefined));
    })();
    this.interactiveBegin = begin;
    void begin.finally(() => {
      if (this.interactiveBegin === begin) this.interactiveBegin = undefined;
    }).catch(() => undefined);
    return begin;
  }

  async openInteractive(options: InteractiveBrowserOptions = {}): Promise<BrowserContext> {
    if (!this.interactive || this.closed) {
      throw new BrowserUnavailableError('Interactive browser ownership is not active');
    }
    if (this.interactiveBegin) await this.interactiveBegin;
    if (!this.interactive || this.closed) {
      throw new BrowserUnavailableError('Interactive browser ownership is not active');
    }
    if (this.interactiveLaunchInvalidated) {
      throw new BrowserUnavailableError('Interactive browser launch was superseded');
    }
    if (this.interactiveBrowserContext) return this.interactiveBrowserContext;
    const generation = this.interactiveLaunchGeneration;
    if (this.interactiveLaunch) return this.interactiveLaunch;

    const launch = (async () => {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Browser operation aborted');
      if (!this.interactive || this.closed || generation !== this.interactiveLaunchGeneration) {
        throw new BrowserUnavailableError('Interactive browser ownership is no longer active');
      }
      mkdirSync(this.profileDir, { recursive: true });
      this.profileExisted = true;
      const { chromium } = await this.loadPlaywright();
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Browser operation aborted');
      if (!this.interactive || this.closed || generation !== this.interactiveLaunchGeneration) {
        throw new BrowserUnavailableError('Interactive browser ownership is no longer active');
      }
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: options.headless ?? false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: this.launchTimeoutMs,
        args: [
          ...this.launchArgs,
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-default-apps',
          '--no-first-run',
          '--no-default-browser-check'
        ],
        env: interactiveBrowserEnvironment(options.display)
      });
      if (!this.interactive || this.closed || generation !== this.interactiveLaunchGeneration || options.signal?.aborted) {
        await this.settleIgnoring(context.close().catch(() => undefined));
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('Browser operation aborted');
        throw new BrowserUnavailableError('Interactive browser ownership is no longer active');
      }
      this.interactiveBrowserContext = context;
      context.once('close', () => {
        if (this.interactiveBrowserContext === context) this.interactiveBrowserContext = undefined;
      });
      return context;
    })();
    this.interactiveLaunch = launch;
    try {
      return await launch;
    } catch (error) {
      if (error instanceof BrowserUnavailableError) throw error;
      const reason = safeErrorMessage(error);
      this.logger.error('Interactive browser launch failed during reauth startup');
      throw new BrowserUnavailableError(reason);
    } finally {
      if (this.interactiveLaunch === launch) this.interactiveLaunch = undefined;
    }
  }

  interactiveContext(): BrowserContext | undefined {
    return this.interactiveBrowserContext;
  }

  // Pair this with endInteractive(); invalidation resets only on the next beginInteractive().
  async closeInteractive(): Promise<void> {
    this.interactiveLaunchGeneration += 1;
    this.interactiveLaunchInvalidated = true;
    const pendingLaunch = this.interactiveLaunch;
    if (this.interactiveLaunch === pendingLaunch) this.interactiveLaunch = undefined;
    const pendingBegin = this.interactiveBegin;
    if (pendingBegin) await this.settleIgnoring(pendingBegin.catch(() => undefined));
    if (pendingLaunch) await this.settleIgnoring(pendingLaunch.catch(() => undefined), this.launchTimeoutMs);
    const context = this.interactiveBrowserContext;
    if (context) {
      await context.close().catch(() => undefined);
      if (this.interactiveBrowserContext === context) this.interactiveBrowserContext = undefined;
    }
  }

  endInteractive(): void {
    this.interactive = false;
    this.lastAssessment = 'session_unknown';
    this.lastFailure = undefined;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.pendingTeardown) {
        const teardown = this.pendingTeardown;
        this.pendingTeardown = undefined;
        await teardown;
      }
      const context = this.context;
      this.context = undefined;
      if (context) await this.settleIgnoring(context.close().catch(() => undefined));
      await this.closeInteractive();
      this.interactive = false;
    })();
    return this.closePromise;
  }

  private async settle<T>(
    promise: Promise<T>,
    timeoutMs = this.settleTimeoutMs
  ): Promise<{ settled: true; value: T } | { settled: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then((value) => ({ settled: true as const, value })),
        new Promise<{ settled: false }>((resolve) => {
          timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async settleIgnoring(promise: Promise<unknown>, timeoutMs = this.settleTimeoutMs): Promise<void> {
    await this.settle(promise, timeoutMs);
  }

  private discardContext(reason: string): void {
    const context = this.context;
    if (!context) return;
    this.context = undefined;
    this.lastAssessment = 'session_unknown';
    this.lastFailure = reason;
    this.pendingTeardown = this.settleIgnoring(context.close().catch(() => undefined));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  protected loadPlaywright(): Promise<typeof import('playwright')> {
    return import('playwright');
  }

  private async ensureContext(signal: AbortSignal): Promise<BrowserContext> {
    if (this.closed) throw new BrowserUnavailableError('Browser session is closed');
    if (this.pendingTeardown) {
      const teardown = this.pendingTeardown;
      this.pendingTeardown = undefined;
      await teardown;
      if (this.interactive) throw new BrowserUnavailableError('Interactive reauth session owns the browser profile');
      if (this.closed) throw new BrowserUnavailableError('Browser session is closed');
    }
    if (this.context) return this.context;
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

    try {
      const generation = this.headlessLaunchGeneration;
      const launch = (async (): Promise<BrowserContext> => {
        mkdirSync(this.profileDir, { recursive: true });
        this.profileExisted = true;
        const { chromium } = await this.loadPlaywright();
        if (this.interactive || generation !== this.headlessLaunchGeneration) {
          throw new BrowserUnavailableError('Interactive reauth session owns the browser profile');
        }
        if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
        // Playwright exposes no signal for launch, so an in-flight launch is only
        // bounded by launchTimeoutMs; the abort signal is re-checked after it.
        const context = await chromium.launchPersistentContext(this.profileDir, {
          headless: this.headless,
          timeout: this.launchTimeoutMs,
          ...(this.launchArgs.length ? { args: this.launchArgs } : {})
        });
        if (this.closed || this.interactive || generation !== this.headlessLaunchGeneration) {
          await context.close().catch(() => undefined);
          if (this.interactive || generation !== this.headlessLaunchGeneration) {
            throw new BrowserUnavailableError('Interactive reauth session owns the browser profile');
          }
          throw new BrowserUnavailableError('Browser session is closed');
        }
        this.context = context;
        context.once('close', () => {
          if (this.context === context) {
            this.context = undefined;
            this.lastAssessment = 'session_unknown';
            if (!this.closed) this.lastFailure = 'Browser session closed unexpectedly';
          }
        });
        this.lastFailure = undefined;
        return context;
      })();
      this.headlessLaunch = launch;
      try {
        return await launch;
      } finally {
        if (this.headlessLaunch === launch) this.headlessLaunch = undefined;
      }
    } catch (error) {
      if (error instanceof BrowserUnavailableError && (this.closed || this.interactive)) throw error;
      if (signal.aborted && error === signal.reason) throw error;
      const reason = safeErrorMessage(error);
      this.lastFailure = reason;
      this.logger.error(`Browser launch failed: ${reason}`);
      throw new BrowserUnavailableError(reason);
    }
  }
}

function interactiveBrowserEnvironment(display: string | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'HOME', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
  ] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (display !== undefined) environment.DISPLAY = display;
  return environment;
}

function resolveProfileDir(configured: string | undefined): string {
  if (configured !== undefined && (!configured || configured !== configured.trim())) {
    throw new TypeError('BROWSER_PROFILE_DIR must be a trimmed non-empty path');
  }
  return resolve(configured ?? join(homedir(), '.marketplace', 'browser-profile'));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name.replace(/[\r\n]/g, ' ');
    const message = error.message.replace(/[\r\n]/g, ' ');
    return `${name}: ${message}`;
  }
  return 'UnknownError: non-Error thrown';
}
