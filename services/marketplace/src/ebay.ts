export interface EbayClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface EbaySearchOptions {
  limit: number;
  minPrice?: number;
  maxPrice?: number;
}

export class EbayHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super(`eBay API returned HTTP ${status}`);
    this.name = 'EbayHttpError';
  }
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

export class EbayClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private tokenRequest: Promise<string> | undefined;

  constructor(options: EbayClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    if (typeof options.clientId !== 'string' || !options.clientId.trim()) throw new TypeError('clientId must not be empty');
    if (typeof options.clientSecret !== 'string' || !options.clientSecret.trim()) throw new TypeError('clientSecret must not be empty');
    const base = options.baseUrl ?? 'https://api.ebay.com';
    let parsed: URL;
    try { parsed = new URL(base); } catch { throw new TypeError('baseUrl must be a valid HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('baseUrl must be a valid HTTP(S) origin/path');
    }
    this.baseUrl = base.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
  }

  private readonly clientId: string;
  private readonly clientSecret: string;

  async searchItems(query: string, options: EbaySearchOptions, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ q: query, limit: String(options.limit) });
    if (options.minPrice !== undefined || options.maxPrice !== undefined) {
      // Browse accepts price constraints as one filter expression; currency is pinned to EBAY-US/USD.
      params.set('filter', `price:[${options.minPrice ?? ''}..${options.maxPrice ?? ''}],priceCurrency:USD`);
    }
    return this.apiRequest(`/buy/browse/v1/item_summary/search?${params}`, signal);
  }

  async getItem(id: string, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ legacy_item_id: id });
    return this.apiRequest(`/buy/browse/v1/item/get_item_by_legacy_id?${params}`, signal);
  }

  private async apiRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    let token = await this.getToken(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY-US' }, signal
      });
      if (response.status === 401 && attempt === 0) {
        token = await this.getToken(signal, true);
        continue;
      }
      if (!response.ok) throw await responseError(response);
      return response.json();
    }
    throw new EbayHttpError(401);
  }

  private async getToken(signal?: AbortSignal, force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenRequest && !force) return this.tokenRequest;
    const request = (async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/identity/v2/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope', signal
      });
      if (!response.ok) throw await responseError(response);
      const payload = await response.json() as TokenResponse;
      if (typeof payload.access_token !== 'string' || !payload.access_token || typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in)) {
        throw new Error('Invalid eBay OAuth token response');
      }
      this.token = payload.access_token;
      this.tokenExpiresAt = Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
      return this.token;
    })();
    this.tokenRequest = request;
    try { return await request; } finally { if (this.tokenRequest === request) this.tokenRequest = undefined; }
  }
}

async function responseError(response: Response): Promise<EbayHttpError> {
  const value = Number(response.headers.get('retry-after'));
  return new EbayHttpError(response.status, Number.isFinite(value) && value >= 0 ? value : undefined);
}
