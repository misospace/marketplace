import { z } from 'zod';
import { ProviderError, type EventsBackend } from './backend.js';
import { eventAvailabilitySchema, type EventAvailability } from './domain.js';
import { TicketmasterClient, TicketmasterHttpError, type TicketmasterClientOptions } from './ticketmaster.js';

const isoOffsetSchema = z.string().datetime({ offset: true });

export class TicketmasterEventsBackend implements EventsBackend {
  readonly name = 'ticketmaster';
  private readonly client: TicketmasterClient;
  private readonly requestTimeoutMs: number;

  constructor(client: TicketmasterClient | TicketmasterClientOptions, options: { requestTimeoutMs?: number } = {}) {
    this.client = client instanceof TicketmasterClient ? client : new TicketmasterClient(client);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    validateTimeout(this.requestTimeoutMs, 'requestTimeoutMs');
  }

  async search(input: Parameters<EventsBackend['search']>[0], signal: AbortSignal): Promise<EventAvailability[]> {
    return this.withDeadline(signal, async (requestSignal) => {
      try {
        const payload = await this.client.searchEvents(input.query, {
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.start_date !== undefined ? { startDate: input.start_date } : {}),
          ...(input.end_date !== undefined ? { endDate: input.end_date } : {}),
          limit: input.limit
        }, requestSignal) as { _embedded?: { events?: unknown }; page?: { totalElements?: unknown } };
        const embedded = payload?._embedded?.events;
        if (Array.isArray(embedded)) {
          const events: EventAvailability[] = [];
          for (const item of embedded) {
            const event = mapEvent(item);
            if (event) events.push(event);
            if (events.length >= input.limit) break;
          }
          return events;
        }
        // Discovery omits `_embedded.events` on legitimate zero-result responses
        // (page.totalElements: 0). Anything else is schema drift — a typed error.
        if (payload?.page?.totalElements === 0) return [];
        throw new ProviderError('UPSTREAM_ERROR', 'The Ticketmaster search response was not recognized.');
      } catch (error) { throw mapError(error); }
    });
  }

  async fetch(input: Parameters<EventsBackend['fetch']>[0], signal: AbortSignal): Promise<EventAvailability | null> {
    return this.withDeadline(signal, async (requestSignal) => {
      try {
        const id = input.id ?? eventIdFromUrl(input.url!);
        if (!id) throw new ProviderError('UPSTREAM_ERROR', 'The Ticketmaster event URL does not contain an event id.');
        const item = await this.client.getEvent(id, requestSignal);
        const event = mapEvent(item);
        if (!event) throw new ProviderError('UPSTREAM_ERROR', 'The Ticketmaster event could not be mapped to an availability record.');
        return event;
      } catch (error) {
        // A missing event is the house "no result" case: return null and let the tool layer
        // report NOT_FOUND, mirroring the other backends.
        if (error instanceof TicketmasterHttpError && error.status === 404) return null;
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
  return new ProviderError('TIMEOUT', signal.reason instanceof Error && signal.reason.message === 'deadline exceeded' ? 'The Ticketmaster request timed out.' : 'The Ticketmaster request was aborted.');
}

function mapError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof TicketmasterHttpError) {
    if (error.status === 401 || error.status === 403) return new ProviderError('AUTH_EXPIRED', 'Ticketmaster authentication has expired.');
    if (error.status === 404) return new ProviderError('UPSTREAM_ERROR', 'The Ticketmaster event was not found.');
    if (error.status === 429) return new ProviderError('RATE_LIMITED', 'Ticketmaster rate limit was reached.', error.retryAfter === undefined ? {} : { retry_after: error.retryAfter });
    return new ProviderError('UPSTREAM_ERROR', 'The Ticketmaster request failed.');
  }
  return new ProviderError('UPSTREAM_ERROR', 'The Ticketmaster request failed.');
}

function eventIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== 'ticketmaster.com' && !host.endsWith('.ticketmaster.com')) return null;
    const match = url.pathname.match(/\/event\/([A-Za-z0-9]+)/);
    return match?.[1] ?? null;
  } catch { return null; }
}

function isoWithOffset(value: unknown): string | null {
  const parsed = isoOffsetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapEvent(value: unknown): EventAvailability | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, any>;
  const id = typeof item.id === 'string' ? item.id : '';
  const name = item.name;
  const url = item.url;
  if (!id || typeof name !== 'string' || typeof url !== 'string') return null;

  const price = priceFromRanges(item.priceRanges);
  const event = {
    provider: 'ticketmaster', id, url, name,
    // TBD/TBA or a date without a local time has no instant; never fabricate an offset.
    starts_at: isoWithOffset(item.dates?.start?.dateTime),
    timezone: typeof item.dates?.timezone === 'string' && item.dates.timezone ? item.dates.timezone : null,
    status: statusFromCode(item.dates?.status?.code),
    price_min: price.min, price_max: price.max, currency: price.currency,
    venue: venueName(item),
    location: venueLocation(item),
    on_sale_start: isoWithOffset(item.sales?.public?.startDateTime),
    on_sale_end: isoWithOffset(item.sales?.public?.endDateTime),
    classifications: classifications(item),
    images: images(item)
  };
  const parsed = eventAvailabilitySchema.safeParse(event);
  return parsed.success ? parsed.data : null;
}

// Discovery exposes event-level on-sale state, not seat-level inventory, so it can never
// prove `sold_out`; that status is fixture-only. Unrecognized codes stay `unknown`.
const EVENT_STATUS: Readonly<Record<string, EventAvailability['status']>> = {
  onsale: 'on_sale',
  offsale: 'off_sale',
  cancelled: 'cancelled',
  postponed: 'postponed',
  rescheduled: 'rescheduled'
};

function statusFromCode(value: unknown): EventAvailability['status'] {
  if (typeof value !== 'string') return 'unknown';
  return EVENT_STATUS[value.trim().toLowerCase()] ?? 'unknown';
}

function finiteOrNull(value: unknown): number | null {
  // Coercion trap: Number(null) and Number('') are 0, so an absent or empty bound must be
  // rejected before coercion rather than defaulted to free.
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function priceFromRanges(value: unknown): { min: number | null; max: number | null; currency: string | null } {
  if (!Array.isArray(value)) return { min: null, max: null, currency: null };
  for (const range of value) {
    if (!range || typeof range !== 'object') continue;
    const record = range as Record<string, any>;
    if (typeof record.currency !== 'string' || !record.currency) continue;
    const min = finiteOrNull(record.min);
    const max = finiteOrNull(record.max);
    if (min === null && max === null) continue;
    return { min, max, currency: record.currency };
  }
  return { min: null, max: null, currency: null };
}

function venueName(item: Record<string, any>): string | null {
  const name = item._embedded?.venues?.[0]?.name;
  return typeof name === 'string' && name ? name : null;
}

function venueLocation(item: Record<string, any>): string | null {
  const venue = item._embedded?.venues?.[0];
  if (!venue || typeof venue !== 'object') return null;
  const city = venue.city?.name;
  const country = venue.country?.countryCode;
  const cityName = typeof city === 'string' && city ? city : null;
  const countryCode = typeof country === 'string' && country ? country : null;
  if (cityName && countryCode) return `${cityName}, ${countryCode}`;
  return cityName ?? countryCode;
}

function classifications(item: Record<string, any>): string[] {
  if (!Array.isArray(item.classifications)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of item.classifications) {
    if (!entry || typeof entry !== 'object') continue;
    for (const field of ['segment', 'genre', 'subGenre'] as const) {
      const name = entry[field]?.name;
      if (typeof name === 'string' && name && !seen.has(name)) {
        seen.add(name);
        result.push(name);
        if (result.length >= 6) return result;
      }
    }
  }
  return result;
}

function images(item: Record<string, any>): string[] {
  if (!Array.isArray(item.images)) return [];
  return item.images.map((image: any) => image?.url).filter((url): url is string => typeof url === 'string').slice(0, 6);
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}
