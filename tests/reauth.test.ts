import type { ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager, BrowserUnavailableError, type BrowserSessionOptions } from '../src/browser.js';
import { createReauthAdminServer } from '../src/admin.js';
import { assertFacebookOrigin } from '../src/facebook.js';
import { parseDisplayNumber, ReauthManager } from '../src/reauth.js';
import { FakeReauthRuntime } from './helpers/fake-reauth-runtime.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

type SyntheticServer = {
  server: Server;
  origin: string;
  requests: string[];
  close(): Promise<void>;
};

let synthetic: SyntheticServer;
const managers: BrowserSessionManager[] = [];
const profileDirs: string[] = [];
const runtimes: FakeReauthRuntime[] = [];

beforeAll(async () => {
  synthetic = await startSyntheticServer();
});

afterAll(async () => {
  await synthetic?.close();
});

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stopAll()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  synthetic.requests.length = 0;
});

function makeRuntime(): FakeReauthRuntime {
  const runtime = new FakeReauthRuntime();
  runtimes.push(runtime);
  return runtime;
}

function makeManager(options: BrowserSessionOptions = {}): BrowserSessionManager {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-reauth-test-'));
  profileDirs.push(parent);
  const manager = new BrowserSessionManager({
    ...options,
    profileDir: join(parent, 'profile'),
    logger: { error: () => undefined }
  });
  managers.push(manager);
  return manager;
}

function makeReauth(browser: BrowserSessionManager, runtime: FakeReauthRuntime, options: Partial<ConstructorParameters<typeof ReauthManager>[0]> = {}): ReauthManager {
  return new ReauthManager({
    browser,
    runtime,
    targetUrl: `${synthetic.origin}/set-state`,
    logger: { error: () => undefined, info: () => undefined },
    ...options
  });
}

const browserTests = describe.skipIf(!browserAvailable);
browserTests('reauth manager with Chromium', () => {
  it('exclusively owns the profile, rejects browser work quickly, and exposes interactive state', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    await reauth.start();

    expect(browser.getInfo()).toMatchObject({ status: 'session_unknown', interactive: true, browserStarted: true });
    const startedAt = Date.now();
    const failure = await browser.runExclusive(new AbortController().signal, async () => undefined).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await reauth.stop();
  });

  it('rejects queued profile work after interactive ownership is acquired', async () => {
    const browser = makeManager();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondExecuted = false;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = browser.runExclusive(new AbortController().signal, async () => {
      firstStarted();
      await blocked;
    });
    await started;
    const second = browser.runExclusive(new AbortController().signal, async () => { secondExecuted = true; });
    const begin = browser.beginInteractive();

    releaseFirst();
    await first;
    await expect(second).rejects.toBeInstanceOf(BrowserUnavailableError);
    await begin;
    expect(secondExecuted).toBe(false);
    browser.endInteractive();
  });

  it('rejects new work immediately while an earlier browser task is queued', async () => {
    const browser = makeManager();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const first = browser.runExclusive(new AbortController().signal, async () => {
      started();
      await blocked;
    });
    await startedPromise;
    const begin = browser.beginInteractive();
    const beganAt = Date.now();
    const queued = browser.runExclusive(new AbortController().signal, async () => undefined);
    await expect(queued).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(Date.now() - beganAt).toBeLessThan(250);
    release();
    await Promise.all([first, begin]);
    await browser.endInteractive();
  });

  it('creates a private password file and removes it on stop', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    const lease = await reauth.start();
    const password = new URL(lease.consoleUrl).hash.match(/password=([^&]+)/)?.[1];
    expect(password).toBeTruthy();
    expect(runtime.passwordFile).toBeTruthy();
    const passwordFile = runtime.passwordFile as string;
    const stat = statSync(passwordFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(passwordFile, 'utf8')).toBe(password);
    const tempDir = dirname(passwordFile);
    await reauth.stop();
    expect(existsSync(tempDir)).toBe(false);
  });

  it('removes the password directory after TTL expiry and failed startup', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime, { leaseMs: 30 });
    await reauth.start();
    const expiredDir = dirname(runtime.passwordFile as string);
    await waitForPhase(reauth, 'idle');
    expect(existsSync(expiredDir)).toBe(false);

    const failedRuntime = makeRuntime();
    failedRuntime.failVnc = true;
    const failed = makeReauth(makeManager(), failedRuntime);
    await expect(failed.start()).rejects.toThrow('synthetic VNC startup failure');
    expect(existsSync(dirname(failedRuntime.passwordFile as string))).toBe(false);
  });

  it('persists manual interaction state in the shared profile and makes only loopback requests', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    await reauth.start();
    expect(synthetic.requests).toContain('/set-state');
    await reauth.stop();

    const persisted = await browser.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      const localStorageValue = await page.evaluate(() => localStorage.getItem('marketplace-reauth'));
      const cookies = await page.context().cookies(synthetic.origin);
      return { localStorageValue, cookie: cookies.find(({ name }) => name === 'reauth')?.value };
    });
    expect(persisted).toEqual({ localStorageValue: 'persisted', cookie: 'ok' });
    expect(synthetic.requests.filter((path) => path !== '/favicon.ico')).toEqual(['/set-state', '/']);
    expect(synthetic.requests.every((path) => path.startsWith('/'))).toBe(true);
  });

  it('clears a pre-lease usable assessment only after taking ownership', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    await browser.runExclusive(new AbortController().signal, async () => undefined);
    browser.assessSession('session_usable');
    expect(browser.getInfo().status).toBe('session_usable');
    const lease = await reauth.start();
    expect(lease.id).toBeTruthy();
    expect(browser.getInfo()).toMatchObject({ status: 'session_unknown', interactive: true });
    await reauth.stop();
    expect(browser.getInfo().status).toBe('session_unknown');
  });

  it('does not clear a usable assessment when stopped while idle', async () => {
    const browser = makeManager();
    await browser.runExclusive(new AbortController().signal, async () => undefined);
    browser.assessSession('session_usable');
    const reauth = makeReauth(browser, makeRuntime());
    await reauth.stop();
    expect(browser.getInfo().status).toBe('session_usable');
  });

  it('does not reuse a fast-path lease after its expiry if the TTL callback has not run', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    let now = 1_800_000_000_000;
    const reauth = makeReauth(browser, runtime, { leaseMs: 60_000, now: () => now });
    const first = await reauth.start();
    const firstChildren = runtime.children.length;
    now = Date.parse(first.expiresAt) + 1;

    const second = await reauth.start();
    expect(second.id).not.toBe(first.id);
    expect(runtime.children.length).toBe(firstChildren + 3);
    expect(reauth.status()).toMatchObject({ phase: 'active', lease: { id: second.id } });
    await reauth.stop();
  });

  it('bounds a stalled interactive context close during stop and permits a later lease', async () => {
    const browser = makeManager({ settleTimeoutMs: 200, launchTimeoutMs: 5_000 });
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    const firstLease = await reauth.start();
    const context = browser.interactiveContext();
    expect(context).toBeDefined();
    const originalClose = context?.close.bind(context);
    let releaseClose!: () => void;
    if (context) context.close = () => new Promise<void>((resolve) => { releaseClose = resolve; });

    try {
      const startedAt = Date.now();
      await expectCompletesWithin(reauth.stop(), 3_000);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(reauth.status()).toMatchObject({ phase: 'idle', lease: null });
      expect(browser.getInfo()).toMatchObject({ status: 'session_unknown', browserStarted: false });
      expect(browser.getInfo().interactive).not.toBe(true);
      expect(browser.interactiveContext()).toBeUndefined();

      await browser.runExclusive(new AbortController().signal, async (page) => { await page.goto('about:blank'); });
      expect(browser.getInfo().browserStarted).toBe(true);
      const laterLease = await reauth.start();
      expect(laterLease.id).not.toBe(firstLease.id);
      expect(reauth.status()).toMatchObject({ phase: 'active', lease: { id: laterLease.id } });
      await reauth.stop();
    } finally {
      if (context && originalClose) context.close = originalClose;
      releaseClose?.();
      await reauth.stop();
    }
  }, 10_000);

  it('bounds a stalled interactive context close during TTL expiry and permits a later lease', async () => {
    const browser = makeManager({ settleTimeoutMs: 200, launchTimeoutMs: 5_000 });
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime, { leaseMs: 100 });
    const firstLease = await reauth.start();
    const context = browser.interactiveContext();
    expect(context).toBeDefined();
    const originalClose = context?.close.bind(context);
    let releaseClose!: () => void;
    if (context) context.close = () => new Promise<void>((resolve) => { releaseClose = resolve; });

    try {
      const startedAt = Date.now();
      await waitForPhase(reauth, 'idle', 3_000);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(reauth.status()).toMatchObject({ phase: 'idle', lease: null, expiresAt: null });
      expect(browser.getInfo()).toMatchObject({ status: 'session_unknown', browserStarted: false });
      expect(browser.getInfo().interactive).not.toBe(true);
      expect(browser.interactiveContext()).toBeUndefined();

      const laterLease = await reauth.start();
      expect(laterLease.id).not.toBe(firstLease.id);
      expect(reauth.status()).toMatchObject({ phase: 'active', lease: { id: laterLease.id } });
      await reauth.stop();
      expect(runtime.children.every(isProcessGone)).toBe(true);
    } finally {
      if (context && originalClose) context.close = originalClose;
      releaseClose?.();
      await reauth.stop();
    }
  }, 10_000);

  it('re-arms the lease expiry when the TTL timer fires before the clock reaches the deadline', async () => {
    const browser = makeManager({ settleTimeoutMs: 200, launchTimeoutMs: 5_000 });
    const runtime = makeRuntime();
    const origin = Date.now();
    // A half-speed clock makes the TTL timer fire while the injected clock still reports
    // the lease as unexpired. That is the same timer/clock divergence that drops a real
    // expiry (observed firing 1 ms early), just deterministic: one early one-shot fire
    // must not be able to lose the expiry.
    const reauth = makeReauth(browser, runtime, {
      leaseMs: 100,
      now: () => origin + (Date.now() - origin) / 2
    });
    await reauth.start();

    await waitForPhase(reauth, 'idle', 3_000);
    expect(reauth.status()).toMatchObject({ phase: 'idle', lease: null, expiresAt: null });
    expect(browser.getInfo().interactive).not.toBe(true);
    expect(runtime.children.every(isProcessGone)).toBe(true);
  }, 10_000);

  it('expires a lease through the same cleanup path as stop', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    let now = 1_800_000_000_000;
    const reauth = makeReauth(browser, runtime, { leaseMs: 25, now: () => now });
    const lease = await reauth.start();
    now = Date.parse(lease.expiresAt);
    await waitForPhase(reauth, 'idle');
    expect(reauth.status()).toMatchObject({ phase: 'idle', lease: null, expiresAt: null, remainingMs: null });
    expect(browser.getInfo().interactive).not.toBe(true);
    expect(runtime.children.every(isProcessGone)).toBe(true);
  });

  it('coalesces concurrent starts while startup is in flight', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    let release!: () => void;
    let started!: () => void;
    runtime.delayDisplay = new Promise<void>((resolve) => { release = resolve; });
    runtime.onStartDisplay = () => started();
    const displayStarted = new Promise<void>((resolve) => { started = resolve; });
    const reauth = makeReauth(browser, runtime);
    const first = reauth.start();
    await displayStarted;
    const second = reauth.start();
    release();
    const [lease1, lease2] = await Promise.all([first, second]);
    expect(lease1.id).toBe(lease2.id);
    expect(runtime.children).toHaveLength(3);
    await reauth.stop();
  });

  it('bounds concurrent handle shutdown within the service shutdown budget', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    await reauth.start();
    let stopCount = 0;
    let releaseStops!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStops = resolve; });
    for (const handle of runtime.startedHandles) {
      const stop = handle.stop.bind(handle);
      handle.stop = async () => {
        stopCount += 1;
        await stopGate;
        await stop();
      };
    }

    const stopping = reauth.stop();
    try {
      await waitFor(() => stopCount === 3);
      expect(stopCount).toBe(3);
    } finally {
      releaseStops();
    }
    await stopping;
    expect(runtime.children.every(isProcessGone)).toBe(true);
  });

  it('finishes cleanup when a custom process handle unsubscribe throws', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    await reauth.start();
    runtime.throwOnUnsubscribe = true;

    await expect(reauth.stop()).resolves.toBeUndefined();
    expect(reauth.status()).toMatchObject({ phase: 'idle', lease: null });
    expect(runtime.children.every(isProcessGone)).toBe(true);
    expect(browser.getInfo().interactive).not.toBe(true);
  });

  it('cleans up when a child exits unexpectedly during an active lease', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const errors: string[] = [];
    const reauth = makeReauth(browser, runtime, { logger: { error: (message) => errors.push(String(message)), info: () => undefined } });
    await reauth.start();
    runtime.kill();
    await waitForPhase(reauth, 'idle');
    expect(reauth.status().lease).toBeNull();
    expect(browser.getInfo().interactive).not.toBe(true);
    expect(errors.some((message) => message.includes('exited unexpectedly'))).toBe(true);
    expect(runtime.children.every(isProcessGone)).toBe(true);
  });

  it('orders stop after a start that was queued before it', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    runtime.blockViewer = true;
    const reauth = makeReauth(browser, runtime);
    const start = reauth.start();
    await waitFor(() => runtime.children.length === 2);
    const stop = reauth.stop();
    runtime.unblockViewer();
    const [startResult] = await Promise.allSettled([start]);
    await stop;
    expect(startResult.status).toBe('fulfilled');
    expect(reauth.status().phase).toBe('idle');
    expect(runtime.children.every(isProcessGone)).toBe(true);
  });

  it('keeps repeated start and stop idempotent and permits a later lease', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    const first = await reauth.start();
    const firstContext = browser.interactiveContext();
    expect(firstContext).toBeDefined();
    const childCount = runtime.children.length;
    const duplicate = await reauth.start();
    expect(duplicate.id).toBe(first.id);
    expect(runtime.children).toHaveLength(childCount);
    await Promise.all([reauth.stop(), reauth.stop()]);
    await expect(reauth.stop()).resolves.toBeUndefined();
    expect(firstContext?.isClosed()).toBe(true);
    expect(browser.interactiveContext()).toBeUndefined();
    const second = await reauth.start();
    expect(second.id).not.toBe(first.id);
    const secondContext = browser.interactiveContext();
    expect(secondContext).toBeDefined();
    await reauth.stop();
    expect(secondContext?.isClosed()).toBe(true);
    expect(browser.interactiveContext()).toBeUndefined();
    expect(browser.getInfo()).toMatchObject({ status: 'session_unknown', browserStarted: false });
  });

  it('dispose terminates every fake child and repeated stop leaves no process behind', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    await reauth.start();
    const pids = runtime.children.map((child) => child.pid);
    await reauth.dispose();
    await reauth.stop();
    expect(pids.every((pid) => pid !== undefined && !isPidAlive(pid))).toBe(true);
  });

  it('rolls back all resources after a runtime startup failure', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    runtime.failViewer = true;
    const reauth = makeReauth(browser, runtime);
    await expect(reauth.start()).rejects.toThrow('synthetic viewer startup failure');
    expect(reauth.status().phase).toBe('idle');
    expect(runtime.children.every(isProcessGone)).toBe(true);
    await expect(browser.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    })).resolves.toBeUndefined();
  });
});

it('waits for a complete Xvfb display-number line across chunk boundaries', async () => {
  async function* chunks(): AsyncGenerator<string> {
    yield '1';
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    yield '9\n';
  }
  await expect(parseDisplayNumber(chunks(), 200)).resolves.toBe(19);
});

it('validates Facebook or loopback origins only', () => {
  expect(assertFacebookOrigin('https://www.facebook.com/marketplace/')).toBe('https://www.facebook.com/marketplace/');
  expect(assertFacebookOrigin('http://127.0.0.1:3000/test')).toBe('http://127.0.0.1:3000/test');
  expect(() => assertFacebookOrigin('https://example.com/')).toThrow(TypeError);
});

browserTests('reauth admin listener', () => {
  it('binds only to loopback and serves start, status, and stop routes', async () => {
    const browser = makeManager();
    const runtime = makeRuntime();
    const reauth = makeReauth(browser, runtime);
    const admin = createReauthAdminServer({ reauth, logger: { error: () => undefined } });
    try {
      await listenAdmin(admin);
      const address = admin.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      expect(admin.host).toBe('127.0.0.1');
      expect(address.address).toBe('127.0.0.1');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const status = await fetch(`${baseUrl}/reauth/status`);
      expect(status.status).toBe(200);
      expect(status.headers.get('cache-control')).toBe('no-store');
      expect(await status.json()).toMatchObject({ phase: 'idle' });
      expect((await fetch(`${baseUrl}/reauth/status`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/reauth/status`, { headers: { origin: 'https://hostile.example' } })).status).toBe(403);
      expect((await rawAdminRequest(address.port, '/reauth/status', { Host: 'attacker.example' })).status).toBe(403);
      for (const host of ['localhost', '127.0.0.1:8080', '[::1]', '[::1]:8080', '::1', '::1:8080']) {
        expect((await rawAdminRequest(address.port, '/reauth/status', { Host: host })).status).toBe(200);
      }
      for (const host of ['0177.0.0.1', '2130706433', '127.1', '127.0.0.1.', '0:0:0:0:0:0:0:1', '127.0.0.1:', '[::1]:99999']) {
        expect((await rawAdminRequest(address.port, '/reauth/status', { Host: host })).status).toBe(403);
      }

      const nonLoopback = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
      if (nonLoopback) {
        await expect(connectOnce(nonLoopback, address.port)).rejects.toThrow();
      }

      expect((await rawAdminRequest(address.port, '/reauth/status', { Host: 'localhost.evil' })).status).toBe(403);
      expect((await rawAdminRequest(address.port, '/reauth/status', { Host: '127.0.0.1:99999' })).status).toBe(403);
      // The pending body-read promise is private; without a test-only production hook we cannot observe whether its close handler settled it.
      // This verifies the aborted socket is released and the server stays responsive, not that the handler promise itself was reclaimed.
      const activeSockets = trackAdminSockets(admin.server);
      const abortedClientPort = await disconnectDuringAdminBody(address.port);
      await waitFor(() => !activeSockets.has(abortedClientPort));
      const afterAbortStartedAt = Date.now();
      const afterAbort = await fetch(`${baseUrl}/reauth/status`);
      expect(Date.now() - afterAbortStartedAt).toBeLessThan(2_000);
      expect(afterAbort.status).toBe(200);
      expect(await afterAbort.json()).toMatchObject({ phase: 'idle' });
      const startResponse = await fetch(`${baseUrl}/reauth/start`, { method: 'POST' });
      expect(startResponse.status).toBe(200);
      expect(await startResponse.json()).toMatchObject({ phase: 'active', lease: { id: expect.any(String) } });
      const stopResponse = await fetch(`${baseUrl}/reauth/stop`, { method: 'POST' });
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toMatchObject({ phase: 'idle', lease: null });
    } finally {
      await admin.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

async function expectCompletesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not complete within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function disconnectDuringAdminBody(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.write('POST /reauth/start HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nContent-Length: 100\\r\\n\\r\\npartial');
      setTimeout(() => socket.destroy(), 10);
    });
    socket.once('close', () => resolve(socket.localPort ?? -1));
    socket.once('error', (error) => {
      socket.destroy();
      if (socket.connecting) reject(error);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error('Timed out disconnecting incomplete admin request'));
    });
  });
}

function trackAdminSockets(server: Server): Set<number> {
  const sockets = new Set<number>();
  server.on('connection', (socket) => {
    const clientPort = socket.remotePort;
    if (clientPort === undefined) return;
    sockets.add(clientPort);
    socket.once('close', () => sockets.delete(clientPort));
  });
  return sockets;
}

async function rawAdminRequest(port: number, path: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitForPhase(reauth: ReauthManager, phase: 'idle', timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (reauth.status().phase !== phase && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(reauth.status().phase).toBe(phase);
}

function isProcessGone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startSyntheticServer(): Promise<SyntheticServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/set-state') {
      response.end('<!doctype html><html><head><title>reauth-state</title></head><body><script>localStorage.setItem("marketplace-reauth", "persisted"); document.cookie = "reauth=ok; path=/; max-age=3600";</script></body></html>');
      return;
    }
    response.end('<!doctype html><html><head><title>synthetic</title></head><body>fixture</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected synthetic TCP address');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function listenAdmin(admin: ReturnType<typeof createReauthAdminServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    admin.server.once('error', reject);
    admin.server.listen(admin.port, admin.host, resolve);
  });
}

async function connectOnce(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error('connection timed out'));
    });
  });
}
