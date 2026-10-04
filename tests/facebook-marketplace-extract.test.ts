import { readFileSync, existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { MARKETPLACE_ITEM_PATH } from '../src/facebook-marketplace-url.js';
import { extractMarketplacePage, MARKETPLACE_EXTRACT_LIMITS } from '../src/facebook-marketplace-extract.js';
import { classifyMarketplacePage, interpretMarketplacePage, parseMarketplacePrice } from '../src/facebook-marketplace-parse.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

const fixtureCases = [
  { file: 'results-normal.html', kind: 'results', outcome: 'listings', count: 3 },
  { file: 'results-multi-currency.html', kind: 'results', outcome: 'listings', count: 6 },
  { file: 'results-vehicle.html', kind: 'results', outcome: 'listings', count: 1 },
  { file: 'results-sponsored.html', kind: 'results', outcome: 'listings', count: 2 },
  { file: 'results-missing-price.html', kind: 'results', outcome: 'listings', count: 2 },
  { file: 'results-sold-pending.html', kind: 'results', outcome: 'listings', count: 4 },
  { file: 'results-duplicate.html', kind: 'results', outcome: 'listings', count: 2 },
  { file: 'results-malformed.html', kind: 'results', outcome: 'listings', count: 2 },
  { file: 'results-all-malformed.html', kind: 'results', outcome: 'UPSTREAM_ERROR' },
  { file: 'no-results.html', kind: 'no_results', outcome: 'empty' },
  { file: 'layout-changed.html', kind: 'unknown', outcome: 'UPSTREAM_ERROR' },
  { file: 'login.html', kind: 'login', outcome: 'LOGIN_REQUIRED' },
  { file: 'checkpoint.html', kind: 'checkpoint', outcome: 'SESSION_INVALID' },
  { file: 'captcha.html', kind: 'captcha', outcome: 'CAPTCHA_REQUIRED' },
  { file: 'rate-limited.html', kind: 'rate_limited', outcome: 'RATE_LIMITED' }
] as const;

let browser: Browser;
let page: Page;
let requestsAllowedToReachNetwork: string[];
let blockedRequests: string[];

describe.skipIf(!browserAvailable)('Facebook Marketplace page extraction', () => {
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    requestsAllowedToReachNetwork = [];
    blockedRequests = [];
    await page.route('**/*', async (route) => {
      blockedRequests.push(route.request().url());
      // Every browser request is stopped before it can reach the network. Fixture image URLs are intentionally invalid.
      await route.abort();
    });
    page.on('requestfinished', (request) => requestsAllowedToReachNetwork.push(request.url()));
  });

  afterAll(async () => {
    await browser?.close();
  });
  it.each(fixtureCases)('extracts $file and classifies its outcome', async (testCase) => {
    const html = readFileSync(new URL(`./fixtures/facebook-marketplace/${testCase.file}`, import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMarketplacePage, {
      itemPath: MARKETPLACE_ITEM_PATH,
      limits: MARKETPLACE_EXTRACT_LIMITS
    });

    expect(extracted.signals).toEqual({
      hasLoginForm: testCase.file === 'login.html',
      hasCheckpoint: testCase.file === 'checkpoint.html',
      hasCaptcha: testCase.file === 'captcha.html',
      hasRateLimitNotice: testCase.file === 'rate-limited.html',
      hasNoResultsNotice: testCase.file === 'no-results.html'
    });
    expect(classifyMarketplacePage(extracted)).toBe(testCase.kind);

    const outcome = interpretMarketplacePage({
      page: extracted,
      baseUrl: 'https://www.facebook.com',
      market: { slug: 'nyc', label: 'New York, NY', currency: 'USD' },
      limit: 20
    });
    if (testCase.outcome === 'listings') {
      expect(outcome.kind).toBe('listings');
      if (outcome.kind !== 'listings') return;
      expect(outcome.listings).toHaveLength(testCase.count);
    } else if (testCase.outcome === 'empty') {
      expect(outcome).toMatchObject({ kind: 'empty' });
    } else {
      expect(outcome).toMatchObject({ kind: 'error', code: testCase.outcome });
    }

    if (testCase.file === 'results-normal.html') {
      expect(extracted.cards.map((card) => card.itemHref)).toHaveLength(3);
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ id }) => id) : []).toEqual([
        '100000000000001', '100000000000002', '100000000000003'
      ]);
      if (outcome.kind === 'listings') {
        expect(outcome.listings.every(({ posted_at, updated_at }) => posted_at === null && updated_at === null)).toBe(true);
      }
    }
    if (testCase.file === 'results-multi-currency.html') {
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ currency }) => currency) : [])
        .toEqual(['USD', 'EUR', 'GBP', 'CAD', 'USD', 'USD']);
    }
    if (testCase.file === 'results-vehicle.html') {
      expect(outcome.kind === 'listings' ? outcome.listings[0] : undefined)
        .toMatchObject({ title: '2014 Honda Civic LX', price: 8500 });
      expect(parseMarketplacePrice(extracted.cards[0]?.text ?? '', 'USD'))
        .toEqual({ status: 'ok', price: 8500, currency: 'USD' });
      expect(parseMarketplacePrice('2018\n123K miles', 'USD'))
        .toEqual({ status: 'absent', price: null, currency: 'USD' });
    }
    if (testCase.file === 'results-sponsored.html') {
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ title }) => title) : [])
        .not.toContain('Sponsored');
    }
    if (testCase.file === 'results-missing-price.html') {
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ price }) => price) : []).toEqual([175, null]);
      expect(outcome.kind === 'listings' ? outcome.listings[1]?.price : undefined).toBeNull();
    }
    if (testCase.file === 'results-sold-pending.html') {
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ state }) => state) : [])
        .toEqual(['sold', 'pending', 'removed', 'unknown']);
      expect(outcome.kind === 'listings' ? outcome.listings.some(({ state }) => state === 'active') : false).toBe(false);
    }
    if (testCase.file === 'results-duplicate.html') {
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ id }) => id) : [])
        .toEqual(['100000000000020', '100000000000021']);
    }
    if (testCase.file === 'results-malformed.html') {
      expect(outcome.kind === 'listings' ? outcome.listings.map(({ id }) => id) : [])
        .toEqual(['100000000000022', '100000000000023']);
    }
  });

  it('keeps card trigger text out of page-level interstitial signals', async () => {
    await page.setContent(`<!doctype html><html><body><main><div class="grid"><div class="card"><a href="/marketplace/item/123456789012345/"><h3>Bypass captcha service</h3></a><div>$25</div><div>Try again later - no results</div><div>Verify you are a human; I'm not a robot</div><div>Security check, confirm your identity</div></div><div class="card"><a href="/marketplace/item/123456789012346/"><h3>Ordinary listing</h3></a><div>$30</div></div></div></main></body></html>`, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMarketplacePage, {
      itemPath: MARKETPLACE_ITEM_PATH,
      limits: MARKETPLACE_EXTRACT_LIMITS
    });
    expect(extracted.cards).toHaveLength(2);
    expect(extracted.signals).toMatchObject({ hasCheckpoint: false, hasCaptcha: false, hasRateLimitNotice: false, hasNoResultsNotice: false });
    expect(classifyMarketplacePage(extracted)).toBe('results');
    const outcome = interpretMarketplacePage({
      page: extracted,
      baseUrl: 'https://www.facebook.com/',
      market: { slug: 'nyc', label: 'New York, NY', currency: 'USD' },
      limit: 5
    });
    expect(outcome.kind).toBe('listings');
  });

  it.each([
    ['captcha', 'Verify you are a human'],
    ['rate limit', 'Please try again later']
  ])('ignores %s text in cards beyond maxCards', async (_signal, phrase) => {
    const cards = Array.from({ length: 4 }, (_, index) => `<div class="card"><a href="/marketplace/item/12345678901234${index}/"><h3>Ordinary item ${index}</h3></a><div>$25</div></div>`);
    cards[3] = `<div class="card"><a href="/marketplace/item/123456789012343/"><h3>${phrase}</h3></a><div>$25</div></div>`;
    await page.setContent(`<!doctype html><html><body><main><div class="grid">${cards.join('')}</div></main></body></html>`, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMarketplacePage, {
      itemPath: MARKETPLACE_ITEM_PATH,
      limits: { ...MARKETPLACE_EXTRACT_LIMITS, maxCards: 3 }
    });
    expect(extracted.cards).toHaveLength(3);
    expect(extracted.signals.hasCaptcha).toBe(false);
    expect(extracted.signals.hasRateLimitNotice).toBe(false);
    expect(classifyMarketplacePage(extracted)).toBe('results');
    expect(interpretMarketplacePage({
      page: extracted,
      baseUrl: 'https://www.facebook.com/',
      market: { slug: 'nyc', label: 'New York, NY', currency: 'USD' },
      limit: 5
    }).kind).toBe('listings');
  });

  it('keeps a real rate-limit banner visible when the page has one item link', async () => {
    await page.setContent(`<!doctype html><html><body><main><p class="banner">You are temporarily blocked. Please try again later.</p><aside><a href="/marketplace/item/123456789012345/">Sidebar link</a></aside></main></body></html>`, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMarketplacePage, {
      itemPath: MARKETPLACE_ITEM_PATH,
      limits: MARKETPLACE_EXTRACT_LIMITS
    });
    expect(extracted.cards).toHaveLength(1);
    expect(extracted.signals.hasRateLimitNotice).toBe(true);
    expect(classifyMarketplacePage(extracted)).toBe('rate_limited');
  });

  it('blocks every request before network access, including fixture images', async () => {
    await page.setContent(readFileSync(new URL('./fixtures/facebook-marketplace/results-normal.html', import.meta.url), 'utf8'), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    expect(blockedRequests.filter((url) => url.startsWith('https://scontent.example.invalid/')).length).toBeGreaterThan(0);
    expect(requestsAllowedToReachNetwork).toEqual([]);
  });
});
