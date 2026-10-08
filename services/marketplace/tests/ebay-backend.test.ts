import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EbayShoppingBackend } from '../src/ebay-backend.js';
import { ProviderError } from '../src/backend.js';
import { productOfferSchema, shoppingFetchInputSchema, shoppingSearchInputSchema } from '../src/domain.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ebay/${name}`, import.meta.url), 'utf8'));
let server: Server;
let origin = '';
let mode = 'normal';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname.endsWith('/oauth2/token')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('token.json'))); return; }
    if (mode === 'hang') return;
    if (pathname.endsWith('/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'unmappable' ? { itemSummaries: [{ itemId: 'invalid', title: 'No URL' }, { itemId: 'v1|123|1', itemWebUrl: 'https://www.ebay.com/itm/123', title: 'Synthetic Good Row' }] } : fixture('search-success.json')));
      return;
    }
    if (mode === 'missing-url') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ itemId: '123', title: 'Synthetic Missing URL' })); return; }
    if (mode === 'not-found') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('item-404.json'))); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('item-success.json')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
function backend() { return new EbayShoppingBackend({ clientId: 'synthetic', clientSecret: 'synthetic', baseUrl: origin }); }
const signal = () => new AbortController().signal;
const searchInput = shoppingSearchInputSchema.parse({ query: 'synthetic', limit: 10 });

describe('EbayShoppingBackend', () => {
  it('maps search offers into valid ProductOffer records', async () => {
    mode = 'normal';
    const offers = await backend().search(searchInput, signal());
    expect(offers).toHaveLength(2);
    expect(productOfferSchema.parse(offers[0])).toMatchObject({ id: '123456789012', availability: 'unknown', condition: 'new', shipping_cost: 3.25, location: 'Sampleton, US', state: 'active' });
  });
  it('fetches item details by legacy id', async () => {
    mode = 'normal';
    const offer = await backend().fetch(shoppingFetchInputSchema.parse({ id: '123456789012' }), signal());
    expect(offer).toMatchObject({ id: '123456789012', availability: 'in_stock' });
    productOfferSchema.parse(offer);
  });
  it('skips unmappable search rows and fails closed on a fetch without URL', async () => {
    mode = 'unmappable';
    expect(await backend().search(searchInput, signal())).toHaveLength(1);
    mode = 'missing-url';
    await expect(backend().fetch(shoppingFetchInputSchema.parse({ id: '123' }), signal())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
  it('maps a 404 to NOT_FOUND', async () => {
    mode = 'not-found';
    await expect(backend().fetch(shoppingFetchInputSchema.parse({ id: '123' }), signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'NOT_FOUND' });
    expect(ProviderError).toBeDefined();
  });
  it('honors an already-aborted signal as TIMEOUT', async () => {
    mode = 'hang';
    const controller = new AbortController(); controller.abort(new Error('caller aborted'));
    await expect(backend().search(searchInput, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
