import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FIXTURE_LISTINGS, FIXTURE_OFFERS } from '../src/fixtures.js';
import type { MarketplaceBackend } from '../src/backend.js';
import { chromium } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError } from '../src/index.js';
import { facebookCredentialsFromEnv } from '../src/facebook-login.js';
import { createMarketplaceService, type MarketplaceService, parseBackendKind, parseBackendTimeout, parseEventsBackendKind, parseLoginWaitMs, parseMessengerEnabled, parseShoppingBackendKind } from '../src/service.js';
import * as packageEntry from '../src/index.js';
import { runBackendOperation } from '../src/tools.js';
import { threadsListInputSchema, threadReadInputSchema } from '../src/domain.js';
import { FakeReauthRuntime } from './helpers/fake-reauth-runtime.js';

const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version as string;

let service: MarketplaceService;
let baseUrl: string;
const originalFetch = globalThis.fetch;
const browserAvailable = existsSync(chromium.executablePath());
const clients: Client[] = [];
let reauthTargetUrl = 'https://www.facebook.com/marketplace/';
let syntheticReauthServer: ReturnType<typeof createHttpServer>;

beforeAll(async () => {
  syntheticReauthServer = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><body>fixture</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    syntheticReauthServer.once('error', reject);
    syntheticReauthServer.listen(0, '127.0.0.1', resolve);
  });
  const address = syntheticReauthServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected synthetic reauth TCP address');
  reauthTargetUrl = `http://127.0.0.1:${address.port}/marketplace`;
});

afterAll(async () => {
  if (!syntheticReauthServer?.listening) return;
  syntheticReauthServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => syntheticReauthServer.close((error) => error ? reject(error) : resolve()));
});

async function startService(backend?: MarketplaceBackend): Promise<void> {
  service = createMarketplaceService({ host: '127.0.0.1', port: 0, adminPort: 0, ...(backend ? { backend } : {}) });
  await packageEntry.listen(service);
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
  vi.unstubAllEnvs();
});

describe('fixture MCP service', () => {
  it('validates conversation inputs and applies the default thread limit', () => {
    expect(threadsListInputSchema.parse({})).toEqual({ limit: 10 });
    expect(threadsListInputSchema.parse({ limit: 20 })).toEqual({ limit: 20 });
    expect(threadsListInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(threadsListInputSchema.safeParse({ limit: 21 }).success).toBe(false);
    expect(threadReadInputSchema.safeParse({ thread_id: 'thread-1.ok_2' }).success).toBe(true);
    expect(threadReadInputSchema.safeParse({ thread_id: 'thread/1' }).success).toBe(false);
    expect(threadReadInputSchema.safeParse({ thread_id: 'éclair' }).success).toBe(false);
  });

  it.skipIf(!browserAvailable)('serves the reauth console endpoints end-to-end on loopback', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const profileDir = mkdtempSync(join(tmpdir(), 'marketplace-service-reauth-'));
    const runtime = new FakeReauthRuntime();
    await startServiceWith({ name: 'reauth-service', search: () => [], fetch: () => null }, { error: vi.fn() }, undefined, undefined, {
      browserProfileDir: join(profileDir, 'profile'),
      reauthRuntime: runtime,
      reauthAdminPort: 0,
      reauthViewerPort: 0,
      reauthTargetUrl
    });
    try {
      const adminAddress = service.admin.address();
      if (!adminAddress || typeof adminAddress === 'string') throw new Error('Expected admin TCP address');
      expect(service.admin.host).toBe('127.0.0.1');
      expect(adminAddress.address).toBe('127.0.0.1');
      const adminUrl = `http://127.0.0.1:${adminAddress.port}`;
      const statusResponse = await fetch(`${adminUrl}/reauth/status`);
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers.get('cache-control')).toBe('no-store');
      expect(await statusResponse.json()).toEqual({ phase: 'idle', lease: null, expiresAt: null, remainingMs: null });

      const startResponse = await fetch(`${adminUrl}/reauth/start`, { method: 'POST' });
      const started = await startResponse.json() as { phase: string; lease: { id: string; startedAt: string; expiresAt: string; consoleUrl: string; viewerPort: number }; expiresAt: string; remainingMs: number };
      expect(startResponse.status).toBe(200);
      expect(started).toMatchObject({
        phase: 'active',
        expiresAt: started.lease.expiresAt,
        remainingMs: expect.any(Number),
        lease: {
          id: expect.any(String),
          startedAt: expect.any(String),
          expiresAt: expect.any(String),
          consoleUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html\?/),
          viewerPort: expect.any(Number)
        }
      });
      const consoleUrl = new URL(started.lease.consoleUrl);
      expect(consoleUrl.hash).toMatch(/^#password=.+/);

      const stopResponse = await fetch(`${adminUrl}/reauth/stop`, { method: 'POST' });
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toEqual({ phase: 'idle', lease: null, expiresAt: null, remainingMs: null });
    } finally {
      await service.close();
      await runtime.stopAll();
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!browserAvailable)('bounds a stalled interactive context close during service shutdown', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const profileDir = mkdtempSync(join(tmpdir(), 'marketplace-service-reauth-stalled-close-'));
    const browserProfileDir = join(profileDir, 'profile');
    const logger = { error: vi.fn() };
    const browser = new BrowserSessionManager({ profileDir: browserProfileDir, settleTimeoutMs: 200, launchTimeoutMs: 5_000, logger });
    const runtime = new FakeReauthRuntime();
    await startServiceWith({ name: 'reauth-stalled-close', search: () => [], fetch: () => null }, logger, undefined, browser, {
      browserProfileDir,
      reauthRuntime: runtime,
      reauthAdminPort: 0,
      reauthViewerPort: 0,
      reauthTargetUrl
    });
    try {
      const firstLease = await service.reauth.start();
      const context = service.browser.interactiveContext();
      expect(context).toBeDefined();
      const owner = context?.browser();
      expect(owner).not.toBeNull();
      if (context) context.close = () => new Promise<void>(() => undefined);

      const startedAt = Date.now();
      await expectCompletesWithin(service.close(), 3_000);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(service.reauth.status()).toMatchObject({ phase: 'idle', lease: null });
      expect(service.browser.getInfo()).toMatchObject({ status: 'browser_unavailable', browserStarted: false });
      expect(service.browser.getInfo().interactive).not.toBe(true);
      expect(service.browser.interactiveContext()).toBeUndefined();
      expect(owner?.isConnected()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith('Interactive browser context did not close within the configured timeout');
      expect(runtime.children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);

      await expect(service.reauth.start()).rejects.toThrow('Browser session is closed');
      expect(service.reauth.status()).toMatchObject({ phase: 'idle', lease: null });
      expect(firstLease.id).toBeTruthy();

      const nextRuntime = new FakeReauthRuntime();
      await startServiceWith({ name: 'reauth-after-shutdown', search: () => [], fetch: () => null }, logger, undefined, undefined, {
        browserProfileDir,
        reauthRuntime: nextRuntime,
        reauthAdminPort: 0,
        reauthViewerPort: 0,
        reauthTargetUrl
      });
      const nextLease = await service.reauth.start();
      expect(nextLease.id).not.toBe(firstLease.id);
      expect(service.reauth.status()).toMatchObject({ phase: 'active', lease: { id: nextLease.id } });
      await service.reauth.stop();
      expect(service.reauth.status()).toMatchObject({ phase: 'idle', lease: null });
      await nextRuntime.stopAll();
    } finally {
      await service.close();
      await runtime.stopAll();
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 10_000);

  it.skipIf(!browserAvailable)('closes an active reauth lease and releases the profile during service shutdown', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const profileDir = mkdtempSync(join(tmpdir(), 'marketplace-service-reauth-close-'));
    const runtime = new FakeReauthRuntime();
    await startServiceWith({ name: 'reauth-close', search: () => [], fetch: () => null }, { error: vi.fn() }, undefined, undefined, {
      browserProfileDir: join(profileDir, 'profile'),
      reauthRuntime: runtime,
      reauthAdminPort: 0,
      reauthViewerPort: 0,
      reauthTargetUrl
    });
    try {
      await service.reauth.start();
      const pids = runtime.children.map(({ pid }) => pid);
      expect(pids.length).toBeGreaterThan(0);
      const interactiveContext = service.browser.interactiveContext();
      expect(interactiveContext).toBeDefined();
      await service.close();
      expect(service.reauth.status()).toMatchObject({ phase: 'idle', lease: null });
      expect(service.browser.interactiveContext()).toBeUndefined();
      expect(service.browser.getInfo()).toMatchObject({
        status: 'browser_unavailable',
        browserStarted: false,
        profileDir: join(profileDir, 'profile')
      });
      expect(interactiveContext?.isClosed()).toBe(true);
      expect(runtime.children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
      expect(pids.every((pid) => pid !== undefined && !isPidAlive(pid))).toBe(true);
    } finally {
      await service.close();
      await runtime.stopAll();
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!browserAvailable)('keeps the MCP session assessment unknown throughout and after reauth', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const profileDir = mkdtempSync(join(tmpdir(), 'marketplace-service-reauth-status-'));
    const runtime = new FakeReauthRuntime();
    await startServiceWith({ name: 'reauth-status', search: () => [], fetch: () => null }, { error: vi.fn() }, undefined, undefined, {
      browserProfileDir: join(profileDir, 'profile'),
      reauthRuntime: runtime,
      reauthAdminPort: 0,
      reauthViewerPort: 0,
      reauthTargetUrl
    });
    try {
      const client = await connectClient();
      await service.reauth.start();
      const activeStatus = structured(await client.callTool({ name: 'marketplace_status', arguments: {} }));
      expect(activeStatus.facebook_session.status).toBe('session_unknown');
      await service.reauth.stop();
      const stoppedStatus = structured(await client.callTool({ name: 'marketplace_status', arguments: {} }));
      expect(stoppedStatus.facebook_session.status).toBe('session_unknown');
    } finally {
      await service.close();
      await runtime.stopAll();
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it('fails listen and closes both listeners when the admin port is occupied', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const occupied = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Expected occupied TCP address');
    service = createMarketplaceService({ host: '127.0.0.1', port: 0, adminPort: address.port });
    try {
      await expect(packageEntry.listen(service)).rejects.toThrow();
      expect(service.server.listening).toBe(false);
      expect(service.admin.address()).toBeNull();
    } finally {
      await service.close();
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('supports SDK initialize, list tools, calls, and validates declared schemas', async () => {
    const client = await connectClient();
    expect(client.getServerVersion()).toEqual({ name: 'marketplace', version: packageVersion });
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      'marketplace_search', 'marketplace_fetch', 'marketplace_status', 'shopping_search', 'shopping_fetch', 'events_search', 'events_fetch', 'messenger_threads_list', 'messenger_thread_read'
    ]);
    expect(tools.tools.map(({ description }) => description)).toEqual([
      'Search marketplace listings.',
      'Fetch one marketplace listing by ID or canonical URL. Does not fetch remote URLs.',
      'Report service and schema versions, the configured backend name, and the Facebook session state.',
      'Search one configured shopping source for products with prices, availability, and provenance. Read-only.',
      'Fetch one product offer by canonical ID or URL from the configured shopping source. Read-only.',
      'Search one configured events source for read-only availability: on-sale status, date/time, price ranges, and venue. Read-only.',
      "Fetch one event's read-only availability by canonical ID or URL from the configured events source. Read-only.",
      'List recent seller conversation threads from the Facebook Marketplace inbox. Read-only.',
      'Read the messages of one marketplace conversation thread by ID. Read-only, but opening the thread marks it "Seen" for the other participant.'
    ]);
    for (const tool of tools.tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe('object');
    }
    const searchSchema = tools.tools.find(({ name }) => name === 'marketplace_search')?.inputSchema;
    expect(searchSchema?.required).toEqual(expect.arrayContaining(['query', 'location']));
    const searchQuerySchema = searchSchema?.properties?.query;
    expect(searchQuerySchema).toBeDefined();
    const fetchSchema = tools.tools.find(({ name }) => name === 'marketplace_fetch')?.inputSchema;
    expect(fetchSchema?.oneOf).toHaveLength(2);
    expect(fetchSchema?.properties?.url).toMatchObject({ format: 'uri', maxLength: 2048, pattern: expect.any(String) });
    expect(searchQuerySchema).toMatchObject({ pattern: '\\S' });
    const searchOutputSchema: unknown = tools.tools.find(({ name }) => name === 'marketplace_search')?.outputSchema;
    const anyOf = isRecord(searchOutputSchema) && Array.isArray(searchOutputSchema.anyOf) ? searchOutputSchema.anyOf : [];
    const successSchema = anyOf[0];
    const failureSchema = anyOf[1];
    const successProperties = isRecord(successSchema) ? successSchema.properties : undefined;
    const failureProperties = isRecord(failureSchema) ? failureSchema.properties : undefined;
    expect(successProperties).toBeDefined();
    expect(failureProperties).toBeDefined();
    expect(isRecord(successProperties) ? successProperties.ok : undefined).toMatchObject({ const: true });
    expect(isRecord(failureProperties) ? failureProperties.ok : undefined).toMatchObject({ const: false });
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
    const threads = structured(await client.callTool({ name: 'messenger_threads_list' }));
    expect(threads.backend).toBe('fixture');
    expect(threads.threads.map((thread: { thread_id: string }) => thread.thread_id)).toEqual(['t-synth-0001', 't-synth-0002', 't-synth-0003']);
    expect(threads.threads[0].item_id).toBe('fixture-bike-001');
    expect(structured(await client.callTool({ name: 'messenger_threads_list', arguments: { limit: 1 } })).threads)
      .toHaveLength(1);
    const thread = structured(await client.callTool({ name: 'messenger_thread_read', arguments: { thread_id: 't-synth-0001' } }));
    expect(thread.messages).toHaveLength(3);
    expect(thread.messages[0].sender).toBe('other');
    expect(structured(await client.callTool({ name: 'messenger_thread_read', arguments: { thread_id: 't-synth-missing' } }))).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'No conversation thread matched the supplied identifier.' }
    });
    const shopping = structured(await client.callTool({ name: 'shopping_search', arguments: { query: 'solar' } }));
    expect(shopping.backend).toBe('fixture');
    expect(shopping.offers.map((offer: { id: string }) => offer.id)).toEqual(['synth-solar-001', 'synth-panel-004']);
    expect(structured(await client.callTool({ name: 'shopping_fetch', arguments: { id: 'synth-meter-003' } })).offer)
      .toEqual(FIXTURE_OFFERS[2]);
    expect(structured(await client.callTool({ name: 'shopping_fetch', arguments: { url: 'https://www.example.com/ebay/item/synth-battery-002#details' } })).offer)
      .toEqual(FIXTURE_OFFERS[1]);
    expect(structured(await client.callTool({ name: 'marketplace_status', arguments: {} })).shopping_backend).toBe('fixture');
    expect(structured(await client.callTool({ name: 'marketplace_status', arguments: {} })).events_backend).toBe('fixture');
    expect(z.toJSONSchema(z.object({ value: z.string() })).type).toBe('object');
  });

  it('exports ProviderError from the package entry for backend implementers', () => {
    expect(packageEntry.ProviderError).toBe(ProviderError);
  });

  it('rejects a half-configured Facebook credential pair during service creation', () => {
    expect(() => createMarketplaceService({
      facebookCredentials: facebookCredentialsFromEnv({ FACEBOOK_USERNAME: 'operator' }),
      backendKind: 'facebook'
    })).toThrow(TypeError);
    expect(() => createMarketplaceService({
      facebookCredentials: { username: 'operator', password: '  ' },
      backendKind: 'facebook'
    })).toThrow(TypeError);
  });

  it('does not read Facebook credentials when the fixture backend is selected', async () => {
    // A half-configured pair must not break a fixture service: it never touches the secret.
    vi.stubEnv('FACEBOOK_USERNAME', 'operator');
    vi.stubEnv('FACEBOOK_PASSWORD', '');
    try {
      const fixture = createMarketplaceService({ host: '127.0.0.1', port: 0, adminPort: 0, backendKind: 'fixture' });
      await fixture.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('selects the Facebook backend when MARKETPLACE_BACKEND is set', async () => {
    vi.stubEnv('MARKETPLACE_BACKEND', 'fixture');
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    vi.stubEnv('MARKETPLACE_BACKEND', 'facebook');
    service = createMarketplaceService({ host: '127.0.0.1', port: 0, adminPort: 0 });
    await packageEntry.listen(service);
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const status = structured(await (await connectClient()).callTool({ name: 'marketplace_status', arguments: {} }));
    expect(status.backend).toBe('facebook');
    expect(service.browser.getInfo().browserStarted).toBe(false);
  });

  it('creates an isolated Messenger probe/profile only when enabled for Facebook', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const profileRoot = mkdtempSync(join(tmpdir(), 'marketplace-messenger-profile-'));
    try {
      service = createMarketplaceService({
        host: '127.0.0.1',
        port: 0,
        adminPort: 0,
        backendKind: 'facebook',
        messengerEnabled: true,
        messengerProfileDir: join(profileRoot, 'messenger'),
        facebookBaseUrl: 'http://127.0.0.1:3210'
      });
      expect(service.messengerBrowser).toBeDefined();
      expect(service.messengerBrowser).not.toBe(service.browser);
      expect(service.messengerBrowser?.profileDir).toBe(join(profileRoot, 'messenger'));
      expect(service.messengerProbe?.probeUrl).toBe('http://127.0.0.1:3210/messages/');
      expect(service.browser.profileDir).not.toBe(service.messengerBrowser?.profileDir);
    } finally {
      await service.close();
      rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  it('rejects a messenger profile directory that resolves to the marketplace profile', () => {
    const profileRoot = mkdtempSync(join(tmpdir(), 'marketplace-messenger-profile-'));
    try {
      const shared = join(profileRoot, 'shared');
      // Two scopes on one profile would share cookies and one session assessment, so the
      // conflict must fail startup — including when the same directory is spelled differently.
      expect(() => createMarketplaceService({
        backendKind: 'facebook',
        messengerEnabled: true,
        browserProfileDir: shared,
        messengerProfileDir: shared
      })).toThrow('The messenger scope must not share the marketplace browser profile directory');
      expect(() => createMarketplaceService({
        backendKind: 'facebook',
        messengerEnabled: true,
        browserProfileDir: shared,
        messengerProfileDir: `${shared}/.`
      })).toThrow('The messenger scope must not share the marketplace browser profile directory');
    } finally {
      rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  it('selects the fixture backend by default and supports explicit Facebook selection', async () => {
    expect(structured(await (await connectClient()).callTool({ name: 'marketplace_status', arguments: {} })).backend).toBe('fixture');
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    service = createMarketplaceService({ host: '127.0.0.1', port: 0, adminPort: 0, backendKind: 'facebook' });
    await packageEntry.listen(service);
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const status = structured(await (await connectClient()).callTool({ name: 'marketplace_status', arguments: {} }));
    expect(status.backend).toBe('facebook');
    expect(service.browser.getInfo().browserStarted).toBe(false);
  });

  it('rejects selecting an injected backend and Facebook together', () => {
    const backend: MarketplaceBackend = { name: 'injected', search: () => [], fetch: () => null };
    expect(() => createMarketplaceService({ backend, backendKind: 'facebook' }))
      .toThrow(new TypeError('backend and backendKind cannot both select a backend'));
  });

  it('parses FACEBOOK_LOGIN_WAIT_SECONDS as positive whole seconds', () => {
    expect(parseLoginWaitMs(undefined)).toBe(180_000);
    expect(() => createMarketplaceService({ facebookLoginWaitMs: 0 })).toThrow(RangeError);
    expect(parseLoginWaitMs('2')).toBe(2_000);
    for (const value of ['', '0', '1.5', '-1', '9007199254740992']) {
      expect(() => parseLoginWaitMs(value)).toThrow(RangeError);
    }
  });

  it('parses backend selection explicitly and defaults to fixture', () => {
    expect(parseBackendKind(undefined)).toBe('fixture');
    expect(parseBackendKind('fixture')).toBe('fixture');
    expect(parseBackendKind('facebook')).toBe('facebook');
    expect(() => parseBackendKind('other')).toThrow(new RangeError('MARKETPLACE_BACKEND must be either "fixture" or "facebook"'));
  });

  it('parses shopping backend selection and requires eBay credentials only when selected', () => {
    expect(parseShoppingBackendKind(undefined)).toBe('fixture');
    expect(parseShoppingBackendKind('ebay')).toBe('ebay');
    expect(() => parseShoppingBackendKind('other')).toThrow(RangeError);
    vi.stubEnv('SHOPPING_BACKEND', 'ebay');
    vi.stubEnv('EBAY_CLIENT_ID', '');
    vi.stubEnv('EBAY_CLIENT_SECRET', '');
    expect(() => createMarketplaceService()).toThrow(/EBAY_CLIENT_ID/);
  });

  it('parses events backend selection and requires a Ticketmaster key only when selected', () => {
    expect(parseEventsBackendKind(undefined)).toBe('fixture');
    expect(parseEventsBackendKind('ticketmaster')).toBe('ticketmaster');
    expect(() => parseEventsBackendKind('other')).toThrow(new RangeError('EVENTS_BACKEND must be either "fixture" or "ticketmaster"'));
    vi.stubEnv('EVENTS_BACKEND', 'ticketmaster');
    vi.stubEnv('TICKETMASTER_API_KEY', '');
    expect(() => createMarketplaceService()).toThrow(/TICKETMASTER_API_KEY/);
  });

  it('serves read-only event availability through the fixture backend', async () => {
    const client = await connectClient();
    const search = structured(await client.callTool({ name: 'events_search', arguments: { query: 'synthetic' } }));
    expect(search.backend).toBe('fixture');
    expect(search.events.length).toBeGreaterThan(0);
    for (const event of search.events) {
      expect(event.provider).toBe('ticketmaster');
      expect(['on_sale', 'off_sale', 'sold_out', 'cancelled', 'postponed', 'rescheduled', 'unknown']).toContain(event.status);
    }
    const filtered = structured(await client.callTool({ name: 'events_search', arguments: { query: 'orchestra', city: 'portland' } }));
    expect(filtered.events.map((event: { id: string }) => event.id)).toEqual(['synth-event-001']);
    const fetched = structured(await client.callTool({ name: 'events_fetch', arguments: { id: 'synth-event-001' } }));
    expect(fetched.event.name).toBe('SYNTHETIC Evening Orchestra');
    const missing = structured(await client.callTool({ name: 'events_fetch', arguments: { id: 'synth-event-missing' } }));
    expect(missing).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'No event matched the supplied identifier.' } });
  });

  it('enables Messenger only for MARKETPLACE_MESSENGER=1', () => {
    expect(parseMessengerEnabled(undefined)).toBe(false);
    expect(parseMessengerEnabled('1')).toBe(true);
    expect(parseMessengerEnabled('true')).toBe(false);
    expect(parseMessengerEnabled('0')).toBe(false);
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
    expect(result).toEqual({
      ok: true,
      service_version: packageVersion,
      schema_version: '1.1.0',
      backend: 'status-only',
      facebook_session: { status: 'session_unknown' },
      shopping_backend: 'fixture',
      events_backend: 'fixture'
    });
    expect(service.browser.getInfo().browserStarted).toBe(false);
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.fetch).not.toHaveBeenCalled();
  });

  it.skipIf(!browserAvailable)('reports the current Facebook session assessment in status', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const profileDir = mkdtempSync(join(tmpdir(), 'marketplace-service-browser-'));
    const browser = new BrowserSessionManager({ profileDir });

    try {
      await browser.runExclusive(new AbortController().signal, async (page) => {
        await page.goto('about:blank');
      });
      await startServiceWith({ name: 'session-test', search: () => [], fetch: () => null }, { error: vi.fn() }, undefined, browser);
      const client = await connectClient();

      expect(structured(await client.callTool({ name: 'marketplace_status', arguments: {} })).facebook_session.status)
        .toBe('session_unknown');
      service.browser.assessSession('session_usable');
      expect(structured(await client.callTool({ name: 'marketplace_status', arguments: {} })).facebook_session.status)
        .toBe('session_usable');
      service.browser.assessSession('session_needs_reauth');
      expect(structured(await client.callTool({ name: 'marketplace_status', arguments: {} })).facebook_session.status)
        .toBe('session_needs_reauth');
    } finally {
      await service.close();
      rmSync(profileDir, { recursive: true, force: true });
    }
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
    expect(customStatus.schema_version).toBe('1.1.0');
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
      ['marketplace_status', null],
      ['messenger_threads_list', { limit: 0 }],
      ['messenger_threads_list', { limit: 21 }],
      ['messenger_threads_list', { extra: true }],
      ['messenger_thread_read', undefined],
      ['messenger_thread_read', {}],
      ['messenger_thread_read', { thread_id: 'bad/id' }],
      ['messenger_thread_read', { thread_id: 'éclair' }],
      ['messenger_thread_read', { thread_id: 'x'.repeat(129) }],
      ['messenger_thread_read', { thread_id: 't-synth-0001', extra: true }],
      ['shopping_search', undefined],
      ['shopping_search', { query: 'solar', min_price: 5, max_price: 4 }],
      ['shopping_search', { query: 'solar', unexpected: true }],
      ['shopping_fetch', {}],
      ['shopping_fetch', { id: 'bad/id' }],
      ['shopping_fetch', { url: 'javascript:alert(1)' }]
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
    expect(structured(third).schema_version).toBe('1.1.0');
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

  it('returns typed not-configured Messenger failures without logging internal errors', async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await service.close();
    const logger = { error: vi.fn() };
    service = createMarketplaceService({
      host: '127.0.0.1',
      port: 0,
      adminPort: 0,
      backendKind: 'facebook',
      messengerEnabled: false,
      logger
    });
    await packageEntry.listen(service);
    const address = service.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const result = structured(await (await connectClient()).callTool({ name: 'messenger_threads_list' }));
    expect(result).toEqual({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'The messenger surface is not configured on this deployment.' } });
    expect(logger.error).not.toHaveBeenCalled();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function expectCompletesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not complete within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startServiceWith(
  backend: MarketplaceBackend,
  logger: Pick<Console, 'error'>,
  backendTimeoutMs?: number,
  browser?: BrowserSessionManager,
  reauthOptions: {
    browserProfileDir?: string;
    reauthRuntime?: FakeReauthRuntime;
    reauthAdminPort?: number;
    reauthViewerPort?: number;
    reauthTargetUrl?: string;
  } = {}
): Promise<void> {
  service = createMarketplaceService({
    host: '127.0.0.1',
    port: 0,
    adminPort: reauthOptions.reauthAdminPort ?? 0,
    backend,
    logger,
    ...(backendTimeoutMs !== undefined ? { backendTimeoutMs } : {}),
    ...(browser !== undefined ? { browser } : {}),
    ...(reauthOptions.browserProfileDir !== undefined ? { browserProfileDir: reauthOptions.browserProfileDir } : {}),
    ...(reauthOptions.reauthRuntime !== undefined ? { reauthRuntime: reauthOptions.reauthRuntime } : {}),
    ...(reauthOptions.reauthAdminPort !== undefined ? { adminPort: reauthOptions.reauthAdminPort } : {}),
    ...(reauthOptions.reauthViewerPort !== undefined ? { reauthViewerPort: reauthOptions.reauthViewerPort } : {}),
    ...(reauthOptions.reauthTargetUrl !== undefined ? { reauthTargetUrl: reauthOptions.reauthTargetUrl } : {})
  });
  await packageEntry.listen(service);
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}
