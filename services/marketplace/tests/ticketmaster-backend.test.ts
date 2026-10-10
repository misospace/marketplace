import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TicketmasterEventsBackend } from '../src/ticketmaster-backend.js';
import { ProviderError } from '../src/backend.js';
import { eventAvailabilitySchema, eventsFetchInputSchema, eventsSearchInputSchema } from '../src/domain.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/events/${name}`, import.meta.url), 'utf8'));
let server: Server;
let origin = '';
let mode = 'normal';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (mode === 'hang') return;
    if (pathname.endsWith('/events.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(
        mode === 'empty' ? fixture('search-empty.json')
          : mode === 'malformed' ? fixture('search-malformed.json')
            : mode === 'statuses' ? statusPayload()
              : mode === 'coercion' ? coercionPayload()
                : fixture('search-success.json')
      ));
      return;
    }
    if (mode === 'not-found') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('event-404.json'))); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('event-success.json')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

function backend() { return new TicketmasterEventsBackend({ apiKey: 'synthetic', baseUrl: origin }); }
const signal = () => new AbortController().signal;
const searchInput = eventsSearchInputSchema.parse({ query: 'synthetic', limit: 10 });

function statusPayload() {
  const row = (id: string, code: string) => ({ id, name: `Synthetic ${code}`, url: `https://www.ticketmaster.com/event/${id}`, dates: { status: { code } } });
  return { _embedded: { events: [
    row('s1', 'onsale'),
    row('s2', 'offsale'),
    row('s3', 'cancelled'),
    row('s4', 'postponed'),
    row('s5', 'rescheduled'),
    row('s6', 'MysteryCode')
  ] } };
}

function coercionPayload() {
  return { _embedded: { events: [
    // An absent bound must stay null (Number(null) is 0); the other bound is preserved.
    { id: 'c1', name: 'Synthetic Partial Range', url: 'https://www.ticketmaster.com/event/c1', priceRanges: [{ currency: 'USD', min: null, max: 50 }] },
    // An empty string bound must stay null (Number('') is 0).
    { id: 'c2', name: 'Synthetic Empty Range', url: 'https://www.ticketmaster.com/event/c2', priceRanges: [{ currency: 'USD', min: '', max: '' }] },
    // A numeric range without a currency marker is unattributable and must be dropped.
    { id: 'c3', name: 'Synthetic No Currency', url: 'https://www.ticketmaster.com/event/c3', priceRanges: [{ min: 10, max: 20 }] }
  ] } };
}

describe('TicketmasterEventsBackend', () => {
  it('maps a full search event into a valid EventAvailability record', async () => {
    mode = 'normal';
    const events = await backend().search(searchInput, signal());
    expect(events).toHaveLength(1);
    expect(eventAvailabilitySchema.parse(events[0])).toMatchObject({
      provider: 'ticketmaster', id: 'G5v0Z9Yqk1', status: 'on_sale',
      starts_at: '2025-06-01T19:30:00-07:00', timezone: 'America/Los_Angeles',
      price_min: 25.5, price_max: 95, currency: 'USD',
      venue: 'Synthetic Concert Hall', location: 'Portland, US',
      on_sale_start: '2025-03-01T17:00:00Z', on_sale_end: '2025-06-01T18:00:00Z',
      classifications: ['Music', 'Classical', 'Symphony']
    });
    expect(events[0]?.images).toEqual(['https://s1.ticketm.net/dam/a/synthetic-1.jpg', 'https://s1.ticketm.net/dam/a/synthetic-2.jpg']);
  });

  it('maps Discovery status codes case-insensitively and keeps unrecognized codes unknown', async () => {
    mode = 'statuses';
    const events = await backend().search(searchInput, signal());
    expect(events.map((event) => event.status)).toEqual(['on_sale', 'off_sale', 'cancelled', 'postponed', 'rescheduled', 'unknown']);
  });

  it('refuses the null/empty price coercion trap and drops an unattributable range', async () => {
    mode = 'coercion';
    const events = await backend().search(searchInput, signal());
    expect(events.map((event) => [event.id, event.price_min, event.price_max, event.currency])).toEqual([
      ['c1', null, 50, 'USD'],
      ['c2', null, null, null],
      ['c3', null, null, null]
    ]);
  });

  it('returns an empty list when events are absent with a zero total', async () => {
    mode = 'empty';
    await expect(backend().search(searchInput, signal())).resolves.toEqual([]);
  });

  it('rejects a search response with no events and a non-zero total as schema drift', async () => {
    mode = 'malformed';
    await expect(backend().search(searchInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Ticketmaster search response was not recognized.'
    });
  });

  it('fetches an event by id and by canonical URL', async () => {
    mode = 'normal';
    const byId = await backend().fetch(eventsFetchInputSchema.parse({ id: 'G5v0Z9Yqk1' }), signal());
    expect(byId).toMatchObject({ id: 'G5v0Z9Yqk1', status: 'on_sale' });
    eventAvailabilitySchema.parse(byId);
    const byUrl = await backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.com/event/G5v0Z9Yqk1?utm=1' }), signal());
    expect(byUrl).toMatchObject({ id: 'G5v0Z9Yqk1' });
  });

  it('round-trips a search result that points at a regional Ticketmaster host', async () => {
    mode = 'normal';
    // The Discovery API emits canonical URLs that may use regional Ticketmaster host roots
    // (e.g. ticketmaster.ca for Canadian markets). Accepting the regional host and extracting
    // the same id is what makes the search→fetch round trip close without surfacing an
    // `UPSTREAM_ERROR` for legitimate results.
    const byUrl = await backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.ca/event/G5v0Z9Yqk1' }), signal());
    expect(byUrl).toMatchObject({ id: 'G5v0Z9Yqk1' });
    const byUk = await backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.co.uk/event/G5v0Z9Yqk1?lang=en' }), signal());
    expect(byUk).toMatchObject({ id: 'G5v0Z9Yqk1' });
    const byAu = await backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.com.au/event/G5v0Z9Yqk1' }), signal());
    expect(byAu).toMatchObject({ id: 'G5v0Z9Yqk1' });
  });

  it('rejects lookalike and off-allowlist hosts while still trusting the regional suffix', async () => {
    mode = 'normal';
    // A lookalike that ends in `ticketmaster.com.evil.example` is not on the allowlist and
    // must not be accepted; the strict suffix check rejects it.
    await expect(backend().fetch(eventsFetchInputSchema.parse({ url: 'https://ticketmaster.com.evil.example/event/G5v0Z9Yqk1' }), signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Ticketmaster event URL does not contain an event id.'
    });
    // A typosquatted host that isn't a real Ticketmaster regional root is also rejected.
    await expect(backend().fetch(eventsFetchInputSchema.parse({ url: 'https://ticketmastercom/event/G5v0Z9Yqk1' }), signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Ticketmaster event URL does not contain an event id.'
    });
    // A subdomain on a regional root is still trusted.
    const byLocale = await backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www1.ticketmaster.ca/event/G5v0Z9Yqk1' }), signal());
    expect(byLocale).toMatchObject({ id: 'G5v0Z9Yqk1' });
    // A host that is a real regional root but is on plain http still has its id extracted
    // (the destination restriction on the API client is the real safety mechanism, and a
    // future per-URL credential-destination check would belong there). The lookup itself
    // does not navigate to the URL.
    const byHttpCa = await backend().fetch(eventsFetchInputSchema.parse({ url: 'http://www.ticketmaster.ca/event/G5v0Z9Yqk1' }), signal());
    expect(byHttpCa).toMatchObject({ id: 'G5v0Z9Yqk1' });
  });

  it('extracts the id by path segment so a longer id or a non-event path is handled correctly', async () => {
    mode = 'normal';
    // The id boundary is the path segment, not a regex prefix. A URL that points at a
    // artist page (no `event` segment) is rejected, not silently misread.
    await expect(backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.com/artist/12345' }), signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Ticketmaster event URL does not contain an event id.'
    });
    // An `event-prefix` segment is not the `event` segment — exact equality is required, so
    // this is rejected rather than returning a wrong id.
    await expect(backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.com/event-prefix/12345' }), signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Ticketmaster event URL does not contain an event id.'
    });
  });

  it('rejects a URL that carries no event id', async () => {
    await expect(backend().fetch(eventsFetchInputSchema.parse({ url: 'https://www.ticketmaster.com/artist/12345' }), signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Ticketmaster event URL does not contain an event id.'
    });
    expect(ProviderError).toBeDefined();
  });

  it('maps a 404 to the house no-result case so the tool layer reports NOT_FOUND', async () => {
    mode = 'not-found';
    await expect(backend().fetch(eventsFetchInputSchema.parse({ id: 'missing' }), signal())).resolves.toBeNull();
  });

  it('honors an already-aborted signal as TIMEOUT', async () => {
    mode = 'hang';
    const controller = new AbortController(); controller.abort(new Error('caller aborted'));
    await expect(backend().search(searchInput, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
