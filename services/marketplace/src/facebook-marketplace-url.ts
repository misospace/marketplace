export const MARKETPLACE_ITEM_PATH = '/marketplace/item/';
export const MARKETPLACE_SEARCH_SUFFIX = '/search/';

export interface FacebookMarket {
  readonly slug: string;
  readonly label: string;
  readonly currency: string;
  readonly aliases?: readonly string[];
}

// These slugs are corroborated by public Marketplace URL conventions, not live-verified; the map is fully overridable; non-US markets must be configured explicitly; we deliberately do not guess slugs.
export const DEFAULT_FACEBOOK_MARKETS: readonly FacebookMarket[] = [
  { slug: 'nyc', label: 'New York, NY', currency: 'USD', aliases: ['new york', 'new york city'] },
  { slug: 'la', label: 'Los Angeles, CA', currency: 'USD', aliases: ['los angeles'] },
  { slug: 'sanfrancisco', label: 'San Francisco, CA', currency: 'USD', aliases: ['san francisco', 'sf'] },
  { slug: 'chicago', label: 'Chicago, IL', currency: 'USD', aliases: ['chitown'] },
  { slug: 'austin', label: 'Austin, TX', currency: 'USD', aliases: ['austin texas'] },
  { slug: 'boston', label: 'Boston, MA', currency: 'USD', aliases: ['beantown'] },
  { slug: 'seattle', label: 'Seattle, WA', currency: 'USD', aliases: ['sea'] },
  { slug: 'atlanta', label: 'Atlanta, GA', currency: 'USD', aliases: ['atl'] },
  { slug: 'miami', label: 'Miami, FL', currency: 'USD', aliases: ['magic city'] },
  { slug: 'portland', label: 'Portland, OR', currency: 'USD', aliases: ['portland oregon'] }
];

export function normalizeLocationKey(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Location must be a string');
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export type FacebookMarketResolution =
  | { readonly ok: true; readonly market: FacebookMarket }
  | { readonly ok: false; readonly reason: 'unknown' | 'ambiguous'; readonly candidates: readonly string[] };

export function validateMarket(market: FacebookMarket): void {
  if (typeof market !== 'object' || market === null) throw new TypeError('Market configuration must be an object');
  if (typeof market.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(market.slug)) {
    throw new TypeError('Market slug is invalid');
  }
  if (typeof market.currency !== 'string' || !/^[A-Z]{3}$/.test(market.currency)) {
    throw new TypeError('Market currency is invalid');
  }
  if (typeof market.label !== 'string' || !market.label.trim()) throw new TypeError('Market label must not be blank');
  if (market.aliases !== undefined && (!Array.isArray(market.aliases) || market.aliases.some((alias) => typeof alias !== 'string' || !alias.trim()))) {
    throw new TypeError('Market aliases must be non-blank strings');
  }
}

function buildMarketIndex(markets: readonly FacebookMarket[]): Map<string, Map<string, FacebookMarket>> {
  if (!Array.isArray(markets)) throw new TypeError('Markets must be an array');

  const keyToMarkets = new Map<string, Map<string, FacebookMarket>>();
  const slugs = new Set<string>();

  for (const market of markets) {
    validateMarket(market);
    if (slugs.has(market.slug)) throw new TypeError('Market slugs must be unique');
    slugs.add(market.slug);

    for (const value of [market.slug, market.label, ...(market.aliases ?? [])]) {
      const key = normalizeLocationKey(value);
      if (!key) throw new TypeError('Market keys must not be blank');
      let matches = keyToMarkets.get(key);
      if (!matches) {
        matches = new Map<string, FacebookMarket>();
        keyToMarkets.set(key, matches);
      }
      const existing = matches.get(market.slug);
      if (existing && existing !== market) throw new TypeError('Market keys must not map to different market configurations');
      matches.set(market.slug, market);
    }
  }

  return keyToMarkets;
}

/**
 * Validates a whole market set: every entry must satisfy `validateMarket`, slugs must be unique,
 * and no label or alias may map to two different markets. The rules themselves are shared with
 * `resolveFacebookMarket`, so a configured map cannot drift from the built-in one.
 *
 * The last rule is stricter than lookup: `resolveFacebookMarket` merely reports such a location as
 * `ambiguous`, whereas a configured file fails validation outright rather than silently making a
 * location unresolvable.
 */
export function validateFacebookMarkets(markets: readonly FacebookMarket[]): void {
  for (const matches of buildMarketIndex(markets).values()) {
    if (matches.size > 1) throw new TypeError('Market keys must not map to different market configurations');
  }
}

export function resolveFacebookMarket(
  location: string,
  markets: readonly FacebookMarket[] = DEFAULT_FACEBOOK_MARKETS
): FacebookMarketResolution {
  if (typeof location !== 'string' || !normalizeLocationKey(location)) throw new TypeError('Location must not be blank');
  const keyToMarkets = buildMarketIndex(markets);

  const matches = keyToMarkets.get(normalizeLocationKey(location));
  if (!matches || matches.size === 0) return { ok: false, reason: 'unknown', candidates: [] };
  if (matches.size === 1) return { ok: true, market: matches.values().next().value as FacebookMarket };
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: [...matches.values()].map((market) => market.label).sort()
  };
}

export interface MarketplaceSearchUrlInput {
  readonly baseUrl: string;
  readonly market: FacebookMarket;
  readonly query: string;
  readonly minPrice?: number;
  readonly maxPrice?: number;
}

function parseHttpBase(baseUrl: string): URL {
  if (typeof baseUrl !== 'string') throw new TypeError('Base URL must be an absolute HTTP(S) URL');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('Base URL must be an absolute HTTP(S) URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('Base URL must be an absolute HTTP(S) URL');
  }
  return url;
}

export function buildMarketplaceSearchUrl(input: MarketplaceSearchUrlInput): string {
  if (typeof input !== 'object' || input === null) throw new TypeError('Search URL input is required');
  const baseUrl = parseHttpBase(input.baseUrl);
  validateMarket(input.market);
  if (typeof input.query !== 'string' || !input.query.trim()) throw new TypeError('Search query must not be blank');
  for (const [name, value] of [['minPrice', input.minPrice], ['maxPrice', input.maxPrice]] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`${name} must be a finite non-negative number`);
    }
  }

  const url = new URL(`/marketplace/${input.market.slug}${MARKETPLACE_SEARCH_SUFFIX}`, baseUrl);
  url.searchParams.set('query', input.query);
  if (input.minPrice !== undefined) url.searchParams.set('minPrice', String(input.minPrice));
  if (input.maxPrice !== undefined) url.searchParams.set('maxPrice', String(input.maxPrice));
  return url.href;
}

export function parseMarketplaceItemId(href: string): string | null {
  if (typeof href !== 'string' || !href) return null;
  let url: URL;
  try {
    url = new URL(href, 'https://www.facebook.com');
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(MARKETPLACE_ITEM_PATH)) return null;
  const id = url.pathname.slice(MARKETPLACE_ITEM_PATH.length).split('/')[0];
  return id && /^\d{5,20}$/.test(id) ? id : null;
}

export interface ResolvedMarketplaceItemInput { id: string; url: string; }

/**
 * Resolves caller input to a URL derived only from the configured base. The supplied URL is used
 * only to validate its origin and extract an item id, making caller-controlled navigation impossible.
 */
export function resolveMarketplaceItemInput(
  input: { id?: string; url?: string },
  baseUrl: string
): ResolvedMarketplaceItemInput | null {
  const base = parseHttpBase(baseUrl);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const hasId = input.id !== undefined;
  const hasUrl = input.url !== undefined;
  if (hasId === hasUrl) return null;

  let id: string | null;
  if (hasId) {
    id = typeof input.id === 'string' && /^\d{5,20}$/.test(input.id) ? input.id : null;
  } else {
    if (typeof input.url !== 'string') return null;
    let suppliedUrl: URL;
    try {
      suppliedUrl = new URL(input.url);
    } catch {
      return null;
    }
    if (suppliedUrl.origin !== base.origin) return null;
    id = parseMarketplaceItemId(suppliedUrl.href);
  }
  if (!id) return null;
  return { id, url: buildMarketplaceItemUrl(baseUrl, id) };
}

export function buildMarketplaceItemUrl(baseUrl: string, id: string): string {
  if (typeof id !== 'string' || !/^\d{5,20}$/.test(id)) throw new TypeError('Marketplace item id is invalid');
  const base = parseHttpBase(baseUrl);
  const url = new URL(`${MARKETPLACE_ITEM_PATH}${id}/`, base);
  url.search = '';
  url.hash = '';
  return url.href;
}
