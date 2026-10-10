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
    // The user-supplied bounds are calendar dates (YYYY-MM-DD), not instants. Mapping them to
    // `startDateTime`/`endDateTime` would treat local-midnight in the event's timezone as a UTC
    // instant and silently drop late-evening shows on `end_date` while admitting events from the
    // previous local day. Discovery's documented `localStartDateTime` / `localEndDateTime`
    // parameters filter by the event's own local clock, which is the semantics a calendar date
    // implies. The bare `T00:00:00` / `T23:59:59` (no `Z`) is intentional — the provider reads
    // the value as the local event time.
    if (options.startDate !== undefined) params.set('localStartDateTime', `${options.startDate}T00:00:00`);
    if (options.endDate !== undefined) params.set('localEndDateTime', `${options.endDate}T23:59:59`);
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
  // `retry_after` must be a non-negative integer (providerErrorMetadataSchema), so a
  // malformed fractional header is truncated rather than allowed to break ProviderError
  // construction later; an HTTP-date value parses as NaN and yields no hint.
  const header = response.headers.get('retry-after');
  const value = header === null ? NaN : Number(header);
  return new TicketmasterHttpError(response.status, Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined);
}
