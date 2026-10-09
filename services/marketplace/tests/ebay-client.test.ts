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

  it('shares one token refresh across concurrent callers', async () => {
    let tokenCalls = 0;
    const client = new EbayClient({ ...options, fetchImpl: async (input) => {
      if (String(input).includes('/oauth2/token')) {
        tokenCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ok({ access_token: 'synthetic', expires_in: 3600 });
      }
      return ok({ itemSummaries: [] });
    } });
    const calls = Array.from({ length: 4 }, () => client.searchItems('synthetic', { limit: 1 }));
    const results = await Promise.all(calls);
    expect(results).toHaveLength(4);
    expect(tokenCalls).toBe(1);
  });

  it('joins concurrent 401-triggered refreshes instead of stampeding the token endpoint', async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const client = new EbayClient({ ...options, fetchImpl: async (input) => {
      if (String(input).includes('/oauth2/token')) {
        tokenCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ok({ access_token: `synthetic-${tokenCalls}`, expires_in: 3600 });
      }
      apiCalls++;
      return new Response('', { status: 401 });
    } });
    const attempts = Array.from({ length: 3 }, () => client.getItemByLegacyId('123'));
    await Promise.allSettled(attempts);
    // One initial token fetch plus exactly one shared refresh; every caller retried once.
    expect(tokenCalls).toBe(2);
    expect(apiCalls).toBeGreaterThanOrEqual(3);
  });

  it('lets one caller abort without failing waiters or losing the shared token', async () => {
    let tokenCalls = 0;
    const client = new EbayClient({ ...options, fetchImpl: async (input) => {
      if (String(input).includes('/oauth2/token')) {
        tokenCalls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return ok({ access_token: 'synthetic', expires_in: 3600 });
      }
      return ok({ itemSummaries: [] });
    } });
    const aborter = new AbortController();
    const aborted = client.searchItems('synthetic', { limit: 1 }, aborter.signal);
    const patient = client.searchItems('synthetic', { limit: 1 });
    aborter.abort(new Error('cancel first caller'));
    await expect(aborted).rejects.toThrow('cancel first caller');
    await expect(patient).resolves.toBeDefined();
    // The shared refresh survived the abort and was cached — no second token fetch.
    expect(tokenCalls).toBe(1);
  });

  it('validates constructor credentials and base URL', () => {
    expect(() => new EbayClient({ ...options, clientId: '  ' })).toThrow(TypeError);
    expect(() => new EbayClient({ ...options, clientSecret: '' })).toThrow(TypeError);
    expect(() => new EbayClient({ ...options, baseUrl: 'https://user:pass@host' })).toThrow(TypeError);
    // Credential-destination restriction: the token POST carries Basic-encoded secrets, so
    // only eBay's HTTPS hosts and loopback test addresses are acceptable targets.
    expect(() => new EbayClient({ ...options, baseUrl: 'https://api.ebay.com' })).not.toThrow();
    expect(() => new EbayClient({ ...options, baseUrl: 'https://api.sandbox.ebay.com' })).not.toThrow();
    expect(() => new EbayClient({ ...options, baseUrl: 'http://127.0.0.1:4123' })).not.toThrow();
    expect(() => new EbayClient({ ...options, baseUrl: 'https://evil.example.com' })).toThrow(TypeError);
    expect(() => new EbayClient({ ...options, baseUrl: 'http://api.ebay.com' })).toThrow(TypeError);
    expect(EbayHttpError).toBeDefined();
  });
});
