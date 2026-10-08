import { ProviderError, type ShoppingBackend } from './backend.js';
import { productOfferSchema, type ProductOffer } from './domain.js';
import { EbayClient, EbayHttpError, type EbayClientOptions } from './ebay.js';

export class EbayShoppingBackend implements ShoppingBackend {
  readonly name = 'ebay';
  private readonly client: EbayClient;
  private readonly requestTimeoutMs: number;

  constructor(client: EbayClient | EbayClientOptions, options: { requestTimeoutMs?: number } = {}) {
    this.client = client instanceof EbayClient ? client : new EbayClient(client);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    validateTimeout(this.requestTimeoutMs, 'requestTimeoutMs');
  }

  async search(input: Parameters<ShoppingBackend['search']>[0], signal: AbortSignal): Promise<ProductOffer[]> {
    return this.withDeadline(signal, async (requestSignal) => {
      try {
        const payload = await this.client.searchItems(input.query, { limit: input.limit, minPrice: input.min_price, maxPrice: input.max_price }, requestSignal) as { itemSummaries?: unknown; total?: unknown };
        if (!Array.isArray(payload?.itemSummaries)) {
          // eBay omits itemSummaries on legitimate zero-result responses (total: 0). An absent
          // array with no zero total is schema drift — a typed error, never a silent empty page.
          if (payload?.total === 0) return [];
          throw new ProviderError('UPSTREAM_ERROR', 'The eBay search response was not recognized.');
        }
        const offers: ProductOffer[] = [];
        for (const item of payload.itemSummaries) {
          const offer = mapOffer(item, false);
          if (offer) offers.push(offer);
          if (offers.length >= input.limit) break;
        }
        return offers;
      } catch (error) { throw mapError(error); }
    });
  }

  async fetch(input: Parameters<ShoppingBackend['fetch']>[0], signal: AbortSignal): Promise<ProductOffer | null> {
    return this.withDeadline(signal, async (requestSignal) => {
      try {
        // A RESTful id addresses the exact variation via GET /item/{id}; a legacy numeric id
        // or an /itm/ URL can only address the parent listing — variation ambiguity is honest
        // and documented there (docs/shopping-provider-research.md).
        const restful = input.id !== undefined && /^v1\|[^|]+\|[^|]+$/.test(input.id);
        const id = input.id ?? legacyIdFromUrl(input.url!);
        if (!id) throw new ProviderError('UPSTREAM_ERROR', 'The eBay item URL does not contain a legacy item id.');
        const item = restful
          ? await this.client.getItemByRestfulId(id, requestSignal)
          : await this.client.getItemByLegacyId(id, requestSignal);
        const offer = mapOffer(item, true);
        if (!offer) throw new ProviderError('UPSTREAM_ERROR', 'The eBay item could not be mapped to a product offer.');
        return offer;
      } catch (error) {
        // A missing item is the house "no result" case: return null and let the tool layer
        // report NOT_FOUND, mirroring the other backends.
        if (error instanceof EbayHttpError && error.status === 404) return null;
        throw mapError(error);
      }
    });
  }

  private async withDeadline<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw timeoutOrAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('deadline exceeded')), this.requestTimeoutMs);
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(timeoutOrAbort(controller.signal)), { once: true }))
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}

function timeoutOrAbort(signal: AbortSignal): ProviderError {
  return new ProviderError('TIMEOUT', signal.reason instanceof Error && signal.reason.message === 'deadline exceeded' ? 'The eBay request timed out.' : 'The eBay request was aborted.');
}

function mapError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof EbayHttpError) {
    if (error.status === 401) return new ProviderError('AUTH_EXPIRED', 'eBay authentication has expired.');
    if (error.status === 404) return new ProviderError('UPSTREAM_ERROR', 'The eBay item was not found.');
    if (error.status === 429) return new ProviderError('RATE_LIMITED', 'eBay rate limit was reached.', error.retryAfter === undefined ? {} : { retry_after: error.retryAfter });
    return new ProviderError('UPSTREAM_ERROR', 'The eBay request failed.');
  }
  return new ProviderError('UPSTREAM_ERROR', 'The eBay request failed.');
}

function mapOffer(value: unknown, detail: boolean): ProductOffer | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, any>;
  const rawId = typeof item.itemId === 'string' ? item.itemId : '';
  // The RESTful item ID (v1|legacy|variation) is the canonical identity: stripping the
  // variation suffix would collapse distinct variants of one listing into one id and make
  // search→fetch round-trips resolve to a different variant or none. It is preserved whole.
  const id = rawId;
  const url = item.itemWebUrl;
  const title = item.title;
  if (!id || typeof url !== 'string' || typeof title !== 'string') return null;
  const priceValue = item.price?.value;
  // Coercion traps: Number(null) and Number('') are both 0, so an absent or unspecified
  // price must be rejected before coercion, not defaulted to free.
  const price = priceValue === undefined || priceValue === null || priceValue === '' ? null : Number(priceValue);
  const priceCurrency = item.price?.currency;
  // A numeric price without a currency marker cannot be attributed — drop the row rather
  // than default the currency (the marketplace id is pinned to EBAY_US today; a numeric
  // price with no currency would be unattributable in any marketplace).
  if (price !== null && typeof priceCurrency !== 'string') return null;
  const option = Array.isArray(item.shippingOptions) ? item.shippingOptions[0] : undefined;
  const shipping = option?.shippingCost;
  const shippingValue = typeof shipping?.value === 'string' ? shipping.value : undefined;
  // eBay marks free shipping with shippingCostType on the option, not a field on the cost.
  const freeShipping = option?.shippingCostType === 'FREE';
  const shippingCost = shipping === undefined
    ? null
    : freeShipping || shippingValue === '0' || shippingValue === '0.00'
      ? 0
      : shippingValue !== undefined && shippingValue.trim() !== '' ? Number(shippingValue) : null;
  const city = item.itemLocation?.city;
  const country = item.itemLocation?.country;
  const location = typeof city === 'string' && city ? `${city}${typeof country === 'string' && country ? `, ${country}` : ''}` : typeof country === 'string' && country ? country : null;
  const end = typeof item.itemEndDate === 'string' ? Date.parse(item.itemEndDate) : NaN;
  const offer = {
    provider: 'ebay', id, product_id: typeof item.epid === 'string' ? item.epid : null, url, title,
    price: price === null ? null : price, currency: typeof priceCurrency === 'string' ? priceCurrency : 'USD',
    condition: condition(item.condition),
    availability: detail ? (typeof item.estimatedAvailableQuantity === 'number' ? item.estimatedAvailableQuantity > 0 ? 'in_stock' : 'out_of_stock' : 'unknown') : 'unknown',
    shipping_cost: shipping === undefined ? null : shippingCost,
    // Currency is only meaningful paired with a numeric cost — a currency without a cost
    // (unspecified value, free shipping) is not interpretable.
    shipping_currency: typeof shippingCost === 'number' ? typeof shipping.currency === 'string' ? shipping.currency : null : null,
    location, seller: typeof item.seller?.username === 'string' && item.seller.username ? { name: item.seller.username } : null,
    posted_at: null, updated_at: null,
    images: [item.image?.imageUrl, ...(Array.isArray(item.additionalImages) ? item.additionalImages.map((image: any) => image?.imageUrl) : [])].filter((image): image is string => typeof image === 'string').slice(0, 6),
    state: Number.isFinite(end) && end <= Date.now() ? 'unknown' : 'active'
  };
  const parsed = productOfferSchema.safeParse(offer);
  return parsed.success ? parsed.data : null;
}

function legacyIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'ebay.com' && !url.hostname.endsWith('.ebay.com')) return null;
    const match = url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{1,32})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch { return null; }
}

function condition(value: unknown): ProductOffer['condition'] {
  if (typeof value !== 'string') return 'unknown';
  const lower = value.toLowerCase();
  // "Renewed" contains "new"; it must be classified as refurbished before the 'new' check.
  if (lower.includes('refurb') || lower === 'renewed' || lower.includes('renewed')) return 'refurbished';
  if (lower.includes('new')) return 'new';
  if (lower.includes('used') || lower.includes('pre-owned') || lower.includes('open box')) return 'used';
  return 'unknown';
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}
