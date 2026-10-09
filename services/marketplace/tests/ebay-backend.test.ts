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
let lastPath = '';
let lastMarketplaceId = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    lastPath = pathname;
    const marketplaceHeader = req.headers['x-ebay-c-marketplace-id'];
    lastMarketplaceId = Array.isArray(marketplaceHeader) ? marketplaceHeader[0] ?? '' : marketplaceHeader ?? '';
    if (pathname.endsWith('/oauth2/token')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('token.json'))); return; }
    if (mode === 'hang') return;
    if (pathname.endsWith('/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'unmappable'
        ? { itemSummaries: [{ itemId: 'invalid', title: 'No URL' }, { itemId: 'v1|123|1', itemWebUrl: 'https://www.ebay.com/itm/123', title: 'Synthetic Good Row' }] }
        : mode === 'coercion' ? coercionTrapPayload()
        : mode === 'variations' ? variationsPayload()
        : mode === 'conditions' ? conditionsPayload()
        : mode === 'malformed' ? { total: 3, warnings: [] }
        : fixture('search-success.json')));
      return;
    }
    if (mode === 'missing-url') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ itemId: '123', title: 'Synthetic Missing URL' })); return; }
    if (mode === 'variations') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...fixture('item-success.json'), itemId: 'v1|555000|2', title: 'Synthetic Widget Variation Two' })); return; }
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

function variationsPayload() {
  return { itemSummaries: [
    { itemId: 'v1|555000|1', itemWebUrl: 'https://www.ebay.com/itm/555000', title: 'Synthetic Widget Variation One', price: { value: '10.00', currency: 'USD' }, condition: 'New' },
    { itemId: 'v1|555000|2', itemWebUrl: 'https://www.ebay.com/itm/555000', title: 'Synthetic Widget Variation Two', price: { value: '12.00', currency: 'USD' }, condition: 'New' }
  ] };
}

function conditionsPayload() {
  const row = (itemId: string, condition: string) => ({ itemId, itemWebUrl: `https://www.ebay.com/itm/${itemId.split('|')[1]}`, title: `Synthetic ${condition}`, price: { value: '5.00', currency: 'USD' }, condition });
  return { itemSummaries: [
    row('v1|6001|0', 'Brand New'),
    row('v1|6002|0', 'Like New'),
    row('v1|6003|0', 'Used - Like New'),
    row('v1|6004|0', 'New other (see details)'),
    row('v1|6005|0', 'Excellent - Refurbished'),
    row('v1|6006|0', 'For parts or not working'),
    row('v1|6007|0', 'Mystery Condition')
  ] };
}

function coercionTrapPayload() {
  return { itemSummaries: [
    // Null price value must stay null (Number(null) is 0); renewed is refurbished; the
    // FREE shipping marker is shippingCostType on the option, not a field on the cost.
    { itemId: 'v1|2001|0', itemWebUrl: 'https://www.ebay.com/itm/2001', title: 'Synthetic Null Price', price: { value: null, currency: 'USD' }, condition: 'Renewed', shippingOptions: [{ shippingCostType: 'FREE', shippingCost: { value: '0.00', currency: 'USD' } }] },
    // A numeric price with no currency marker is unattributable and must be dropped.
    { itemId: 'v1|2002|0', itemWebUrl: 'https://www.ebay.com/itm/2002', title: 'Synthetic No Currency', price: { value: '12.50' } },
    // An unspecified shipping value is not free (Number('') is 0).
    { itemId: 'v1|2003|0', itemWebUrl: 'https://www.ebay.com/itm/2003', title: 'Synthetic Empty Shipping', price: { value: '5.00', currency: 'USD' }, shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '', currency: 'USD' } }] }
  ] };
}

describe('EbayShoppingBackend', () => {
  it('maps search offers into valid ProductOffer records', async () => {
    mode = 'normal';
    const offers = await backend().search(searchInput, signal());
    expect(offers).toHaveLength(2);
    expect(productOfferSchema.parse(offers[0])).toMatchObject({ id: 'v1|123456789012|0', availability: 'unknown', condition: 'new', shipping_cost: 3.25, shipping_currency: 'USD', location: 'Sampleton, US', state: 'active' });
  });
  it('fetches item details by legacy id', async () => {
    mode = 'normal';
    const offer = await backend().fetch(shoppingFetchInputSchema.parse({ id: '123456789012' }), signal());
    expect(offer).toMatchObject({ id: 'v1|123456789012|0', availability: 'in_stock' });
    productOfferSchema.parse(offer);
  });
  it('preserves variation identity: two variants of one listing stay distinct, and a RESTful id fetches the exact variant', async () => {
    mode = 'variations';
    const offers = await backend().search(searchInput, signal());
    expect(offers.map((offer) => offer.id)).toEqual(['v1|555000|1', 'v1|555000|2']);
    const offer = await backend().fetch(shoppingFetchInputSchema.parse({ id: 'v1|555000|2' }), signal());
    expect(offer).toMatchObject({ id: 'v1|555000|2', title: 'Synthetic Widget Variation Two' });
    expect(lastPath).toBe(`/buy/browse/v1/item/${encodeURIComponent('v1|555000|2')}`);
  });
  it('sends the marketplace header in eBay\'s underscore form', async () => {
    mode = 'normal';
    await backend().search(searchInput, signal());
    expect(lastMarketplaceId).toBe('EBAY_US');
  });
  it('skips unmappable search rows and fails closed on a fetch without URL', async () => {
    mode = 'unmappable';
    expect(await backend().search(searchInput, signal())).toHaveLength(1);
    mode = 'missing-url';
    await expect(backend().fetch(shoppingFetchInputSchema.parse({ id: '123' }), signal())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
  it('refuses coercion traps and keeps attribution only where eBay states it', async () => {    mode = 'coercion';
    const offers = await backend().search(searchInput, signal());
    expect(offers).toHaveLength(2);
    expect(productOfferSchema.parse(offers[0])).toMatchObject({
      id: 'v1|2001|0', price: null, currency: 'USD', condition: 'refurbished', shipping_cost: 0, shipping_currency: 'USD'
    });
    expect(offers[1]).toMatchObject({ id: 'v1|2003|0', shipping_cost: null, shipping_currency: null });
  });
  it('maps eBay condition labels precisely: Like New is used, ambiguous is unknown', async () => {
    mode = 'conditions';
    const offers = await backend().search(searchInput, signal());
    expect(Object.fromEntries(offers.map((offer) => [offer.title, offer.condition]))).toEqual({
      'Synthetic Brand New': 'new',
      'Synthetic Like New': 'used',
      'Synthetic Used - Like New': 'used',
      'Synthetic New other (see details)': 'new',
      'Synthetic Excellent - Refurbished': 'refurbished',
      'Synthetic For parts or not working': 'unknown',
      'Synthetic Mystery Condition': 'unknown'
    });
  });
  it('rejects a search response with no itemSummaries and no zero total as schema drift', async () => {
    mode = 'malformed';
    await expect(backend().search(searchInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The eBay search response was not recognized.'
    });
  });
  it('maps a 404 to the house no-result case so the tool layer reports NOT_FOUND', async () => {
    mode = 'not-found';
    await expect(backend().fetch(shoppingFetchInputSchema.parse({ id: '123' }), signal())).resolves.toBeNull();
    expect(ProviderError).toBeDefined();
  });
  it('honors an already-aborted signal as TIMEOUT', async () => {
    mode = 'hang';
    const controller = new AbortController(); controller.abort(new Error('caller aborted'));
    await expect(backend().search(searchInput, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
