import { describe, expect, it } from 'vitest';
import {
  classifyMarketplaceItem,
  classifyMarketplacePage,
  interpretMarketplaceItem,
  interpretMarketplacePage,
  parseMarketplacePage,
  parseMarketplacePrice,
  type MarketplacePageKind,
  type ParseMarketplaceInput
} from '../src/facebook-marketplace-parse.js';
import type { ExtractedListingCard, ExtractedMarketplaceItem, ExtractedMarketplacePage } from '../src/facebook-marketplace-extract.js';
import { listingSchema } from '../src/domain.js';
import { DEFAULT_FACEBOOK_MARKETS } from '../src/facebook-marketplace-url.js';

const market = DEFAULT_FACEBOOK_MARKETS[0]!;
const cleanSignals = {
  hasLoginForm: false,
  hasCheckpoint: false,
  hasCaptcha: false,
  hasRateLimitNotice: false,
  hasNoResultsNotice: false
};

function card(overrides: Partial<ExtractedListingCard> = {}): ExtractedListingCard {
  return {
    itemHref: '/marketplace/item/1234567890/',
    hrefs: [],
    text: 'Vintage bicycle\n$450\nBrooklyn, NY · 2 mi\nGreat condition',
    ariaLabels: [],
    imageUrls: [],
    headingText: 'Vintage bicycle',
    timeDateTime: null,
    timeText: null,
    profileHref: null,
    ...overrides
  };
}

function page(cards: ExtractedListingCard[] = [card()], overrides: Partial<ExtractedMarketplacePage['signals']> = {}): ExtractedMarketplacePage {
  return { url: 'https://www.facebook.com/marketplace/nyc/search/', signals: { ...cleanSignals, ...overrides }, cards };
}

function input(cards: ExtractedListingCard[] = [card()], overrides: Partial<ParseMarketplaceInput> = {}): ParseMarketplaceInput {
  return { page: page(cards), baseUrl: 'https://www.facebook.com/', market, limit: 20, ...overrides };
}

describe('Marketplace price parsing', () => {
  it.each([
    ['$450', 'USD', 450, 'USD'],
    ['$1,200', 'USD', 1200, 'USD'],
    ['Free', 'CAD', 0, 'CAD'],
    ['free!', 'USD', 0, 'USD'],
    ['free !', 'USD', 0, 'USD'],
    ['CAD$500', 'USD', 500, 'CAD'],
    ['$12 345', 'USD', 12345, 'USD'],
    ['$12\u00a0345', 'USD', 12345, 'USD'],
    ['NOK 1 234,56', 'USD', 1234.56, 'NOK'],
    ['1 234,56 €', 'USD', 1234.56, 'EUR'],
    ['Vintage bicycle\n$450\nBrooklyn, NY\nFree local pickup available', 'USD', 450, 'USD'],
    ['This bike is free of rust.\n$300', 'USD', 300, 'USD'],
    ['Gluten-free cereal\n$5', 'USD', 5, 'USD'],
    ['FREE delivery, was $50, now $30', 'USD', 50, 'USD'],
    ['Free', 'USD', 0, 'USD'],
    ['free.', 'USD', 0, 'USD'],
    ['Free shipping today\n$200', 'USD', 200, 'USD'],
    ['$500 $400', 'USD', 500, 'USD'],
    ['€50', 'USD', 50, 'EUR'],
    ['£1,234.56', 'USD', 1234.56, 'GBP'],
    ['CA$100', 'USD', 100, 'CAD'],
    ['US$75', 'CAD', 75, 'USD'],
    ['100 USD', 'USD', 100, 'USD'],
    ['1.234,56 €', 'USD', 1234.56, 'EUR'],
    ['FREE', 'USD', 0, 'USD']
  ])('parses %s', (text, currency, price, expectedCurrency) => {
    expect(parseMarketplacePrice(text, currency)).toEqual({ status: 'ok', price, currency: expectedCurrency });
  });

  it.each(['$1,2,3', '-$100', '$1k', '$1e3', '$1.5k', '$1x', '$12.345', '$1.500', '1,500 €'])('marks malformed token %s', (text) => {
    expect(parseMarketplacePrice(text, 'USD').status).toBe('malformed');
  });

  it.each([
    ['$1,500', 'USD', 1500, 'USD'],
    ['1.500 €', 'USD', 1500, 'EUR'],
    ['$1,234.56', 'USD', 1234.56, 'USD']
  ])('parses locale-aware grouped amount %s', (text, marketCurrency, price, currency) => {
    expect(parseMarketplacePrice(text, marketCurrency)).toEqual({ status: 'ok', price, currency });
  });

  it.each(['$abc', '$', 'USD', '3 krabs', 'tikkr'])('treats non-adjacent currency prose %s as absent', (text) => {
    expect(parseMarketplacePrice(text, 'USD')).toEqual({ status: 'absent', price: null, currency: 'USD' });
  });

  it('continues past malformed price markers to find a later valid price', () => {
    expect(parseMarketplacePrice('$1,2,3\n$200', 'USD')).toEqual({ status: 'ok', price: 200, currency: 'USD' });
  });

  it.each(['2018', '123K miles', '3 mi', 'Free local pickup available', ''])('does not infer a price from %s', (text) => {
    expect(parseMarketplacePrice(text, 'USD')).toEqual({ status: 'absent', price: null, currency: 'USD' });
  });

  it('uses only the first marked price and resolves bare dollars from the market currency', () => {
    expect(parseMarketplacePrice('$12 was $20', 'USD').price).toBe(12);
    expect(parseMarketplacePrice('FREE delivery, was $50, now $30', 'USD').price).toBe(50);
    expect(parseMarketplacePrice('$99', 'CAD').currency).toBe('CAD');
    expect(parseMarketplacePrice('$99', 'EUR').currency).toBe('USD');
  });
});

describe('Marketplace page classification', () => {
  it.each([
    [{ hasCaptcha: true, hasCheckpoint: true, hasLoginForm: true, hasRateLimitNotice: true }, 'captcha'],
    [{ hasCheckpoint: true, hasLoginForm: true }, 'checkpoint'],
    [{ hasLoginForm: true, hasRateLimitNotice: true }, 'login'],
    [{ hasRateLimitNotice: true }, 'rate_limited'],
    [{}, 'results']
  ] as const)('classifies precedence flags', (signals, expected: MarketplacePageKind) => {
    expect(classifyMarketplacePage(page([card()], signals))).toBe(expected);
  });

  it('classifies no-results and unknown pages', () => {
    expect(classifyMarketplacePage(page([], { hasNoResultsNotice: true }))).toBe('no_results');
    expect(classifyMarketplacePage(page([]))).toBe('unknown');
  });
});

describe('Marketplace result parsing', () => {
  it('keeps a kr word-internal marker from dropping an otherwise valid listing', () => {
    const result = parseMarketplacePage(input([card({
      text: 'Hand-carved tikkr ornament\nBeautifully made',
      headingText: 'Hand-carved tikkr ornament'
    })]));
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]?.price).toBeNull();
  });

  it('falls through a noisy Sold heading to a real title line', () => {
    const listing = parseMarketplacePage(input([card({
      text: 'Handmade cabinet\n$40\nSold',
      headingText: 'Sold'
    })])).listings[0];
    expect(listing?.title).toBe('Handmade cabinet');
  });

  it('keeps year and mileage text from becoming a price', () => {
    const result = parseMarketplacePage(input([card({ text: 'Classic car 2018\n123K miles\nBrooklyn, NY' })]));
    expect(result.listings[0]?.price).toBeNull();
  });

  it('skips malformed prices and sponsored cards', () => {
    const result = parseMarketplacePage(input([
      card({ text: 'Bike\n$1,2,3', headingText: 'Bike' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: 'Bike\n$20\nSponsored', headingText: 'Bike' })
    ]));
    expect(result.listings).toEqual([]);
    expect(result.stats.skipReasons).toMatchObject({ malformed_price: 1, sponsored: 1 });
  });

  it('skips missing item ids and missing titles', () => {
    const result = parseMarketplacePage(input([
      card({ itemHref: '/marketplace/search/' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: '$20\nNew listing', headingText: null })
    ]));
    expect(result.stats.skipReasons).toMatchObject({ missing_item_id: 1, missing_title: 1 });
  });

  it.each([
    ['SOLD', 'sold'],
    ['Pending', 'pending'],
    ['Removed', 'removed'],
    ['No longer available', 'removed']
  ] as const)('extracts badge-style state %s', (text, state) => {
    const listing = parseMarketplacePage(input([card({ text: `Coffee table\n$50\n${text}`, headingText: 'Coffee table' })])).listings[0];
    expect(listing?.state).toBe(state);
  });

  it.each([
    ['Brand new iPhone 14\n$800\nManhattan, NY\nSold separately from charger'],
    ['Drill\n$40\nQueens, NY\nRemoved from packaging, never used'],
    ['Desk\n$100\nBronx, NY\nPending pickup by another buyer']
  ])('does not infer state from prose: %s', (text) => {
    const listing = parseMarketplacePage(input([card({ text, headingText: text.split('\n')[0] ?? null })])).listings[0];
    expect(listing?.state).toBe('unknown');
  });

  it('extracts location with distance and falls back to the market label', () => {
    const withLocation = parseMarketplacePage(input([card()])).listings[0];
    const fallback = parseMarketplacePage(input([card({ text: 'Bicycle\n$450\nExcellent condition' })])).listings[0];
    expect(withLocation?.location).toBe('Brooklyn, NY');
    expect(fallback?.location).toBe(market.label);
  });

  it('accepts only an offset timestamp and leaves updated_at null', () => {
    const valid = parseMarketplacePage(input([card({ timeDateTime: '2026-01-02T03:04:05.000Z' })])).listings[0];
    const relative = parseMarketplacePage(input([card({ timeDateTime: '3 days ago', timeText: '3 days ago' })])).listings[0];
    expect(valid?.posted_at).toBe('2026-01-02T03:04:05.000Z');
    expect(valid?.updated_at).toBeNull();
    expect(relative?.posted_at).toBeNull();
  });

  it('removes title, price, location, badge, and mileage noise from the description', () => {
    const result = parseMarketplacePage(input([card({ text: 'Vintage bicycle\n$450\nBrooklyn, NY\nSOLD\n123K miles\nGreat condition', headingText: 'Vintage bicycle' })]));
    expect(result.listings[0]?.description).toBe('Great condition');
    const same = parseMarketplacePage(input([card({ text: 'Same title\n$20', headingText: 'same TITLE' })]));
    expect(same.listings[0]?.description).toBe('');
  });

  it('bounds and de-duplicates HTTP images while filtering non-HTTP values', () => {
    const imageUrls = ['https://img.example/1.jpg', 'https://img.example/1.jpg', 'data:image/png;base64,x', 'javascript:alert(1)', ...Array.from({ length: 7 }, (_, index) => `https://img.example/${index + 2}.jpg`)];
    const listing = parseMarketplacePage(input([card({ imageUrls })])).listings[0];
    expect(listing?.images).toHaveLength(6);
    expect(listing?.images).not.toContain('javascript:alert(1)');
    expect(new Set(listing?.images).size).toBe(listing?.images.length);
  });

  it('canonicalizes a profile URL without query or fragment', () => {
    const listing = parseMarketplacePage(input([card({ profileHref: '/marketplace/profile/123/?ref=search#top' })])).listings[0];
    expect(listing?.seller).toEqual({ url: 'https://www.facebook.com/marketplace/profile/123/' });
  });

  it('deduplicates by id, keeps the first listing, and preserves order', () => {
    const result = parseMarketplacePage(input([
      card({ text: 'First bike\n$20', headingText: 'First bike' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: 'Second bike\n$30', headingText: 'Second bike' }),
      card({ text: 'Duplicate bike\n$40', headingText: 'Duplicate bike' })
    ]));
    expect(result.listings.map((listing) => listing.title)).toEqual(['First bike', 'Second bike']);
    expect(result.stats.duplicates).toBe(1);
    expect(result.stats.skipReasons.duplicate).toBe(1);
  });

  it('applies result limits and excludes null prices when a bound is set', () => {
    const cards = [
      card({ text: 'No price\n2018', headingText: 'No price' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: 'Bike one\n$10', headingText: 'Bike one' }),
      card({ itemHref: '/marketplace/item/1234567892/', text: 'Bike two\n$20', headingText: 'Bike two' })
    ];
    expect(parseMarketplacePage(input(cards, { minPrice: 1 })).listings.map((listing) => listing.price)).toEqual([10, 20]);
    expect(parseMarketplacePage(input(cards, { limit: 1 })).listings).toHaveLength(1);
  });

  it('truncates title to the schema maximum', () => {
    const result = parseMarketplacePage(input([card({ headingText: 'x'.repeat(257), text: 'Bike\n$450' })]));
    expect(result.listings[0]?.title).toHaveLength(256);
  });

  it('rejects invalid limit and price bounds', () => {
    expect(() => parseMarketplacePage(input([], { limit: 0 }))).toThrow(RangeError);
    expect(() => parseMarketplacePage(input([], { minPrice: -1 }))).toThrow(RangeError);
    expect(() => parseMarketplacePage(input([], { maxPrice: Infinity }))).toThrow(RangeError);
  });
});

function itemPage(overrides: Partial<ExtractedMarketplaceItem> = {}): ExtractedMarketplaceItem {
  return {
    url: 'https://www.facebook.com/marketplace/item/1234567890/',
    signals: cleanSignals,
    hasUnavailableNotice: false,
    title: 'Vintage bicycle',
    priceText: '$450',
    locationText: 'Brooklyn, NY',
    descriptionText: 'Great condition',
    stateText: '',
    bodyText: '',
    imageUrls: [],
    sellerHref: null,
    sellerName: null,
    timeDateTime: null,
    ...overrides
  };
}

function itemInput(pageValue: ExtractedMarketplaceItem = itemPage()) {
  return {
    page: pageValue,
    id: '1234567890',
    url: 'https://www.facebook.com/marketplace/item/1234567890/',
    fallbackCurrency: 'USD'
  };
}

describe('Marketplace item parsing', () => {
  it.each([
    [{ hasLoginForm: true }, 'login', 'LOGIN_REQUIRED'],
    [{ hasCaptcha: true }, 'captcha', 'CAPTCHA_REQUIRED'],
    [{ hasCheckpoint: true }, 'checkpoint', 'SESSION_INVALID'],
    [{ hasRateLimitNotice: true }, 'rate_limited', 'RATE_LIMITED']
  ] as const)('classifies and interprets interstitial flags', (signals, kind, code) => {
    const pageValue = itemPage({ signals: { ...cleanSignals, ...signals } });
    expect(classifyMarketplaceItem(pageValue)).toBe(kind);
    expect(interpretMarketplaceItem(itemInput(pageValue))).toMatchObject({ kind: 'error', code });
  });

  it('classifies a title-less page with an unavailable notice as unavailable', () => {
    const pageValue = itemPage({ title: null, hasUnavailableNotice: true });
    expect(classifyMarketplaceItem(pageValue)).toBe('unavailable');
    expect(interpretMarketplaceItem(itemInput(pageValue))).toEqual({ kind: 'unavailable' });
  });

  it('keeps a rendered listing even when its description mentions unavailability', () => {
    // The notice regex runs over the whole page, and a description is part of the page, so the
    // title must win: a seller writing "delivery is not available" must not hide a live listing.
    const pageValue = itemPage({
      title: 'Vintage bicycle',
      hasUnavailableNotice: true,
      descriptionText: 'Pickup only, delivery is not available.'
    });
    expect(classifyMarketplaceItem(pageValue)).toBe('item');
    expect(interpretMarketplaceItem(itemInput(pageValue))).toMatchObject({
      kind: 'listing',
      listing: { state: 'active' }
    });
  });

  it('drops an off-origin seller link instead of carrying it into the listing', () => {
    const pageValue = itemPage({ sellerHref: '//attacker.example/marketplace/profile/123/', sellerName: 'Seller' });
    const outcome = interpretMarketplaceItem(itemInput(pageValue));
    expect(outcome).toMatchObject({ kind: 'listing', listing: { seller: { name: 'Seller' } } });
    expect(JSON.stringify(outcome)).not.toContain('attacker.example');
  });

  it('fails closed for an unknown layout', () => {
    const pageValue = itemPage({ title: null });
    expect(classifyMarketplaceItem(pageValue)).toBe('unknown');
    expect(interpretMarketplaceItem(itemInput(pageValue))).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('does not emit a partial listing when location is missing', () => {
    expect(interpretMarketplaceItem(itemInput(itemPage({ locationText: null }))))
      .toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('parses a listing, applies domain validation, and uses fallback currency for absent price', () => {
    const outcome = interpretMarketplaceItem(itemInput(itemPage({ priceText: null, imageUrls: [
      'https://images.example.invalid/one.jpg', 'https://images.example.invalid/two.jpg'
    ], sellerHref: '/marketplace/profile/123/', sellerName: 'Sample Seller' })));
    expect(outcome.kind).toBe('listing');
    if (outcome.kind !== 'listing') return;
    expect(outcome.listing).toMatchObject({
      price: null,
      currency: 'USD',
      seller: { name: 'Sample Seller', url: 'https://www.facebook.com/marketplace/profile/123/' }
    });
    expect(listingSchema.parse(outcome.listing)).toEqual(outcome.listing);
  });

  it('uses active only for a rendered fetch item and sold when the item region says Sold', () => {
    const active = interpretMarketplaceItem(itemInput());
    const sold = interpretMarketplaceItem(itemInput(itemPage({ stateText: 'Vintage bicycle\n$450\nSold' })));
    expect(active.kind === 'listing' ? active.listing.state : null).toBe('active');
    expect(sold.kind === 'listing' ? sold.listing.state : null).toBe('sold');
  });

  it('truncates descriptions and caps images at the schema limit', () => {
    const imageUrls = Array.from({ length: 9 }, (_, index) => `https://images.example.invalid/${index}.jpg`);
    const outcome = interpretMarketplaceItem(itemInput(itemPage({ descriptionText: 'Long description '.repeat(30), imageUrls })));
    expect(outcome.kind).toBe('listing');
    if (outcome.kind !== 'listing') return;
    expect(outcome.listing.description).toHaveLength(280);
    expect(outcome.listing.images).toHaveLength(6);
    expect(listingSchema.parse(outcome.listing)).toEqual(outcome.listing);
  });

  it('strips disclosure labels and accepts an offset time without inventing one', () => {
    const outcome = interpretMarketplaceItem(itemInput(itemPage({
      descriptionText: 'A useful item See more',
      timeDateTime: '2026-09-14T10:30:00-07:00'
    })));
    expect(outcome.kind === 'listing' ? outcome.listing.description : null).toBe('A useful item');
    expect(outcome.kind === 'listing' ? outcome.listing.posted_at : null).toBe('2026-09-14T10:30:00-07:00');
    expect(outcome.kind === 'listing' ? outcome.listing.updated_at : null).toBeNull();
  });

  it('rejects invalid listing fields as a typed upstream error', () => {
    expect(interpretMarketplaceItem(itemInput(itemPage({ imageUrls: ['javascript:alert(1)'] }))))
      .toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });
});

describe('Marketplace outcomes', () => {
  it('returns upstream error when result cards cannot be parsed', () => {
    const result = interpretMarketplacePage(input([card({ itemHref: '/invalid' })]));
    expect(result).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace results were present but could not be parsed.' });
  });

  it('returns empty for an all-sponsored page', () => {
    const sponsored = [
      card({ text: 'Bike\n$20\nSponsored', headingText: 'Bike' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: 'Chair\n$30\nSponsored', headingText: 'Chair' })
    ];
    expect(interpretMarketplacePage(input(sponsored))).toMatchObject({ kind: 'empty' });
  });

  it('returns upstream error when valid cards all have malformed prices', () => {
    const malformed = [
      card({ text: 'Bike\n$1,2,3', headingText: 'Bike' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: 'Chair\n$2,3,4', headingText: 'Chair' })
    ];
    expect(interpretMarketplacePage(input(malformed))).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it('keeps a heading that reads like prose as a deliberate title ambiguity', () => {
    const result = parseMarketplacePage(input([card({ headingText: 'Sold as-is', text: 'Sold as-is\n$20' })]));
    expect(result.listings[0]?.title).toBe('Sold as-is');
  });

  it('returns empty when all listings are excluded by price filters', () => {
    const result = interpretMarketplacePage(input([
      card({ text: 'Bike\n$20', headingText: 'Bike' }),
      card({ itemHref: '/marketplace/item/1234567891/', text: 'Chair\n$30', headingText: 'Chair' })
    ], { minPrice: 40 }));
    expect(result).toMatchObject({ kind: 'empty' });
  });

  it('returns empty for no results and does not treat unknown as empty success', () => {
    expect(interpretMarketplacePage(input([], { page: page([], { hasNoResultsNotice: true }) }))).toMatchObject({ kind: 'empty' });
    expect(interpretMarketplacePage(input([], { page: page([]) }))).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
  });

  it.each([
    [{ hasLoginForm: true }, 'LOGIN_REQUIRED'],
    [{ hasCheckpoint: true }, 'SESSION_INVALID'],
    [{ hasCaptcha: true }, 'CAPTCHA_REQUIRED'],
    [{ hasRateLimitNotice: true }, 'RATE_LIMITED']
  ] as const)('maps interstitial signals', (signals, code) => {
    expect(interpretMarketplacePage(input([card()], { page: page([card()], signals) })).kind).toBe('error');
    expect(interpretMarketplacePage(input([card()], { page: page([card()], signals) })).kind === 'error'
      ? (interpretMarketplacePage(input([card()], { page: page([card()], signals) })) as { code: string }).code
      : null).toBe(code);
  });
});
