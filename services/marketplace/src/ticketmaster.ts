export interface TicketmasterClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface TicketmasterSearchOptions {
  city?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
}

export class TicketmasterHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super(`Ticketmaster API returned HTTP ${status}`);
    this.name = 'TicketmasterHttpError';
  }
}

export class TicketmasterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;

  constructor(options: TicketmasterClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) throw new TypeError('apiKey must not be empty');
    const base = options.baseUrl ?? 'https://app.ticketmaster.com';
    // Credential-destination restriction: the Discovery API key travels as a query parameter,
    // so the client must not be pointable at arbitrary origins. The only runtime target is
    // Ticketmaster's production host over HTTPS; loopback exists solely as an explicit test
    // seam. There is deliberately no environment variable that can move this destination.
    let parsed: URL;
    try { parsed = new URL(base); } catch { throw new TypeError('baseUrl must be a valid URL'); }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
    const isTicketmasterHost = parsed.protocol === 'https:' && host === 'app.ticketmaster.com';
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (!isTicketmasterHost && !(isLoopback && ['http:', 'https:'].includes(parsed.protocol)))) {
      throw new TypeError('baseUrl must be https://app.ticketmaster.com or a loopback test address');
    }
    this.baseUrl = base.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
  }

  async searchEvents(query: string, options: TicketmasterSearchOptions, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ apikey: this.apiKey, keyword: query, size: String(options.limit) });
    if (options.city !== undefined) params.set('city', options.city);
    if (options.startDate !== undefined) params.set('startDateTime', `${options.startDate}T00:00:00Z`);
    if (options.endDate !== undefined) params.set('endDateTime', `${options.endDate}T23:59:59Z`);
    return this.apiRequest(`/discovery/v2/events.json?${params}`, signal);
  }

  async getEvent(id: string, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ apikey: this.apiKey });
    return this.apiRequest(`/discovery/v2/events/${encodeURIComponent(id)}.json?${params}`, signal);
  }

  private async apiRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' }, signal
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
}

async function responseError(response: Response): Promise<TicketmasterHttpError> {
  // A missing header means "no hint" — Number(null) is 0, which would read as "retry now".
  const header = response.headers.get('retry-after');
  const value = header === null ? NaN : Number(header);
  return new TicketmasterHttpError(response.status, Number.isFinite(value) && value >= 0 ? value : undefined);
}
