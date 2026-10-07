import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError } from '../src/backend.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { fetchInputSchema, listingSchema } from '../src/domain.js';
import { startSyntheticServer, waitForRequest, type SyntheticServer } from './helpers/synthetic-facebook-server.js';
import type { FacebookMarket } from '../src/facebook-marketplace-url.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

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
  expect(synthetic.requests.every((request) => /^\/marketplace\/(?:item\/\d+\/)?(?:\?.*)?$/.test(request))).toBe(true);
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  synthetic.requests.length = 0;
});

function createBackend(options: { navigationTimeoutMs?: number; settleTimeoutMs?: number; markets?: readonly FacebookMarket[] } = {}): {
  backend: FacebookMarketplaceBackend;
  browser: BrowserSessionManager;
} {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-facebook-fetch-test-'));
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
      ...(options.markets ? { markets: options.markets } : {}),
      logger: { error: () => undefined }
    })
  };
}

function fetchInput(input: { id: string } | { url: string }) {
  return fetchInputSchema.parse(input);
}

function expectProviderError(promise: Promise<unknown>, code: ProviderError['code']) {
  return expect(promise).rejects.toMatchObject({ name: 'ProviderError', code });
}

const itemId = '123456789012345';
const canonicalUrl = (): string => `${synthetic.origin}/marketplace/item/${itemId}/`;
const signal = (): AbortSignal => new AbortController().signal;

describe.skipIf(!browserAvailable)('Facebook Marketplace fetch', () => {
  it('returns the same normalized listing for an id and its equivalent URL', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-normal.html');
    const { backend } = createBackend();

    const byId = await backend.fetch(fetchInput({ id: itemId }), signal());
    const byUrl = await backend.fetch(fetchInput({ url: canonicalUrl() }), signal());

    expect(byId).not.toBeNull();
    expect(byUrl).toEqual(byId);
    expect(listingSchema.parse(byId)).toEqual(byId);
  });

  it('canonicalizes a queried URL to the bare item route and listing URL', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-normal.html');
    const { backend } = createBackend();
    const queriedUrl = `${synthetic.origin}/marketplace/item/${itemId}?ref=share`;

    const listing = await backend.fetch(fetchInput({ url: queriedUrl }), signal());

    expect(synthetic.requests).toEqual(['/marketplace/', `/marketplace/item/${itemId}/`]);
    expect(listing).toMatchObject({ id: itemId, url: canonicalUrl() });
    expect(listingSchema.parse(listing)).toEqual(listing);
  });

  it('returns the complete normalized active listing shape', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-normal.html');
    const { backend } = createBackend();

    const listing = await backend.fetch(fetchInput({ id: itemId }), signal());

    expect(listing).not.toBeNull();
    expect(listingSchema.parse(listing)).toMatchObject({
      id: itemId,
      url: canonicalUrl(),
      title: 'Vintage oak writing desk',
      price: 180,
      currency: 'USD',
      location: 'Portland, OR',
      seller: {
        name: 'Sample Seller',
        url: `${synthetic.origin}/marketplace/profile/100000000000901/`
      },
      images: [
        'https://scontent.example.invalid/items/desk-front.jpg',
        'https://scontent.example.invalid/items/desk-side.jpg'
      ],
      state: 'active'
    });
  });

  it('preserves the sold state from the item page', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-sold.html');
    const { backend } = createBackend();

    const listing = await backend.fetch(fetchInput({ id: itemId }), signal());

    expect(listingSchema.parse(listing).state).toBe('sold');
  });

  it('returns null for an unavailable shell that cannot satisfy the listing schema', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-unavailable.html');
    const { backend } = createBackend();

    await expect(backend.fetch(fetchInput({ id: itemId }), signal())).resolves.toBeNull();
  });

  it('returns a complete removed listing instead of treating it as not found', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-removed-complete.html');
    const { backend } = createBackend();

    const listing = await backend.fetch(fetchInput({ id: itemId }), signal());

    expect(listing).toMatchObject({
      id: itemId,
      title: 'Vintage oak writing desk',
      price: 180,
      currency: 'USD',
      location: 'Portland, OR',
      state: 'removed'
    });
    expect(listingSchema.parse(listing)).toEqual(listing);
  });

  it('uses an explicit USD price instead of the first configured CAD market', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-usd-marker.html');
    const { backend } = createBackend({ markets: [
      { slug: 'calgary', label: 'Calgary, AB', currency: 'CAD' }
    ] });

    const listing = await backend.fetch(fetchInput({ id: itemId }), signal());

    expect(listing).toMatchObject({ price: 500, currency: 'USD', location: 'Seattle, WA' });
  });

  it('fails closed on a bare dollar price when the listing location resolves to no market', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-bare-dollar-unknown-location.html');
    const { backend } = createBackend({ markets: [
      { slug: 'calgary', label: 'Calgary, AB', currency: 'CAD' },
      { slug: 'seattle', label: 'Seattle, WA', currency: 'USD' }
    ] });

    // "$500" is ambiguous across the dollar currencies. Bowness is not a configured market, so
    // there is no evidence for CAD over USD and the fetch must not guess one.
    await expect(backend.fetch(fetchInput({ id: itemId }), signal())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'UPSTREAM_ERROR',
      message: expect.stringContaining('currency')
    });
  });

  it('uses a resolved listing location currency when the price has no marker', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-markerless-calgary.html');
    const { backend } = createBackend({ markets: [
      { slug: 'calgary', label: 'Calgary, AB', currency: 'CAD' },
      { slug: 'seattle', label: 'Seattle, WA', currency: 'USD' }
    ] });

    const listing = await backend.fetch(fetchInput({ id: itemId }), signal());

    expect(listing).toMatchObject({ price: null, currency: 'CAD', location: 'Calgary, AB' });
  });

  it('fails closed when neither the price marker nor listing location determines currency', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-markerless-unknown-location.html');
    const { backend } = createBackend({ markets: [
      { slug: 'calgary', label: 'Calgary, AB', currency: 'CAD' },
      { slug: 'seattle', label: 'Seattle, WA', currency: 'USD' }
    ] });

    await expectProviderError(backend.fetch(fetchInput({ id: itemId }), signal()), 'UPSTREAM_ERROR');
  });

  it.each([
    ['login.html', 'LOGIN_REQUIRED'],
    ['captcha.html', 'CAPTCHA_REQUIRED'],
    ['checkpoint.html', 'SESSION_INVALID']
  ] as const)('fails closed when the session probe sees %s', async (fixture, code) => {
    synthetic.configure(fixture, 'results-normal.html');
    synthetic.configureItem('item-normal.html');
    const { backend } = createBackend();

    await expectProviderError(backend.fetch(fetchInput({ id: itemId }), signal()), code);
    expect(synthetic.requests).toEqual(['/marketplace/']);
  });

  it('fails closed when login appears after a usable session probe', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-login.html');
    const { backend } = createBackend();

    await expectProviderError(backend.fetch(fetchInput({ id: itemId }), signal()), 'LOGIN_REQUIRED');
    expect(synthetic.requests).toEqual(['/marketplace/', `/marketplace/item/${itemId}/`]);
  });

  it('rejects an item page whose location cannot be parsed without returning a partial listing', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-unknown-layout.html');
    const { backend } = createBackend({ settleTimeoutMs: 20 });

    await expectProviderError(backend.fetch(fetchInput({ id: itemId }), signal()), 'UPSTREAM_ERROR');
  });

  it.each([
    [{ url: 'https://evil.example/marketplace/item/123456789/' }],
    [{ url: 'https://www.facebook.com/marketplace/item/123456789/' }],
    [{ id: 'abc' }]
  ])('rejects caller-controlled identifiers without navigating', async (input) => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-normal.html');
    const { backend } = createBackend();

    await expect(backend.fetch(input as ReturnType<typeof fetchInput>, signal())).resolves.toBeNull();
    expect(synthetic.requests).toEqual([]);
  });

  it('maps a hanging item navigation to TIMEOUT', async () => {
    synthetic.configure('results-normal.html', 'results-normal.html');
    synthetic.configureItem('item-normal.html', true);
    const { backend } = createBackend({ navigationTimeoutMs: 300 });

    const operation = backend.fetch(fetchInput({ id: itemId }), signal());
    await waitForRequest(`/marketplace/item/${itemId}/`);
    await expectProviderError(operation, 'TIMEOUT');
  });

  it('uses the shared credential recovery path after a login probe', async () => {
    synthetic.configure('login.html', 'results-normal.html');
    synthetic.configureItem('item-normal.html');
    const { backend, browser } = createBackend();
    let probeCount = 0;
    backend['probe'].probeSession = async (_probeSignal) => {
      probeCount += 1;
      if (probeCount === 1) return { status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' };
      return { status: 'session_usable', outcome: 'marketplace_authenticated' };
    };
    const login = new FacebookCredentialLogin({ browser, username: 'synthetic-user', password: 'synthetic-password' });
    const attempt = vi.spyOn(login, 'attempt').mockResolvedValue({ outcome: 'authenticated' });
    const credentialBackend = new FacebookMarketplaceBackend({
      browser,
      probe: backend['probe'],
      login,
      logger: { error: () => undefined }
    });

    const listing = await credentialBackend.fetch(fetchInput({ id: itemId }), signal());

    expect(listingSchema.parse(listing).id).toBe(itemId);
    expect(probeCount).toBe(2);
    expect(login).toBeInstanceOf(FacebookCredentialLogin);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(synthetic.requests).toEqual([`/marketplace/item/${itemId}/`]);
  });
});
