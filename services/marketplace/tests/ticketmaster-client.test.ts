import { describe, expect, it } from 'vitest';
import { TicketmasterClient, TicketmasterHttpError } from '../src/ticketmaster.js';

const options = { apiKey: 'synthetic-api-key', baseUrl: 'http://localhost' };
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('TicketmasterClient', () => {
  it('sends the Discovery query parameters without an Authorization header and uses local-time bounds for date-only inputs', async () => {
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    const client = new TicketmasterClient({ ...options, fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return ok({ _embedded: { events: [] } });
    } });
    await client.searchEvents('synthetic jazz', { city: 'Portland', startDate: '2025-06-01', endDate: '2025-06-30', limit: 5 });
    const url = new URL(seenUrl);
    expect(url.pathname).toBe('/discovery/v2/events.json');
    expect(url.searchParams.get('apikey')).toBe('synthetic-api-key');
    expect(url.searchParams.get('keyword')).toBe('synthetic jazz');
    expect(url.searchParams.get('size')).toBe('5');
    expect(url.searchParams.get('city')).toBe('Portland');
    // Calendar dates map onto the provider's documented local-time filter (`localStartDateTime` /
    // `localEndDateTime`); the bare `T00:00:00` is intentional — no `Z` suffix, interpreted in
    // the event's local timezone — so a 20:00 show in Calgary on 2025-06-30 is not excluded by
    // `endDate=2025-06-30`. Mapping onto `startDateTime`/`endDateTime` instead would treat the
    // bounds as UTC instants and silently drop late-evening shows on the last day while
    // admitting events from the previous local day.
    expect(url.searchParams.get('localStartDateTime')).toBe('2025-06-01T00:00:00');
    expect(url.searchParams.get('localEndDateTime')).toBe('2025-06-30T23:59:59');
    expect(url.searchParams.has('startDateTime')).toBe(false);
    expect(url.searchParams.has('endDateTime')).toBe(false);
    expect(seenHeaders?.has('authorization')).toBe(false);
  });

  it('omits the local-time bounds when only one calendar date is supplied', async () => {
    const seenUrls: string[] = [];
    const client = new TicketmasterClient({ ...options, fetchImpl: async (input) => {
      seenUrls.push(String(input));
      return ok({ _embedded: { events: [] } });
    } });
    await client.searchEvents('synthetic', { startDate: '2025-06-01', limit: 5 });
    const onlyStart = new URL(seenUrls[0]!);
    expect(onlyStart.searchParams.get('localStartDateTime')).toBe('2025-06-01T00:00:00');
    expect(onlyStart.searchParams.has('localEndDateTime')).toBe(false);
    await client.searchEvents('synthetic', { endDate: '2025-06-30', limit: 5 });
    const onlyEnd = new URL(seenUrls[1]!);
    expect(onlyEnd.searchParams.has('localStartDateTime')).toBe(false);
    expect(onlyEnd.searchParams.get('localEndDateTime')).toBe('2025-06-30T23:59:59');
  });

  it('fetches an event by URL-encoded id with the api key', async () => {
    let seenUrl = '';
    const client = new TicketmasterClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ id: 'synthetic' }); } });
    await client.getEvent('abc/def');
    const url = new URL(seenUrl);
    expect(url.pathname).toBe('/discovery/v2/events/abc%2Fdef.json');
    expect(url.searchParams.get('apikey')).toBe('synthetic-api-key');
  });

  it('exposes a 401 as a typed HTTP error', async () => {
    const client = new TicketmasterClient({ ...options, fetchImpl: async () => new Response('', { status: 401 }) });
    await expect(client.searchEvents('synthetic', { limit: 1 })).rejects.toMatchObject({ name: 'TicketmasterHttpError', status: 401 });
  });

  it('preserves a numeric retry-after on 429', async () => {
    const client = new TicketmasterClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '7' } }) });
    await expect(client.getEvent('synthetic')).rejects.toMatchObject({ status: 429, retryAfter: 7 });
  });

  it('treats a missing retry-after as no hint, not zero', async () => {
    const client = new TicketmasterClient({ ...options, fetchImpl: async () => new Response('', { status: 429 }) });
    await expect(client.getEvent('synthetic')).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('truncates a malformed fractional retry-after to an integer', async () => {
    const client = new TicketmasterClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '3.5' } }) });
    await expect(client.getEvent('synthetic')).rejects.toMatchObject({ status: 429, retryAfter: 3 });
  });

  it('validates the API key and restricts the credential destination', () => {
    expect(() => new TicketmasterClient({ ...options, apiKey: '  ' })).toThrow(TypeError);
    expect(() => new TicketmasterClient({ ...options, apiKey: '' })).toThrow(TypeError);
    expect(() => new TicketmasterClient({ ...options, baseUrl: 'https://app.ticketmaster.com' })).not.toThrow();
    expect(() => new TicketmasterClient({ ...options, baseUrl: 'http://127.0.0.1:4123' })).not.toThrow();
    expect(() => new TicketmasterClient({ ...options, baseUrl: 'http://localhost:4123' })).not.toThrow();
    expect(() => new TicketmasterClient({ ...options, baseUrl: 'https://evil.example.com' })).toThrow(TypeError);
    expect(() => new TicketmasterClient({ ...options, baseUrl: 'http://app.ticketmaster.com' })).toThrow(TypeError);
    expect(() => new TicketmasterClient({ ...options, baseUrl: 'https://user:pass@app.ticketmaster.com' })).toThrow(TypeError);
    expect(TicketmasterHttpError).toBeDefined();
  });
});
