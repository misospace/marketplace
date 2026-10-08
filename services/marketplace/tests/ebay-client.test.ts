import { describe, expect, it } from 'vitest';
import { EbayClient, EbayHttpError } from '../src/ebay.js';

const options = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', baseUrl: 'http://localhost' };
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('EbayClient', () => {
  it('caches an application token across calls', async () => {
    let tokenCalls = 0;
    const client = new EbayClient({ ...options, fetchImpl: async (input) => {
      if (String(input).includes('/oauth2/token')) { tokenCalls++; return ok({ access_token: 'synthetic', expires_in: 3600 }); }
      return ok({ itemSummaries: [] });
    } });
    await client.searchItems('synthetic', { limit: 2 });
    await client.getItemByLegacyId('123');
    expect(tokenCalls).toBe(1);
  });

  it('refreshes an expired token lazily', async () => {
    let tokenCalls = 0;
    const client = new EbayClient({ ...options, fetchImpl: async (input) => {
      if (String(input).includes('/oauth2/token')) { tokenCalls++; return ok({ access_token: `synthetic-${tokenCalls}`, expires_in: 1 }); }
      return ok({ itemSummaries: [] });
    } });
    await client.searchItems('synthetic', { limit: 1 });
    await client.searchItems('synthetic', { limit: 1 });
    expect(tokenCalls).toBe(2);
  });

  it('retries a 401 once with a refreshed token, then exposes AUTH mapping status', async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const client = new EbayClient({ ...options, fetchImpl: async (input) => {
      if (String(input).includes('/oauth2/token')) { tokenCalls++; return ok({ access_token: `synthetic-${tokenCalls}`, expires_in: 3600 }); }
      apiCalls++;
      return new Response('', { status: 401 });
    } });
    await expect(client.getItemByLegacyId('123')).rejects.toMatchObject({ name: 'EbayHttpError', status: 401 });
    expect(tokenCalls).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it('preserves numeric retry-after on 429', async () => {
    const client = new EbayClient({ ...options, fetchImpl: async (input) => String(input).includes('/oauth2/token')
      ? ok({ access_token: 'synthetic', expires_in: 3600 }) : new Response('', { status: 429, headers: { 'retry-after': '7' } }) });
    await expect(client.getItemByLegacyId('123')).rejects.toMatchObject({ status: 429, retryAfter: 7 });
  });

  it('treats a missing retry-after as no hint, not zero', async () => {
    const client = new EbayClient({ ...options, fetchImpl: async (input) => String(input).includes('/oauth2/token')
      ? ok({ access_token: 'synthetic', expires_in: 3600 }) : new Response('', { status: 429 }) });
    await expect(client.getItemByLegacyId('123')).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('validates constructor credentials and base URL', () => {
    expect(() => new EbayClient({ ...options, clientId: '  ' })).toThrow(TypeError);
    expect(() => new EbayClient({ ...options, clientSecret: '' })).toThrow(TypeError);
    expect(() => new EbayClient({ ...options, baseUrl: 'https://user:pass@host' })).toThrow(TypeError);
    expect(EbayHttpError).toBeDefined();
  });
});
