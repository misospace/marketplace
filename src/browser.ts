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
export type ProviderSessionAssessment = 'session_unknown' | 'session_usable' | 'session_needs_reauth';

export interface BrowserSessionInfo {
  status: BrowserSessionStatus;
  profileDir: string;
  profileExisted: boolean;
  browserStarted: boolean;
  reason?: string;
}

export interface BrowserSessionOptions {
  profileDir?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  closeTimeoutMs?: number;
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

const PROVIDER_SESSION_ASSESSMENTS = new Set<ProviderSessionAssessment>([
  'session_unknown',
  'session_usable',
  'session_needs_reauth'
]);

export class BrowserSessionManager {
  readonly profileDir: string;
  private readonly profileExisted: boolean;
  private readonly headless: boolean;
  private readonly launchTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly launchArgs: string[];
  private readonly logger: Pick<Console, 'error'>;
  private context: BrowserContext | undefined;
  private lastAssessment: ProviderSessionAssessment = 'session_unknown';
  private lastLaunchError: string | undefined;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;

  constructor(options: BrowserSessionOptions = {}) {
    const configuredProfileDir = options.profileDir ?? process.env.BROWSER_PROFILE_DIR;
    this.profileDir = resolveProfileDir(configuredProfileDir);
    this.profileExisted = existsSync(this.profileDir);
    this.headless = options.headless ?? true;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.launchArgs = [...(options.launchArgs ?? [])];
    this.logger = options.logger ?? console;
    if (!Number.isSafeInteger(this.launchTimeoutMs) || this.launchTimeoutMs <= 0) {
      throw new RangeError('launchTimeoutMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.closeTimeoutMs) || this.closeTimeoutMs <= 0) {
      throw new RangeError('closeTimeoutMs must be a positive integer');
    }
    if (!Array.isArray(this.launchArgs) || this.launchArgs.some((argument) => typeof argument !== 'string')) {
      throw new TypeError('launchArgs must be an array of strings');
    }
    if (this.launchArgs.some((argument) => /^--?remote-(?:debugging|allow-origins)/i.test(argument))) {
      throw new TypeError('launchArgs must not expose remote debugging');
    }
  }

  getInfo(): BrowserSessionInfo {
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
    if (this.lastLaunchError) {
      return {
        status: 'browser_unavailable',
        profileDir: this.profileDir,
        profileExisted: this.profileExisted,
        browserStarted: false,
        reason: this.lastLaunchError
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
    if (!PROVIDER_SESSION_ASSESSMENTS.has(status)) {
      throw new RangeError('Invalid provider session assessment');
    }
    this.lastAssessment = status;
  }

  runExclusive<T>(signal: AbortSignal, task: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));
    return this.enqueue(async () => {
      if (this.closed) throw new BrowserUnavailableError('Browser session is closed');
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      const context = await this.ensureContext(signal);
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      const page = await context.newPage();
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
        await (abortClose ?? page.close().catch(() => undefined));
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const context = this.context;
    this.context = undefined;
    this.closePromise = (async () => {
      if (!context) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          context.close().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.closeTimeoutMs);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.closePromise;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureContext(signal: AbortSignal): Promise<BrowserContext> {
    if (this.closed) throw new BrowserUnavailableError('Browser session is closed');
    if (this.context) return this.context;
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

    try {
      mkdirSync(this.profileDir, { recursive: true });
      const { chromium } = await import('playwright');
      if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
      // Playwright exposes no signal for launch, so an in-flight launch is only
      // bounded by launchTimeoutMs; the abort signal is re-checked after it.
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        timeout: this.launchTimeoutMs,
        ...(this.launchArgs.length ? { args: this.launchArgs } : {})
      });
      if (this.closed) {
        await context.close().catch(() => undefined);
        throw new BrowserUnavailableError('Browser session is closed');
      }
      this.context = context;
      context.once('close', () => {
        if (this.context === context) {
          this.context = undefined;
          if (!this.closed) this.lastLaunchError = 'Browser session closed unexpectedly';
        }
      });
      this.lastLaunchError = undefined;
      return context;
    } catch (error) {
      if (error instanceof BrowserUnavailableError && this.closed) throw error;
      if (signal.aborted && error === signal.reason) throw error;
      const reason = safeErrorMessage(error);
      this.lastLaunchError = reason;
      this.logger.error(`Browser launch failed: ${reason}`);
      throw new BrowserUnavailableError(reason);
    }
  }
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
