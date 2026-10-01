import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { BrowserSessionManager, BrowserSessionOptions } from '../src/browser.js';
import { BrowserSessionManager as BrowserManager, BrowserUnavailableError } from '../src/browser.js';
import type { MarketplaceBackend } from '../src/backend.js';
import { createMarketplaceService, type MarketplaceService } from '../src/service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
const profileDirs: string[] = [];
const managers: BrowserSessionManager[] = [];

beforeAll(async () => {
  synthetic = await startSyntheticServer();
});

afterAll(async () => {
  await synthetic?.close();
});

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  synthetic.requests.length = 0;
});

describe('browser launch args', () => {
  it('rejects remote debugging arguments with one or two leading dashes', () => {
    for (const argument of ['-remote-debugging-port=0', '--remote-debugging-pipe', '--remote-allow-origins=*']) {
      expect(() => new BrowserManager({ launchArgs: [argument] })).toThrow(TypeError);
    }
  });
});

describe.skipIf(!browserAvailable)('browser session manager', () => {
  it('starts lazily and does not navigate before first use', async () => {
    const manager = createManager();
    expect(manager.getInfo().status).toBe('profile_missing');
    expect(synthetic.requests).toEqual([]);

    const title = await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    });

    expect(title).toBe('synthetic');
    expect(manager.getInfo().browserStarted).toBe(true);
    expect(manager.getInfo().status).toBe('session_unknown');
    expect(synthetic.requests.filter((pathname) => pathname !== '/favicon.ico')).toEqual(['/']);
  });

  it('reports unexpected browser closure and relaunches on the next operation', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    });

    manager.assessSession('session_usable');
    expect(manager.getInfo().status).toBe('session_usable');
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.context().close();
    });

    expect(manager.getInfo()).toMatchObject({ status: 'browser_unavailable', browserStarted: false });
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
    expect(manager.getInfo().browserStarted).toBe(true);
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('persists localStorage and persistent cookies across browser restarts', async () => {
    const profileDir = makeProfileDir();
    const first = makeManager(profileDir);
    await first.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/set-state`);
      await page.waitForFunction(() => localStorage.getItem('marketplace-fixture') === 'persisted');
    });
    await first.close();

    const second = makeManager(profileDir);
    const persisted = await second.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      const localStorageValue = await page.evaluate(() => localStorage.getItem('marketplace-fixture'));
      const cookies = await page.context().cookies(synthetic.origin);
      return { localStorageValue, cookie: cookies.find(({ name }) => name === 'marketplace')?.value };
    });

    expect(persisted).toEqual({ localStorageValue: 'persisted', cookie: 'ok' });
  });

  it('serializes concurrent operations without overlap', async () => {
    const manager = createManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstIsBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstHasStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = manager.runExclusive(new AbortController().signal, async () => {
      order.push('a:start');
      firstStarted();
      await firstIsBlocked;
      order.push('a:end');
    });
    await firstHasStarted;
    const second = manager.runExclusive(new AbortController().signal, async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('bounds a hanging page close and releases the mutex after abort', async () => {
    const manager = createManager({ settleTimeoutMs: 200 });
    const controller = new AbortController();
    const startedAt = Date.now();
    const operation = manager.runExclusive(controller.signal, async (page) => {
      page.close = () => new Promise<void>(() => undefined);
      controller.abort(new Error('test cancellation'));
    });

    await expect(operation).rejects.toThrow('test cancellation');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
  });

  it('bounds a hanging context page creation', async () => {
    const manager = createManager({ settleTimeoutMs: 200 });
    await manager.runExclusive(new AbortController().signal, async (page) => {
      page.context().newPage = () => new Promise<typeof page>(() => undefined);
    });

    const startedAt = Date.now();
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined))
      .rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('cancels an in-flight page operation and releases the mutex', async () => {
    const manager = createManager();
    const controller = new AbortController();
    const startedAt = Date.now();
    const operation = manager.runExclusive(controller.signal, async (page, signal) => {
      await page.goto(`${synthetic.origin}/slow`, { timeout: 60_000, signal } as Parameters<typeof page.goto>[1]);
    });
    await waitForRequest('/slow');
    controller.abort(new Error('test cancellation'));

    await expect(operation).rejects.toThrow('test cancellation');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
  });

  it('shuts down promptly and rejects future operations', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    });
    const startedAt = Date.now();
    await manager.close();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(manager.getInfo().status).toBe('browser_unavailable');
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('reports launch failures when the profile path is a regular file', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'marketplace-browser-test-'));
    profileDirs.push(parent);
    const profileFile = join(parent, 'not-a-directory');
    writeFileSync(profileFile, 'synthetic');
    const manager = makeManager(profileFile);

    expect(manager.getInfo().profileExisted).toBe(true);
    expect(manager.getInfo().status).toBe('session_unknown');
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(manager.getInfo().status).toBe('browser_unavailable');

    rmSync(profileFile);
    mkdirSync(profileFile);
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('round-trips provider assessments and rejects invalid values', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    });

    manager.assessSession('session_usable');
    expect(manager.getInfo().status).toBe('session_usable');
    manager.assessSession('session_needs_reauth');
    expect(manager.getInfo().status).toBe('session_needs_reauth');
    expect(() => manager.assessSession('profile_missing' as never)).toThrow(RangeError);
  });

  it('intercepts and records a blocked external navigation', async () => {
    const manager = createManager();
    const seen: string[] = [];
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.route('**', (route) => {
        seen.push(route.request().url());
        return route.abort();
      });
      await expect(page.goto('https://www.facebook.com/')).rejects.toThrow();
    });
    expect(seen).toEqual(['https://www.facebook.com/']);
  });

  it('aborts browser work at the service backend deadline and closes the browser on shutdown', async () => {
    const manager = createManager();
    const backend: MarketplaceBackend = {
      name: 'browser-deadline-test',
      search: async (_input, signal) => {
        await manager.runExclusive(signal, async (page) => {
          await page.goto(`${synthetic.origin}/slow`, { timeout: 60_000, signal } as Parameters<typeof page.goto>[1]);
        });
        return [];
      },
      fetch: () => null
    };
    const service = createMarketplaceService({
      host: '127.0.0.1',
      port: 0,
      backend,
      backendTimeoutMs: 500,
      browser: manager
    });
    let client: Client | undefined;
    try {
      await listen(service);
      const address = service.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      client = new Client({ name: 'marketplace-browser-deadline-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      const result = await client.callTool({ name: 'marketplace_search', arguments: { query: 'synthetic', location: 'test' } });
      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: 'TIMEOUT', message: 'The backend operation exceeded its deadline.' }
      });
      await expect(manager.runExclusive(new AbortController().signal, async (page) => {
        await page.goto(`${synthetic.origin}/`);
        return page.title();
      })).resolves.toBe('synthetic');

      const startedAt = Date.now();
      await service.close();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(service.browser.getInfo().status).toBe('browser_unavailable');
      await expect(service.browser.runExclusive(new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BrowserUnavailableError);
    } finally {
      await client?.close().catch(() => undefined);
      await service.close();
    }
  });
});

function createManager(options: BrowserSessionOptions = {}): BrowserSessionManager {
  return makeManager(makeProfileDir(), options);
}

function makeManager(profileDir: string, options: BrowserSessionOptions = {}): BrowserSessionManager {
  const manager = new BrowserManager({ ...options, profileDir, logger: { error: () => undefined } });
  managers.push(manager);
  return manager;
}

function makeProfileDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-browser-test-'));
  profileDirs.push(parent);
  const profileDir = join(parent, 'profile');
  return profileDir;
}

async function startSyntheticServer(): Promise<SyntheticServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (pathname === '/slow') return;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/set-state') {
      response.end('<!doctype html><html><head><title>state</title></head><body><script>localStorage.setItem("marketplace-fixture", "persisted"); document.cookie = "marketplace=ok; path=/; max-age=3600";</script></body></html>');
      return;
    }
    response.end('<!doctype html><html><head><title>synthetic</title></head><body>fixture</body></html>');
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function waitForRequest(pathname: string): Promise<void> {
  if (synthetic.requests.includes(pathname)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for request ${pathname} after 5000 ms`));
    }, 5_000);
    const poll = setInterval(() => {
      if (synthetic.requests.includes(pathname)) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}

async function listen(service: MarketplaceService): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(service.port, service.host, resolve);
  });
}
