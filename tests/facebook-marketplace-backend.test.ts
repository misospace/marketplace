import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError } from '../src/backend.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { searchInputSchema, fetchInputSchema } from '../src/domain.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

const fixtureNames = [
  'results-normal.html', 'results-multi-currency.html', 'results-vehicle.html', 'results-sponsored.html',
  'results-missing-price.html', 'results-sold-pending.html', 'results-duplicate.html', 'results-malformed.html',
  'results-all-malformed.html', 'no-results.html', 'layout-changed.html', 'login.html', 'checkpoint.html',
  'captcha.html', 'rate-limited.html'
] as const;
type FixtureName = typeof fixtureNames[number];
const fixtures = new Map<FixtureName, string>(fixtureNames.map((name) => [
  name,
  readFileSync(new URL(`./fixtures/facebook-marketplace/${name}`, import.meta.url), 'utf8')
]));

type SyntheticServer = {
  server: Server;
  origin: string;
  requests: string[];
  configure(probeFile: FixtureName, searchFile: FixtureName, hangSearch?: boolean, probeHtml?: string): void;
  close(): Promise<void>;
};

let synthetic: SyntheticServer;
const managers: BrowserSessionManager[] = [];
const profileDirs: string[] = [];

beforeAll(async () => {
  synthetic = await startSyntheticServer();
});

afterAll(async () => {
  await synthetic?.close();
});

afterEach(async () => {
  expect(synthetic.requests.every((request) => /^\/marketplace\/(?:[a-z0-9-]+\/search\/)?(?:\?.*)?$/.test(request))).toBe(true);
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  synthetic.requests.length = 0;
});

function createBackend(options: { navigationTimeoutMs?: number; settleTimeoutMs?: number } = {}): {
  backend: FacebookMarketplaceBackend;
  browser: BrowserSessionManager;
} {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-facebook-test-'));
  profileDirs.push(parent);
  const browser = new BrowserSessionManager({
    profileDir: join(parent, 'profile'),
    launchArgs: ['--host-resolver-rules=MAP * 127.0.0.1', '--disable-background-networking'],
    launchTimeoutMs: 10_000,
    settleTimeoutMs: 1_000,
    logger: { error: () => undefined }
  });
  managers.push(browser);
  const probe = new FacebookSessionProbe({ browser, baseUrl: synthetic.origin, navigationTimeoutMs: 5_000, settleTimeoutMs: 100 });
  return {
    browser,
    backend: new FacebookMarketplaceBackend({
      browser,
      probe,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 5_000,
      settleTimeoutMs: options.settleTimeoutMs ?? 50,
      logger: { error: () => undefined }
    })
  };
}

function searchInput(overrides: Record<string, unknown> = {}) {
  return searchInputSchema.parse({ query: 'bike', location: 'New York City', ...overrides });
}

function expectProviderError(promise: Promise<unknown>, code: ProviderError['code']) {
  return expect(promise).rejects.toMatchObject({ name: 'ProviderError', code });
}

describe.skipIf(!browserAvailable)('Facebook Marketplace backend', () => {
  it('searches using canonical loopback URLs and applies the result limit', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    const { backend } = createBackend();
    const listings = await backend.search(searchInput({ limit: 1 }), new AbortController().signal);

    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      id: '100000000000001',
      url: `${synthetic.origin}/marketplace/item/100000000000001/`,
      title: 'Trek Marlin 5 mountain bike',
      price: 450,
      currency: 'USD',
      state: 'unknown'
    });
    expect(synthetic.requests).toEqual([
      '/marketplace/',
      '/marketplace/nyc/search/?query=bike'
    ]);
  });

  it.each([
    ['login.html', 'LOGIN_REQUIRED'],
    ['checkpoint.html', 'SESSION_INVALID'],
    ['captcha.html', 'CAPTCHA_REQUIRED']
  ] as const)('maps a %s session probe to %s before searching', async (fixture, code) => {
    synthetic.configure(fixture, 'results-normal.html');
    const { backend } = createBackend();
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), code);
    expect(synthetic.requests).toEqual(['/marketplace/']);
  });

  it('fails closed for an unknown probe without navigating to search', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html', false, '<!doctype html><html><body><main><p>Unclassified synthetic interstitial</p></main></body></html>');
    const { backend, browser } = createBackend();
    browser.assessSession('session_usable');
    const operation = backend.search(searchInput(), new AbortController().signal);
    await expect(operation).rejects.toMatchObject({ name: 'ProviderError', code: 'SESSION_INVALID' });
    expect(synthetic.requests).toEqual(['/marketplace/']);
  });

  it('detects authentication loss on the search page', async () => {
    synthetic.configure('results-normal.html', 'login.html');
    const { backend } = createBackend();
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), 'LOGIN_REQUIRED');
    expect(synthetic.requests).toEqual(['/marketplace/', '/marketplace/nyc/search/?query=bike']);
  });

  it('returns a typed upstream error rather than treating an unknown layout as empty', async () => {
    synthetic.configure('results-normal.html', 'layout-changed.html');
    const { backend } = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), 'UPSTREAM_ERROR');
  });

  it('maps a rate-limit page to RATE_LIMITED', async () => {
    synthetic.configure('results-normal.html', 'rate-limited.html');
    const { backend } = createBackend();
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), 'RATE_LIMITED');
  });

  it('returns an empty list for a recognized no-results page', async () => {
    synthetic.configure('results-normal.html', 'no-results.html');
    const { backend } = createBackend();
    await expect(backend.search(searchInput(), new AbortController().signal)).resolves.toEqual([]);
  });

  it('rejects all-malformed result cards but keeps good cards from mixed results', async () => {
    synthetic.configure('results-normal.html', 'results-all-malformed.html');
    const { backend } = createBackend();
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), 'UPSTREAM_ERROR');

    synthetic.configure('results-normal.html', 'results-malformed.html');
    const { backend: mixedBackend } = createBackend();
    const listings = await mixedBackend.search(searchInput(), new AbortController().signal);
    expect(listings.map(({ id }) => id)).toEqual(['100000000000022', '100000000000023']);
  });

  it('deduplicates cards with the same canonical item id', async () => {
    synthetic.configure('results-normal.html', 'results-duplicate.html');
    const { backend } = createBackend();
    const listings = await backend.search(searchInput(), new AbortController().signal);
    expect(listings.map(({ id }) => id)).toEqual(['100000000000020', '100000000000021']);
  });

  it('applies price bounds and excludes listings with a null price', async () => {
    synthetic.configure('results-normal.html', 'results-missing-price.html');
    const { backend } = createBackend();
    const listings = await backend.search(searchInput({ min_price: 100, max_price: 200 }), new AbortController().signal);
    expect(listings.map(({ id, price }) => ({ id, price }))).toEqual([{ id: '100000000000014', price: 175 }]);
  });

  it('rejects an unresolvable location without navigating', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    const { backend } = createBackend();
    await expectProviderError(backend.search(searchInput({ location: 'unmapped town' }), new AbortController().signal), 'UPSTREAM_ERROR');
    expect(synthetic.requests).toEqual([]);
  });

  it('honors cancellation promptly with the exact abort reason', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html', true);
    const { backend } = createBackend({ navigationTimeoutMs: 15_000 });
    const controller = new AbortController();
    const reason = new Error('cancel Facebook search');
    const operation = backend.search(searchInput(), controller.signal);
    await waitForRequest('/marketplace/nyc/search/');
    const startedAt = Date.now();
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(synthetic.requests).toEqual(['/marketplace/', '/marketplace/nyc/search/?query=bike']);
  });

  it('logs only the error name for unexpected search failures', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    const { backend, browser } = createBackend();
    const probe = new FacebookSessionProbe({ browser, baseUrl: synthetic.origin, navigationTimeoutMs: 5_000, settleTimeoutMs: 100 });
    const logger = { error: vi.fn() };
    const loggingBackend = new FacebookMarketplaceBackend({ browser, probe, logger });
    const runExclusive = browser.runExclusive.bind(browser);
    vi.spyOn(browser, 'runExclusive')
      .mockImplementationOnce(runExclusive)
      .mockRejectedValueOnce(new Error('sensitive page contents'));
    await expectProviderError(loggingBackend.search(searchInput(), new AbortController().signal), 'UPSTREAM_ERROR');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Facebook Marketplace search failed:', 'Error');
  });

  it('maps a hanging search navigation to TIMEOUT', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html', true);
    const { backend } = createBackend({ navigationTimeoutMs: 300 });
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), 'TIMEOUT');
  });

  it('fails quickly with a typed error while an interactive lease owns the profile', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    const { backend, browser } = createBackend();
    await browser.beginInteractive();
    const startedAt = Date.now();
    await expectProviderError(backend.search(searchInput(), new AbortController().signal), 'UPSTREAM_ERROR');
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(synthetic.requests).toEqual([]);
    await browser.closeInteractive();
    browser.endInteractive();
  });

  it('reports Facebook fetch as explicitly unimplemented', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    const { backend } = createBackend();
    const input = fetchInputSchema.parse({ id: '100000000000001' });
    await expectProviderError(Promise.resolve().then(() => backend.fetch(input, new AbortController().signal)), 'UPSTREAM_ERROR');
    expect(synthetic.requests).toEqual([]);
  });

  it('validates constructor timeout and card bounds', () => {
    const { backend, browser } = createBackend();
    const probe = new FacebookSessionProbe({ browser, baseUrl: synthetic.origin });
    expect(backend.name).toBe('facebook');
    expect(() => new FacebookMarketplaceBackend({ browser, probe, navigationTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookMarketplaceBackend({ browser, probe, settleTimeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => new FacebookMarketplaceBackend({ browser, probe, maxCards: 0 })).toThrow(RangeError);
    expect(() => new FacebookMarketplaceBackend({ browser, probe, maxCards: 61 })).toThrow(RangeError);
    expect(() => new FacebookMarketplaceBackend({ browser: {} as BrowserSessionManager, probe })).toThrow(TypeError);
  });
});

async function startSyntheticServer(): Promise<SyntheticServer> {
  const requests: string[] = [];
  let probeFile: FixtureName = 'results-normal.html';
  let probeHtml: string | undefined;
  let searchFile: FixtureName = 'results-normal.html';
  let hangSearch = false;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(request.url ?? pathname);
    if (hangSearch && /^\/marketplace\/[^/]+\/search\/$/.test(pathname)) return;
    let fixture: string | undefined;
    if (pathname === '/marketplace/') fixture = probeHtml ?? fixtures.get(probeFile);
    else if (/^\/marketplace\/[^/]+\/search\/$/.test(pathname)) fixture = fixtures.get(searchFile);
    if (!fixture) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('missing synthetic route');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fixture);
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
    configure: (nextProbeFile, nextSearchFile, nextHangSearch = false, nextProbeHtml) => {
      probeFile = nextProbeFile;
      probeHtml = nextProbeHtml;
      searchFile = nextSearchFile;
      hangSearch = nextHangSearch;
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function waitForRequest(pathPrefix: string): Promise<void> {
  if (synthetic.requests.some((request) => request.startsWith(pathPrefix))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for synthetic request ${pathPrefix}`));
    }, 5_000);
    const poll = setInterval(() => {
      if (synthetic.requests.some((request) => request.startsWith(pathPrefix))) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}
