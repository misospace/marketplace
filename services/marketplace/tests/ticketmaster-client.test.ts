import { describe, expect, it } from 'vitest';
import { TicketmasterClient, TicketmasterHttpError } from '../src/ticketmaster.js';

const options = { apiKey: 'synthetic-api-key', baseUrl: 'http://localhost' };
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('TicketmasterClient', () => {
  it('sends the Discovery query parameters without an Authorization header', async () => {
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
    expect(url.searchParams.get('startDateTime')).toBe('2025-06-01T00:00:00Z');
    expect(url.searchParams.get('endDateTime')).toBe('2025-06-30T23:59:59Z');
    expect(seenHeaders?.has('authorization')).toBe(false);
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
