import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as createRequest } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { BrowserSessionManager } from './browser.js';
import { assertFacebookOrigin, FACEBOOK_MARKETPLACE_PATH, FACEBOOK_ORIGIN } from './facebook.js';

export const REAUTH_PHASES = ['idle', 'starting', 'active', 'stopping'] as const;
export type ReauthPhase = typeof REAUTH_PHASES[number];
export const REAUTH_LEASE_DEFAULT_MS = 600_000;
export const REAUTH_LEASE_MAX_MS = 1_800_000;

export interface ReauthLease {
  readonly id: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly consoleUrl: string;
  readonly viewerPort: number;
}

export interface ReauthStatus {
  readonly phase: ReauthPhase;
  readonly lease: ReauthLease | null;
  readonly expiresAt: string | null;
  readonly remainingMs: number | null;
}

export interface ReauthProcessHandle {
  readonly label: string;
  readonly pid: number | undefined;
  onExit(listener: () => void): () => void;
  stop(): Promise<void>;
}

export interface ReauthRuntime {
  readonly providesDisplay: boolean;
  startDisplay(): Promise<{ handle: ReauthProcessHandle; display: string }>;
  startVnc(input: { display: string; port: number; passwordFile: string }): Promise<ReauthProcessHandle>;
  startViewer(input: { port: number; rfbPort: number }): Promise<ReauthProcessHandle>;
  allocatePort(): Promise<number>;
}

const PROCESS_START_TIMEOUT_MS = 10_000;
const PROCESS_OUTPUT_LIMIT = 8_192;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export class ProcessReauthRuntime implements ReauthRuntime {
  readonly providesDisplay = true;

  async startDisplay(): Promise<{ handle: ReauthProcessHandle; display: string }> {
    const process = spawnProcess('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp']);
    try {
      const displayNumber = await waitForDisplayNumber(process);
      return { handle: process.handle, display: `:${displayNumber}` };
    } catch (error) {
      await process.handle.stop();
      throw error;
    }
  }

  async startVnc(input: { display: string; port: number; passwordFile: string }): Promise<ReauthProcessHandle> {
    const process = spawnProcess('x11vnc', [
      '-display', input.display,
      '-rfbport', String(input.port),
      '-localhost',
      '-passwdfile', `read:${input.passwordFile}`,
      '-forever',
      '-shared',
      '-noxdamage',
      '-quiet'
    ]);
    try {
      await waitForTcpPort(process, input.port, 'x11vnc');
      return process.handle;
    } catch (error) {
      await process.handle.stop();
      throw error;
    }
  }

  async startViewer(input: { port: number; rfbPort: number }): Promise<ReauthProcessHandle> {
    const process = spawnProcess('websockify', [
      '--web=/usr/share/novnc',
      `127.0.0.1:${input.port}`,
      `127.0.0.1:${input.rfbPort}`
    ]);
    try {
      await waitForViewer(process, input.port);
      return process.handle;
    } catch (error) {
      await process.handle.stop();
      throw error;
    }
  }

  async allocatePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('Could not allocate a loopback port');
    }
    const { port } = address;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
  }
}

export interface ReauthManagerOptions {
  browser: BrowserSessionManager;
  runtime?: ReauthRuntime;
  targetUrl?: string;
  viewerPort?: number;
  leaseMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'error' | 'info'>;
}

type ReauthStartupStage = 'profile-lock' | 'temporary-files' | 'xvfb' | 'x11vnc' | 'websockify' | 'chromium' | 'facebook-navigation' | 'lease';

export class ReauthManager {
  private readonly browser: BrowserSessionManager;
  private readonly runtime: ReauthRuntime;
  private readonly targetUrl: string;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'error' | 'info'>;
  private readonly configuredViewerPort: number | undefined;
  private selectedViewerPort: number;
  readonly leaseMs: number;
  private phase: ReauthPhase = 'idle';
  private lease: ReauthLease | null = null;
  private currentLeaseId: string | undefined;
  private stopping = false;
  private cleanupPromise: Promise<void> | undefined;
  private rfbPort: number | undefined;
  private display: string | undefined;
  private tempDir: string | undefined;
  private passwordFile: string | undefined;
  private displayHandle: ReauthProcessHandle | undefined;
  private vncHandle: ReauthProcessHandle | undefined;
  private viewerHandle: ReauthProcessHandle | undefined;
  private ttlTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private processExitUnsubscribers: Array<() => void> = [];
  private unexpectedProcessExit: string | undefined;
  private browserOwnership = false;
  private suppressProcessExit = false;
  private leaseExpiryGeneration = 0;

  constructor(options: ReauthManagerOptions) {
    if (!options || typeof options !== 'object' || !(options.browser instanceof BrowserSessionManager)) {
      throw new TypeError('options.browser must be a BrowserSessionManager');
    }
    this.browser = options.browser;
    this.runtime = options.runtime ?? new ProcessReauthRuntime();
    this.targetUrl = assertFacebookOrigin(options.targetUrl ?? new URL(FACEBOOK_MARKETPLACE_PATH, FACEBOOK_ORIGIN).href);
    this.configuredViewerPort = options.viewerPort;
    this.selectedViewerPort = options.viewerPort ?? 0;
    if (options.viewerPort !== undefined) validatePort(options.viewerPort, 'viewerPort', false);
    this.leaseMs = options.leaseMs ?? REAUTH_LEASE_DEFAULT_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > REAUTH_LEASE_MAX_MS) {
      throw new RangeError(`leaseMs must be a positive safe integer no greater than ${REAUTH_LEASE_MAX_MS}`);
    }
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  get viewerPort(): number {
    return this.selectedViewerPort;
  }

  start(): Promise<ReauthLease> {
    return this.enqueue(async () => {
      if (this.phase === 'active' && this.lease) {
        if (Date.parse(this.lease.expiresAt) > this.now()) return this.lease;
        this.suppressProcessExit = true;
        try {
          await this.cleanupSession();
        } finally {
          this.suppressProcessExit = false;
        }
      }
      this.stopping = false;
      return this.startSession();
    });
  }

  stop(): Promise<void> {
    const stopping = this.enqueue(async () => {
      if (this.phase === 'idle') return;
      this.stopping = true;
      this.suppressProcessExit = true;
      try {
        await this.cleanupSession();
      } finally {
        this.suppressProcessExit = false;
      }
    });
    return stopping;
  }

  status(): ReauthStatus {
    const lease = this.lease;
    return {
      phase: this.phase,
      lease,
      expiresAt: lease?.expiresAt ?? null,
      remainingMs: lease ? Math.max(0, Date.parse(lease.expiresAt) - this.now()) : null
    };
  }

  dispose(): Promise<void> {
    return this.stop();
  }

  private watchProcess(handle: ReauthProcessHandle): void {
    const unsubscribe = handle.onExit(() => {
      if (this.suppressProcessExit || this.phase === 'stopping') return;
      if (this.phase === 'starting') {
        this.unexpectedProcessExit = handle.label;
        return;
      }
      if (this.phase !== 'active') return;
      this.logger.error(`Reauth process exited unexpectedly: ${handle.label}`);
      void this.stop();
    });
    this.processExitUnsubscribers.push(unsubscribe);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async startSession(): Promise<ReauthLease> {
    this.currentLeaseId = randomUUID();
    this.unexpectedProcessExit = undefined;
    this.setPhase('starting', this.currentLeaseId);
    const id = this.currentLeaseId;
    let stage: ReauthStartupStage = 'profile-lock';
    try {
      this.browserOwnership = true;
      await this.browser.beginInteractive();
      stage = 'temporary-files';
      this.tempDir = mkdtempSync(join(tmpdir(), 'marketplace-reauth-'));
      chmodSync(this.tempDir, 0o700);
      const password = generatePassword();
      this.passwordFile = join(this.tempDir, 'passwd');
      writeFileSync(this.passwordFile, password, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.passwordFile, 0o600);

      stage = 'xvfb';
      const display = await this.runtime.startDisplay();
      this.display = display.display;
      this.displayHandle = display.handle;
      this.watchProcess(this.displayHandle);
      if (this.unexpectedProcessExit) throw new Error(`Reauth process exited during startup: ${this.unexpectedProcessExit}`);
      if (this.stopping) throw new Error('Reauth session startup was stopped');
      stage = 'x11vnc';
      this.rfbPort = await this.runtime.allocatePort();
      validatePort(this.rfbPort, 'allocated RFB port', false);
      this.vncHandle = await this.runtime.startVnc({ display: this.display, port: this.rfbPort, passwordFile: this.passwordFile });
      this.watchProcess(this.vncHandle);
      if (this.unexpectedProcessExit) throw new Error(`Reauth process exited during startup: ${this.unexpectedProcessExit}`);
      if (this.stopping) throw new Error('Reauth session startup was stopped');
      stage = 'websockify';
      if (this.configuredViewerPort === undefined) this.selectedViewerPort = await this.runtime.allocatePort();
      validatePort(this.selectedViewerPort, 'viewerPort', false);
      this.viewerHandle = await this.runtime.startViewer({ port: this.selectedViewerPort, rfbPort: this.rfbPort });
      this.watchProcess(this.viewerHandle);
      if (this.unexpectedProcessExit) throw new Error(`Reauth process exited during startup: ${this.unexpectedProcessExit}`);
      if (this.stopping) throw new Error('Reauth session startup was stopped');

      stage = 'chromium';
      const context = await this.browser.openInteractive({ display: this.display, headless: !this.runtime.providesDisplay });
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      if (this.unexpectedProcessExit) throw new Error(`Reauth process exited during startup: ${this.unexpectedProcessExit}`);
      stage = 'facebook-navigation';
      await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (this.unexpectedProcessExit) throw new Error(`Reauth process exited during startup: ${this.unexpectedProcessExit}`);

      stage = 'lease';
      const startedAt = this.now();
      const expiresAt = startedAt + this.leaseMs;
      const lease: ReauthLease = {
        id,
        startedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        consoleUrl: `http://127.0.0.1:${this.selectedViewerPort}/vnc.html?autoconnect=1&resize=scale#password=${password}`,
        viewerPort: this.selectedViewerPort
      };
      if (this.unexpectedProcessExit) throw new Error(`Reauth process exited during startup: ${this.unexpectedProcessExit}`);
      if (this.stopping) throw new Error('Reauth session startup was stopped');
      this.lease = lease;
      this.setPhase('active', id);
      if (this.unexpectedProcessExit) {
        this.logger.error(`Reauth process exited unexpectedly: ${this.unexpectedProcessExit}`);
        void this.stop();
      }
      const expiryGeneration = ++this.leaseExpiryGeneration;
      // A one-shot timer can fire a hair before the wall clock reaches the deadline:
      // libuv timers run on a monotonic clock while this.now() is wall-clock, and the two
      // disagree by a millisecond often enough to matter (observed firing 1 ms early).
      // Dropping that wakeup stranded the lease as active forever, holding the browser
      // profile and the console past the TTL, so re-arm until the deadline has passed.
      const armExpiry = (): void => {
        const remaining = Math.max(0, expiresAt - this.now());
        this.ttlTimer = setTimeout(() => { void this.enqueue(async () => {
          const current = this.lease;
          if (expiryGeneration !== this.leaseExpiryGeneration || !current || current.id !== id) return;
          if (Date.parse(current.expiresAt) > this.now()) {
            armExpiry();
            return;
          }
          this.suppressProcessExit = true;
          try {
            await this.cleanupSession();
          } finally {
            this.suppressProcessExit = false;
          }
        }); }, remaining);
        this.ttlTimer.unref?.();
      };
      armExpiry();
      return lease;
    } catch (error) {
      const code = safeErrorCode(error);
      this.logger.error(`Reauth startup failed; stage ${stage}${code ? `; code ${code}` : ''}; phase rollback; lease ${id}`);
      this.suppressProcessExit = true;
      try {
        await this.cleanupSession();
      } finally {
        this.suppressProcessExit = false;
      }
      throw error;
    }
  }

  private cleanupSession(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const cleanup = this.performCleanup();
    this.cleanupPromise = cleanup;
    void cleanup.finally(() => {
      if (this.cleanupPromise === cleanup) this.cleanupPromise = undefined;
    }).catch(() => undefined);
    return cleanup;
  }

  private async performCleanup(): Promise<void> {
    const ownedLease = this.lease !== null || this.phase === 'starting' || this.phase === 'active' || this.phase === 'stopping' || this.browserOwnership;
    if (!ownedLease) return;
    this.setPhase('stopping', this.lease?.id ?? this.currentLeaseId);
    try {
      for (const unsubscribe of this.processExitUnsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // A custom runtime must not prevent the remaining cleanup.
        }
      }
      this.leaseExpiryGeneration += 1;
      if (this.ttlTimer) {
        clearTimeout(this.ttlTimer);
        this.ttlTimer = undefined;
      }
      try {
        await this.browser.closeInteractive();
      } catch {
        // Browser cleanup is best-effort; release the profile lock regardless.
      }
      const handles = [this.viewerHandle, this.vncHandle, this.displayHandle];
      this.viewerHandle = undefined;
      this.vncHandle = undefined;
      this.displayHandle = undefined;
      await Promise.all(handles.map((handle) => stopHandle(handle)));
      if (this.tempDir) {
        let removed = false;
        for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
          try {
            rmSync(this.tempDir, { recursive: true, force: true });
            removed = true;
          } catch {
            if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
        if (!removed) this.logger.error('Reauth temporary directory cleanup failed after retry');
      }
    } finally {
      this.tempDir = undefined;
      this.passwordFile = undefined;
      this.stopping = false;
      this.display = undefined;
      this.rfbPort = undefined;
      this.lease = null;
      if (ownedLease) this.browser.endInteractive();
      this.browserOwnership = false;
      this.setPhase('idle');
      this.currentLeaseId = undefined;
    }
  }

  private setPhase(phase: ReauthPhase, leaseId?: string): void {
    if (this.phase === phase) return;
    this.phase = phase;
    const identity = leaseId ?? this.lease?.id ?? this.currentLeaseId;
    this.logger.info(`Reauth phase ${phase}${identity ? `; lease ${identity}` : ''}${this.selectedViewerPort ? `; viewer port ${this.selectedViewerPort}` : ''}${this.rfbPort ? `; RFB port ${this.rfbPort}` : ''}`);
  }
}

interface SpawnedReauthProcess {
  readonly child: ChildProcess;
  readonly handle: ReauthProcessHandle;
  readonly outputSize: number;
  readonly safeOutputNotice: string;
}

function spawnProcess(
  binary: 'Xvfb' | 'x11vnc' | 'websockify',
  args: string[],
  options: { captureStdout?: boolean } = {}
): SpawnedReauthProcess {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let outputSize = 0;
  const capture = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    output += text;
    if (output.length > PROCESS_OUTPUT_LIMIT) output = output.slice(-PROCESS_OUTPUT_LIMIT);
    outputSize += Buffer.byteLength(text);
  };
  child.stdout?.on('data', (chunk) => {
    if (options.captureStdout !== false) capture(chunk);
  });
  child.stderr?.on('data', capture);
  let exited = false;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
  const safeOutputNotice = (): string => outputSize ? ' (process output captured)' : '';
  const exitListeners = new Set<() => void>();
  let stopPromise: Promise<void> | undefined;
  const notifyExit = (): void => {
    if (exited) return;
    exited = true;
    resolveExit();
    for (const listener of [...exitListeners]) listener();
    exitListeners.clear();
  };
  child.once('exit', notifyExit);
  child.once('error', notifyExit);
  const handle: ReauthProcessHandle = {
    label: binary,
    pid: child.pid,
    onExit: (listener) => {
      if (exited) {
        queueMicrotask(listener);
        return () => undefined;
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async (): Promise<void> => {
        try {
          if (!exited) child.kill('SIGTERM');
          if (!await waitForExit(exitPromise, 2_000) && !exited) child.kill('SIGKILL');
          await waitForExit(exitPromise, 2_000);
        } catch {
          // Process shutdown must never escape into the reauth cleanup path.
        }
      })();
      return stopPromise;
    }
  };
  return {
    child,
    handle,
    get outputSize() { return outputSize; },
    get safeOutputNotice() { return safeOutputNotice(); }
  };
}

export async function parseDisplayNumber(chunks: AsyncIterable<Buffer | string>, timeoutMs = PROCESS_START_TIMEOUT_MS): Promise<number> {
  let buffered = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Xvfb display number timed out')), timeoutMs);
    });
    return await Promise.race([(async () => {
      for await (const chunk of chunks) {
        buffered += chunk.toString();
        const newline = buffered.indexOf('\n');
        if (newline === -1) continue;
        const line = buffered.slice(0, newline).replace(/\r$/, '').trim();
        if (!/^\d+$/.test(line)) throw new Error('Xvfb did not return a valid display number');
        return Number(line);
      }
      throw new Error('Xvfb exited before returning a display number');
    })(), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForDisplayNumber(process: SpawnedReauthProcess): Promise<number> {
  const stdout = process.child.stdout;
  if (!stdout) throw new Error('Xvfb stdout is unavailable');
  return parseDisplayNumber(stdout);
}

async function waitForTcpPort(process: SpawnedReauthProcess, port: number, label: string): Promise<void> {
  await waitForReady<void>(process, label, PROCESS_START_TIMEOUT_MS, (resolve, reject, isDone) => {
    const poll = setInterval(() => {
      if (isDone()) return;
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => socket.destroy());
      socket.once('timeout', () => socket.destroy());
    }, 50);
    return () => clearInterval(poll);
  });
}

async function waitForViewer(process: SpawnedReauthProcess, port: number): Promise<void> {
  await waitForReady<void>(process, 'websockify', PROCESS_START_TIMEOUT_MS, (resolve, reject, isDone) => {
    const poll = setInterval(() => {
      if (isDone()) return;
      const request = createRequest({ host: '127.0.0.1', port, path: '/vnc.html', method: 'GET', timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
      });
      request.once('error', () => undefined);
      request.end();
    }, 75);
    return () => clearInterval(poll);
  });
}

function waitForReady<T>(
  process: SpawnedReauthProcess,
  label: string,
  timeoutMs: number,
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void, isDone: () => boolean) => () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const cleanupSubscription = subscribe((value) => finish(undefined, value), (error) => finish(error), () => done);
    const failure = (): Error => new Error(`${label} failed before becoming ready${process.safeOutputNotice}`);
    const onExit = (): void => finish(failure());
    const onError = (): void => finish(failure());
    const timer = setTimeout(() => finish(failure()), timeoutMs);
    process.child.once('exit', onExit);
    process.child.once('error', onError);
    function finish(error?: Error, value?: T): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanupSubscription();
      process.child.off('exit', onExit);
      process.child.off('error', onError);
      if (error) reject(error);
      else resolve(value as T);
    }
  });
}

async function stopHandle(handle: ReauthProcessHandle | undefined): Promise<void> {
  try {
    await handle?.stop();
  } catch {
    // Runtime handles are required to be best-effort, but custom runtimes may fail.
  }
}

function waitForExit(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function generatePassword(): string {
  const bytes = randomBytes(8);
  let password = '';
  for (const byte of bytes) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  return password;
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function validatePort(port: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(port) || port < (allowZero ? 0 : 1) || port > 65_535) {
    throw new RangeError(`${name} must be an integer ${allowZero ? 'between 0' : 'between 1'} and 65535`);
  }
}
