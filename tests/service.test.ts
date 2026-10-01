import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FIXTURE_LISTINGS } from '../src/fixtures.js';
import type { MarketplaceBackend } from '../src/backend.js';
import { ProviderError } from '../src/index.js';
import { createMarketplaceService, type MarketplaceService } from '../src/service.js';
import { parseBackendTimeout } from '../src/service.js';
import * as packageEntry from '../src/index.js';
import { runBackendOperation } from '../src/tools.js';

let service: MarketplaceService;
let baseUrl: string;
const originalFetch = globalThis.fetch;
const clients: Client[] = [];

async function startService(backend?: MarketplaceBackend): Promise<void> {
  service = createMarketplaceService({ host: '127.0.0.1', port: 0, ...(backend ? { backend } : {}) });
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'marketplace-fixture-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

async function rpc(method: string, params: unknown, id = 91): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  return { status: response.status, body: await response.json() };
}

async function rawCall(name: string, argumentsValue?: unknown): Promise<{ status: number; body: any }> {
  const params: Record<string, unknown> = { name };
  if (argumentsValue !== undefined) params.arguments = argumentsValue;
  return rpc('tools/call', params);
}

function structured(result: unknown): any {
  const parsed = CallToolResultSchema.parse(result);
  expect(parsed.structuredContent).toBeDefined();
  return parsed.structuredContent;
}

beforeEach(async () => startService());
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  if (service) await service.close();
});

describe('fixture MCP service', () => {
  it('supports SDK initialize, list tools, calls, and validates declared schemas', async () => {
    const client = await connectClient();
    expect(client.getServerVersion()).toEqual({ name: 'marketplace', version: '0.1.0' });
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(['marketplace_search', 'marketplace_fetch', 'marketplace_status']);
    expect(tools.tools.map(({ description }) => description)).toEqual([
      'Search marketplace listings.',
      'Fetch one marketplace listing by ID or canonical URL. Does not fetch remote URLs.',
      'Report service and schema versions and the configured backend name.'
    ]);
    for (const tool of tools.tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe('object');
    }
    const searchSchema = tools.tools.find(({ name }) => name === 'marketplace_search')?.inputSchema;
    expect(searchSchema?.required).toEqual(expect.arrayContaining(['query', 'location']));
    const fetchSchema = tools.tools.find(({ name }) => name === 'marketplace_fetch')?.inputSchema;
    expect(fetchSchema?.oneOf).toHaveLength(2);
    expect(fetchSchema?.properties?.url).toMatchObject({ format: 'uri', maxLength: 2048, pattern: expect.any(String) });
    expect(searchSchema?.properties?.query?.pattern).toBe('\\S');
    const searchOutputSchema = tools.tools.find(({ name }) => name === 'marketplace_search')?.outputSchema;
    expect(searchOutputSchema?.anyOf?.[0]?.properties?.ok).toMatchObject({ const: true });
    expect(searchOutputSchema?.anyOf?.[1]?.properties?.ok).toMatchObject({ const: false });
    const serializedSearchOutputSchema = JSON.stringify(searchOutputSchema);
    expect(serializedSearchOutputSchema).toContain('"images"');
    expect(serializedSearchOutputSchema).not.toContain('"image_urls"');
    expect(serializedSearchOutputSchema).toContain('"posted_at"');
    expect(serializedSearchOutputSchema).toContain('"updated_at"');
    expect(serializedSearchOutputSchema).toContain('"seller"');
    const result = await client.callTool({ name: 'marketplace_search', arguments: { query: 'BIKE', location: 'portland' } });
    const output = structured(result);
    expect(output.backend).toBe('fixture');
    expect(output.listings.map((listing: { id: string }) => listing.id)).toEqual(['fixture-bike-001']);
    expect(z.toJSONSchema(z.object({ value: z.string() })).type).toBe('object');
  });

  it('exports ProviderError from the package entry for backend implementers', () => {
    expect(packageEntry.ProviderError).toBe(ProviderError);
  });

  it('returns status versions and fixture marker without invoking backend operations', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const backend: MarketplaceBackend = {
      name: 'status-only',
      search: vi.fn(() => []),
      fetch: vi.fn(() => null)
    };
    await startServiceWith(backend, { error: vi.fn() });
    const result = structured(await (await connectClient()).callTool({ name: 'marketplace_status', arguments: {} }));
    expect(result).toEqual({ ok: true, service_version: '0.1.0', schema_version: '1.0.0', backend: 'status-only' });
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it('uses the stable consumer listing contract and reports backend identity dynamically', async () => {
    const client = await connectClient();
    const search = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'synthetic', location: 'a', limit: 20 } }));
    expect(search.listings.length).toBeGreaterThan(0);
    for (const listing of search.listings) {
      expect(listing).toHaveProperty('images');
      expect(listing).not.toHaveProperty('image_urls');
      expect(listing).toHaveProperty('posted_at');
      expect(listing).toHaveProperty('updated_at');
      expect(listing).toHaveProperty('seller');
      expect(['active', 'sold', 'pending', 'removed', 'unknown']).toContain(listing.state);
    }
    const removed = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'sofa', location: 'eugene' } }));
    expect(removed.listings[0].state).toBe('removed');

    await Promise.allSettled(clients.splice(0).map((openClient) => openClient.close()));
    await service.close();
    const backend: MarketplaceBackend = {
      name: 'consumer-test',
      search: () => FIXTURE_LISTINGS.slice(0, 1),
      fetch: () => FIXTURE_LISTINGS[0] ?? null
    };
    await startServiceWith(backend, { error: vi.fn() });
    const customClient = await connectClient();
    const customSearch = structured(await customClient.callTool({ name: 'marketplace_search', arguments: { query: 'bike', location: 'portland' } }));
    const customFetch = structured(await customClient.callTool({ name: 'marketplace_fetch', arguments: { id: 'fixture-bike-001' } }));
    const customStatus = structured(await customClient.callTool({ name: 'marketplace_status', arguments: {} }));
    expect(customSearch.backend).toBe('consumer-test');
    expect(customFetch.backend).toBe('consumer-test');
    expect(customStatus.backend).toBe('consumer-test');
    expect(customStatus.schema_version).toBe('1.0.0');
  });

  it('searches case-insensitively by title, description, and location with deterministic filters', async () => {
    const client = await connectClient();
    const defaults = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'synthetic', location: 'portland' } }));
    expect(defaults.listings.map((listing: { id: string }) => listing.id)).toEqual(['fixture-bike-001', 'fixture-camera-003', 'fixture-lamp-004']);
    const matching = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'ROAD', location: 'portland', limit: 20 } }));
    expect(matching.listings.map((listing: { id: string }) => listing.id)).toEqual(['fixture-bike-001']);
    const nullExcluded = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'camera', location: 'portland', min_price: 0 } }));
    expect(nullExcluded.listings).toEqual([]);
    const descriptionMatch = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'synthetic fixture listing', location: 'seattle', limit: 2 } }));
    expect(descriptionMatch.listings.map((listing: { id: string }) => listing.id)).toEqual(['fixture-chair-002']);
    const crossBoundary = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'bike synthetic', location: 'portland' } }));
    expect(crossBoundary.listings).toEqual([]);
    const sameField = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'road bike', location: 'portland' } }));
    expect(sameField.listings.map((listing: { id: string }) => listing.id)).toEqual(['fixture-bike-001']);
  });

  it('fetches by ID and canonical URL without visiting remote URLs', async () => {
    const client = await connectClient();
    const networkFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('https://example.com')) throw new Error('Unexpected outbound URL fetch');
      return await originalFetch(input, init);
    });
    const byId = structured(await client.callTool({ name: 'marketplace_fetch', arguments: { id: 'fixture-bike-001' } }));
    expect(byId.backend).toBe('fixture');
    expect(byId.listing).toEqual(FIXTURE_LISTINGS[0]);
    const byUrl = structured(await client.callTool({ name: 'marketplace_fetch', arguments: { url: 'https://example.com/marketplace/listing/fixture-bike-001#photos' } }));
    expect(byUrl.listing.id).toBe('fixture-bike-001');
    expect(networkFetchSpy.mock.calls.filter(([input]) => String(input).startsWith('https://example.com'))).toHaveLength(0);
    networkFetchSpy.mockRestore();
    const missing = structured(await client.callTool({ name: 'marketplace_fetch', arguments: { id: 'fixture-missing' } }));
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'No listing matched the supplied identifier.' } });
    expect((await client.callTool({ name: 'marketplace_fetch', arguments: { id: 'fixture-missing' } })).isError).toBe(true);
  });

  it('rejects all Origin headers before dispatching a tool', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const backend: MarketplaceBackend = { name: 'test', search: vi.fn(() => []), fetch: vi.fn(() => null) };
    await startServiceWith(backend, { error: vi.fn() });

    for (const origin of ['https://evil.example', 'null']) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'marketplace_search', arguments: { query: 'bike', location: 'portland' } } })
      });
      expect(response.status).toBe(403);
      await response.text();
    }
    const originOnGet = await fetch(`${baseUrl}/mcp`, { headers: { origin: 'https://evil.example' } });
    expect(originOnGet.status).toBe(403);
    await originOnGet.text();
    expect(backend.search).not.toHaveBeenCalled();
  });

  it('serves a separate health endpoint and rejects other paths and methods', async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toEqual({ ok: true });
    const wrongMethod = await fetch(`${baseUrl}/healthz`, { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
    await wrongMethod.text();
    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    const wrongMcpMethod = await fetch(`${baseUrl}/mcp`);
    expect(wrongMcpMethod.status).toBe(405);
    expect(wrongMcpMethod.headers.get('allow')).toBe('POST');
    await wrongMcpMethod.text();
  });

  it('uses JSON-RPC InvalidParams for invalid and missing arguments, not tool error content', async () => {
    const invalidArguments: Array<[string, unknown]> = [
      ['marketplace_search', undefined],
      ['marketplace_search', []],
      ['marketplace_search', {}],
      ['marketplace_search', { query: '   ', location: 'portland' }],
      ['marketplace_search', { query: 'q', location: 'portland', extra: true }],
      ['marketplace_search', { query: 'q', location: 'portland', min_price: 5, max_price: 4 }],
      ['marketplace_search', { query: 'q', location: 'portland', min_price: -1 }],
      ['marketplace_search', { query: 'q', location: 'portland', limit: 1.5 }],
      ['marketplace_search', { query: 'q', location: 'portland', limit: 21 }],
      ['marketplace_search', { query: 'x'.repeat(257), location: 'portland' }],
      ['marketplace_search', { query: 'q', location: 'x'.repeat(257) }],
      ['marketplace_search', { query: 'q', location: '   ' }],
      ['marketplace_fetch', undefined],
      ['marketplace_fetch', {}],
      ['marketplace_fetch', { id: 'fixture-bike-001', url: 'https://example.com/marketplace/listing/fixture-bike-001' }],
      ['marketplace_fetch', { id: 'bad/id' }],
      ['marketplace_fetch', { url: 'data:text/plain;base64,SGVsbG8=' }],
      ['marketplace_fetch', { url: 'javascript:alert(1)' }],
      ['marketplace_fetch', { url: 'https://user:pass@example.com/listing' }],
      ['marketplace_fetch', { url: 'https://example.com', extra: true }],
      ['marketplace_fetch', { url: `https://example.com/${'x'.repeat(2040)}` }],
      ['marketplace_status', { extra: true }],
      ['marketplace_status', null]
    ];
    for (const [name, argumentsValue] of invalidArguments) {
      let response: { status: number; body: any };
      if (name === 'marketplace_status' && argumentsValue === null) {
        const raw = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name, arguments: argumentsValue } })
        });
        response = { status: raw.status, body: await raw.json() };
      } else {
        response = await rawCall(name, argumentsValue);
      }
      const { status, body } = response;
      expect(status, `${name} with ${JSON.stringify(argumentsValue)}`).toBe(200);
      expect(body.error?.code, `${name} with ${JSON.stringify(argumentsValue)}`).toBe(ErrorCode.InvalidParams);
      expect(body.result).toBeUndefined();
    }
  });

  it('answers a tools/call notification with primitive arguments with a prompt 202', async () => {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'marketplace_status', arguments: 'not-an-object' } })
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('answers a valid item in a batch even when another item has malformed arguments', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'marketplace_status', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'marketplace_status', arguments: 'not-an-object' } }
      ])
    });
    expect(response.status).toBe(200);
    const items = (await response.json()) as Array<{ id: number; result?: { structuredContent?: { backend?: string } }; error?: { code: number } }>;
    expect(items).toHaveLength(2);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(1)?.result?.structuredContent?.backend).toBe('fixture');
    // Batch items bypass the service pre-check; the SDK's protocol wrapper
    // reports structurally invalid items as InternalError, per item.
    expect(byId.get(2)?.error?.code).toBe(ErrorCode.InternalError);
  });

  it('accepts omitted status arguments and rejects malformed JSON and RPC envelopes separately', async () => {
    const status = await rawCall('marketplace_status', {});
    expect(status.body.result.structuredContent.backend).toBe('fixture');
    const omittedArguments = await rawCall('marketplace_status');
    expect(omittedArguments.body.result.structuredContent.backend).toBe('fixture');
    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{not json'
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
    const invalidRpc = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '1.0', method: 'tools/call', id: 3, params: { name: 'marketplace_status' } })
    });
    expect(invalidRpc.status).toBe(400);
    expect((await invalidRpc.json()).error.code).toBe(-32700);
  });

  it('bounds request bodies and enforces the MCP Accept header', async () => {
    const tooLarge = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ data: 'x'.repeat(70_000) })
    });
    expect(tooLarge.status).toBe(413);
    const unacceptable = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(unacceptable.status).toBe(406);
  });

  it('handles concurrent calls independently', async () => {
    const client = await connectClient();
    const [first, second, third] = await Promise.all([
      client.callTool({ name: 'marketplace_search', arguments: { query: 'chair', location: 'seattle' } }),
      client.callTool({ name: 'marketplace_fetch', arguments: { id: 'fixture-lamp-004' } }),
      client.callTool({ name: 'marketplace_status' })
    ]);
    expect(structured(first).listings[0].id).toBe('fixture-chair-002');
    expect(structured(second).listing.state).toBe('sold');
    expect(structured(third).schema_version).toBe('1.0.0');
  });

  it('bounds shutdown with both an in-flight backend call and a partial request body', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    let backendStarted!: () => void;
    let backendSignal!: AbortSignal;
    const logger = { error: vi.fn() };
    const started = new Promise<void>((resolve) => { backendStarted = resolve; });
    const backend: MarketplaceBackend = {
      name: 'test',
      search: (_input, signal) => {
        backendSignal = signal;
        backendStarted();
        return new Promise(() => {});
      },
      fetch: () => null
    };
    await startServiceWith(backend, logger);

    const partialReceived = new Promise<void>((resolve) => service.server.once('request', () => resolve()));
    const partial = httpRequest(new URL('/mcp', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': '100'
      }
    });
    partial.on('error', () => {});
    partial.flushHeaders();
    partial.write('{"jsonrpc":');
    await partialReceived;

    const inFlight = fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'marketplace_search', arguments: { query: 'bike', location: 'portland' } } })
    });
    void inFlight.catch(() => {});
    await started;

    let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        service.close(),
        new Promise<never>((_, reject) => {
          shutdownTimeout = setTimeout(() => reject(new Error('Service shutdown exceeded the test budget')), 2_000);
        })
      ]);
    } finally {
      if (shutdownTimeout) clearTimeout(shutdownTimeout);
      partial.destroy();
    }
    expect(service.address()).toBeNull();
    expect(backendSignal.aborted).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('sanitizes invalid backend listings into runtime envelopes', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const logger = { error: vi.fn() };
    const backend: MarketplaceBackend = {
      name: 'test',
      search: () => [{ ...FIXTURE_LISTINGS[0]!, url: 'data:text/plain;base64,SGVsbG8=' }],
      fetch: () => null
    };
    await startServiceWith(backend, logger);
    const result = await rawCall('marketplace_search', { query: 'fixture', location: 'portland' });
    expect(result.body.result.structuredContent).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'The backend could not complete the request.' } });
    expect(JSON.stringify(result.body)).not.toContain('data:text');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('returns typed provider failures with validated metadata through the SDK', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const failures = [
      new ProviderError('AUTH_EXPIRED', 'Authentication expired.'),
      new ProviderError('LOGIN_REQUIRED', 'Sign in before searching.', { action_required: 'login', login_url: 'https://example.com/login', retry_after: 30 }),
      new ProviderError('CAPTCHA_REQUIRED', 'Complete the challenge.'),
      new ProviderError('SESSION_INVALID', 'The session is invalid.'),
      new ProviderError('RATE_LIMITED', 'Retry later.', { retry_after: 0 }),
      new ProviderError('UPSTREAM_ERROR', 'The provider is unavailable.'),
      new ProviderError('TIMEOUT', 'The provider timed out.')
    ];
    let failureIndex = 0;
    const backend: MarketplaceBackend = {
      name: 'provider-demo',
      search: () => { throw failures[failureIndex++]!; },
      fetch: () => null
    };
    await startServiceWith(backend, { error: vi.fn() });
    const client = await connectClient();
    for (const failure of failures) {
      const result = structured(await client.callTool({ name: 'marketplace_search', arguments: { query: 'bike', location: 'portland' } }));
      expect(result.error.code).toBe(failure.code);
      if (failure.code === 'LOGIN_REQUIRED') {
        expect(result.error).toEqual({ code: 'LOGIN_REQUIRED', message: 'Sign in before searching.', action_required: 'login', login_url: 'https://example.com/login', retry_after: 30 });
      }
    }
  });

  it('sanitizes malformed and non-Error backend failures', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const logger = { error: vi.fn() };
    const backend: MarketplaceBackend = {
      name: 'provider-demo',
      search: () => { throw Object.assign(new ProviderError('RATE_LIMITED', 'Wait before retrying.'), { metadata: { retry_after: 1.5 } }); },
      fetch: () => { throw null; }
    };
    await startServiceWith(backend, logger);
    const invalidMetadata = await rawCall('marketplace_search', { query: 'bike', location: 'portland' });
    const nonError = await rawCall('marketplace_fetch', { id: 'fixture-bike-001' });
    expect(invalidMetadata.body.result.structuredContent.error.code).toBe('INTERNAL_ERROR');
    expect(nonError.body.result.structuredContent.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(invalidMetadata.body)).not.toContain('1.5');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('aborts timed-out backend work and returns the typed deadline error', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    let receivedSignal!: AbortSignal;
    let rejectLate!: (error: Error) => void;
    let backendStarted!: () => void;
    const started = new Promise<void>((resolve) => { backendStarted = resolve; });
    const backend: MarketplaceBackend = {
      name: 'slow-provider',
      search: (_input, signal) => {
        receivedSignal = signal;
        backendStarted();
        return new Promise((_resolve, reject) => { rejectLate = reject; });
      },
      fetch: () => null
    };
    await startServiceWith(backend, { error: vi.fn() }, 25);
    const call = rawCall('marketplace_search', { query: 'bike', location: 'portland' });
    await started;
    const result = await call;
    expect(receivedSignal.aborted).toBe(true);
    expect(result.body.result.structuredContent.error).toEqual({ code: 'TIMEOUT', message: 'The backend operation exceeded its deadline.' });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    rejectLate(new Error('late backend rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('aborts cooperative backend work when the MCP client disconnects', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    let receivedSignal!: AbortSignal;
    let backendStarted!: () => void;
    const logger = { error: vi.fn() };
    const started = new Promise<void>((resolve) => { backendStarted = resolve; });
    const backend: MarketplaceBackend = {
      name: 'slow-provider',
      search: (_input, signal) => {
        receivedSignal = signal;
        backendStarted();
        return new Promise(() => {});
      },
      fetch: () => null
    };
    await startServiceWith(backend, logger);
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const disconnectingClient = new Client({ name: 'marketplace-disconnect-test', version: '1.0.0' });
    await disconnectingClient.connect(transport);
    const call = disconnectingClient.callTool({ name: 'marketplace_search', arguments: { query: 'bike', location: 'portland' } });
    void call.catch(() => {});
    await started;
    await transport.close();
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(receivedSignal.aborted).toBe(true));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('clears the backend deadline timer when work succeeds', async () => {
    vi.useFakeTimers();
    try {
      await expect(runBackendOperation(() => 'done', 30_000, new AbortController().signal)).resolves.toBe('done');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start backend work when the MCP request signal is already aborted', async () => {
    const operation = vi.fn(() => 'unexpected');
    const controller = new AbortController();
    controller.abort(new Error('cancelled before execution'));
    await expect(runBackendOperation(operation, 30_000, controller.signal)).rejects.toThrow('cancelled before execution');
    expect(operation).not.toHaveBeenCalled();
  });

  it('validates backend timeout configuration strictly', () => {
    expect(parseBackendTimeout(undefined)).toBe(30_000);
    expect(() => parseBackendTimeout('')).toThrow();
    expect(() => parseBackendTimeout('0')).toThrow();
    expect(() => parseBackendTimeout('0.5')).toThrow();
    expect(() => parseBackendTimeout('60000')).toThrow();
    expect(() => parseBackendTimeout('30000')).not.toThrow();
    expect(() => createMarketplaceService({ backendTimeoutMs: 30_000 })).not.toThrow();
    expect(() => createMarketplaceService({ backendTimeoutMs: 0.5 })).toThrow();
    expect(() => createMarketplaceService({ backendTimeoutMs: 60_000 })).toThrow();
    const invalidBackend = { name: '   ', search: () => [], fetch: () => null } as MarketplaceBackend;
    expect(() => createMarketplaceService({ backend: invalidBackend })).toThrow();
  });

  it('sanitizes injected backend exceptions into runtime envelopes and logs server-side', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const logger = { error: vi.fn() };
    const backend: MarketplaceBackend = {
      name: 'test',
      search: () => { throw new Error('secret internal detail'); },
      fetch: () => { throw new Error('secret internal detail'); }
    };
    await startServiceWith(backend, logger);
    const result = await rawCall('marketplace_search', { query: 'fixture', location: 'portland' });
    expect(result.body.result.isError).toBe(true);
    expect(result.body.result.structuredContent).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'The backend could not complete the request.' } });
    expect(result.body.result.content[0].text).toBe(JSON.stringify(result.body.result.structuredContent));
    expect(JSON.stringify(result.body)).not.toContain('secret internal detail');
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

async function startServiceWith(backend: MarketplaceBackend, logger: Pick<Console, 'error'>, backendTimeoutMs?: number): Promise<void> {
  service = createMarketplaceService({ host: '127.0.0.1', port: 0, backend, logger, ...(backendTimeoutMs !== undefined ? { backendTimeoutMs } : {}) });
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}
