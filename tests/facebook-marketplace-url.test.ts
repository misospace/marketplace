import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FACEBOOK_MARKETS,
  MARKETPLACE_ITEM_PATH,
  buildMarketplaceItemUrl,
  buildMarketplaceSearchUrl,
  normalizeLocationKey,
  parseMarketplaceItemId,
  resolveFacebookMarket,
  type FacebookMarket
} from '../src/facebook-marketplace-url.js';

describe('Facebook Marketplace market resolution', () => {
  it.each([
    ['nyc', 'nyc'],
    ['Los Angeles, CA', 'la'],
    ['San Francisco', 'sanfrancisco'],
    ['SF', 'sanfrancisco'],
    ['new-york-city', 'nyc']
  ])('resolves %s to %s', (location, slug) => {
    const result = resolveFacebookMarket(location);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.market.slug).toBe(slug);
  });

  it('normalizes case, whitespace, and punctuation', () => {
    expect(normalizeLocationKey('  NYC ')).toBe('nyc');
    expect(normalizeLocationKey('New York, NY')).toBe('new york ny');
    expect(normalizeLocationKey('new-york')).toBe('new york');
    expect(normalizeLocationKey('  San   Francisco!! ')).toBe('san francisco');
  });

  it('reports unknown and ambiguous locations', () => {
    expect(resolveFacebookMarket('90210')).toEqual({ ok: false, reason: 'unknown', candidates: [] });
    const markets: readonly FacebookMarket[] = [
      { slug: 'north', label: 'Springfield North', currency: 'USD', aliases: ['Springfield'] },
      { slug: 'south', label: 'Springfield South', currency: 'USD', aliases: ['Springfield'] }
    ];
    expect(resolveFacebookMarket('SPRINGFIELD', markets)).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: ['Springfield North', 'Springfield South']
    });
  });

  it('rejects blank inputs and invalid market configuration', () => {
    expect(() => resolveFacebookMarket('   ')).toThrow(TypeError);
    expect(() => resolveFacebookMarket('x', [{ slug: 'New York', label: 'New York', currency: 'USD' }])).toThrow(TypeError);
    expect(() => resolveFacebookMarket('x', [{ slug: 'valid', label: 'Valid', currency: 'usd' }])).toThrow(TypeError);
    expect(() => resolveFacebookMarket('x', [{ slug: 'valid', label: ' ', currency: 'USD' }])).toThrow(TypeError);
  });
});

describe('Marketplace search URL building', () => {
  const market = DEFAULT_FACEBOOK_MARKETS[0]!;

  it('builds the canonical path and encodes the query and both bounds', () => {
    const href = buildMarketplaceSearchUrl({
      baseUrl: 'https://www.facebook.com/',
      market,
      query: 'bike & café',
      minPrice: 10,
      maxPrice: 250
    });
    const url = new URL(href);
    expect(url.pathname).toBe('/marketplace/nyc/search/');
    expect(url.searchParams.get('query')).toBe('bike & café');
    expect(url.searchParams.get('minPrice')).toBe('10');
    expect(url.searchParams.get('maxPrice')).toBe('250');
  });

  it('omits undefined bounds and handles a base URL with a trailing slash', () => {
    const url = new URL(buildMarketplaceSearchUrl({ baseUrl: 'https://www.facebook.com/', market, query: 'sofa' }));
    expect(url.pathname).toBe('/marketplace/nyc/search/');
    expect(url.searchParams.has('minPrice')).toBe(false);
    expect(url.searchParams.has('maxPrice')).toBe(false);
    expect(url.searchParams.get('query')).toBe('sofa');
  });

  it('rejects invalid bases, markets, queries, and bounds', () => {
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'file:///tmp', market, query: 'bike' })).toThrow(TypeError);
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'https://user:pass@example.com', market, query: 'bike' })).toThrow(TypeError);
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'https://example.com', market: { ...market, slug: '../x' }, query: 'bike' })).toThrow(TypeError);
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'https://example.com', market: { ...market, currency: 'US' }, query: 'bike' })).toThrow(TypeError);
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'https://example.com', market, query: '  ' })).toThrow(TypeError);
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'https://example.com', market, query: 'bike', minPrice: Infinity })).toThrow(TypeError);
    expect(() => buildMarketplaceSearchUrl({ baseUrl: 'https://example.com', market, query: 'bike', maxPrice: -1 })).toThrow(TypeError);
  });
});

describe('Marketplace item URLs', () => {
  it.each([
    [`${MARKETPLACE_ITEM_PATH}1234567890/?ref=x`, '1234567890'],
    ['https://www.facebook.com/marketplace/item/12345/?tracking=1', '12345'],
    ['https://www.facebook.com/marketplace/item/12345678901234567890/', '12345678901234567890']
  ])('parses item id from %s', (href, id) => {
    expect(parseMarketplaceItemId(href)).toBe(id);
  });

  it.each([
    '/marketplace/search/?query=chair',
    '/marketplace/item/not-a-number/',
    '/marketplace/item/1234/',
    '/marketplace/item/123456789012345678901/',
    '/marketplace/item/12345678901234567890x/'
  ])('rejects non-item or out-of-range href %s', (href) => {
    expect(parseMarketplaceItemId(href)).toBeNull();
  });

  it('builds a clean item URL and rejects an invalid id', () => {
    expect(buildMarketplaceItemUrl('https://www.facebook.com/', '123456')).toBe('https://www.facebook.com/marketplace/item/123456/');
    expect(() => buildMarketplaceItemUrl('https://www.facebook.com', 'abc')).toThrow(TypeError);
  });
});
