import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { FixtureBackend, type ConversationBackend, type MarketplaceBackend, type ShoppingBackend } from './backend.js';
import { FixtureShoppingBackend } from './fixtures.js';
import { EbayClient } from './ebay.js';
import { EbayShoppingBackend } from './ebay-backend.js';
import { FacebookMarketplaceBackend } from './facebook-marketplace-backend.js';
import { FacebookMessengerBackend } from './facebook-messenger-backend.js';
import type { FacebookMarket } from './facebook-marketplace-url.js';
import { backendNameSchema, SERVICE_VERSION } from './domain.js';
import { BrowserSessionManager } from './browser.js';
import { FacebookSessionProbe, toProviderSessionAssessment } from './facebook.js';
import {
  FACEBOOK_LOGIN_WAIT_DEFAULT_MS,
  FacebookCredentialLogin,
  facebookCredentialsFromEnv,
  type FacebookCredentials
} from './facebook-login.js';
import { registerMarketplaceTools } from './tools.js';
import { ReauthManager, ProcessReauthRuntime, REAUTH_LEASE_DEFAULT_MS, REAUTH_LEASE_MAX_MS, type ReauthRuntime } from './reauth.js';
import { createReauthAdminServer, type ReauthAdminServer } from './admin.js';

const MAX_REQUEST_BODY_SIZE = 64 * 1024;
const REAUTH_SHUTDOWN_TIMEOUT_MS = 10_000;
const BODY_ERROR = Symbol('body-error');
const HOST = parseHost(process.env.HOST);
const PORT = parsePort(process.env.PORT);
const BACKEND_TIMEOUT_MS = parseBackendTimeout(process.env.BACKEND_TIMEOUT_MS);
const REAUTH_ADMIN_PORT = parseConfiguredPort(process.env.REAUTH_ADMIN_PORT, 'REAUTH_ADMIN_PORT', 8787);
const REAUTH_VIEWER_PORT = parseConfiguredPort(process.env.REAUTH_VIEWER_PORT, 'REAUTH_VIEWER_PORT', 6080);
const REAUTH_LEASE_MS = parseReauthLease(process.env.REAUTH_LEASE_MS);

export interface ServiceOptions {
  backend?: MarketplaceBackend;
  backendKind?: 'fixture' | 'facebook';
  shoppingBackendKind?: 'fixture' | 'ebay';
  shopping?: ShoppingBackend;
  facebookMarkets?: readonly FacebookMarket[];
  host?: string;
  port?: number;
  logger?: Pick<Console, 'error'>;
  backendTimeoutMs?: number;
  browser?: BrowserSessionManager;
  browserProfileDir?: string;
  reauth?: ReauthManager;
  adminPort?: number;
  reauthLeaseMs?: number;
  reauthViewerPort?: number;
  /** Internal dependency/test seams; not environment variables or tool inputs. */
  reauthTargetUrl?: string;
  reauthRuntime?: ReauthRuntime;
  /** Internal dependency/test seam; not an environment variable or tool input. */
  facebookBaseUrl?: string;
  /** Internal dependency/test seam; not an environment variable or tool input. */
  facebookCredentials?: FacebookCredentials;
  facebookLoginWaitMs?: number;
  /** Internal dependency/test seams for the isolated Messenger surface. */
  messengerEnabled?: boolean;
  messengerProfileDir?: string;
  messengerBrowser?: BrowserSessionManager;
  messengerProbe?: FacebookSessionProbe;
  messengerBaseUrl?: string;
}

export interface MarketplaceService {
  readonly server: HttpServer;
  readonly host: string;
  readonly port: number;
  readonly browser: BrowserSessionManager;
  readonly facebook: FacebookSessionProbe;
  readonly reauth: ReauthManager;
  readonly admin: ReauthAdminServer;
  readonly messengerBrowser?: BrowserSessionManager;
  readonly messengerProbe?: FacebookSessionProbe;
  readonly shopping: ShoppingBackend;
  close(): Promise<void>;
  address(): ReturnType<HttpServer['address']>;
}

export function createMarketplaceService(options: ServiceOptions = {}): MarketplaceService {
  if (options.backend !== undefined && options.backendKind === 'facebook') {
    throw new TypeError('backend and backendKind cannot both select a backend');
  }
  if (options.facebookCredentials !== undefined &&
      (!options.facebookCredentials.username.trim() || !options.facebookCredentials.password.trim())) {
    throw new TypeError('FACEBOOK_USERNAME and FACEBOOK_PASSWORD must be set together');
  }
  const selectedBackendKind = options.backendKind ?? parseBackendKind(process.env.MARKETPLACE_BACKEND);
  const shoppingBackendKind = options.shoppingBackendKind ?? parseShoppingBackendKind(process.env.SHOPPING_BACKEND);
  if (options.shopping !== undefined && options.shoppingBackendKind !== undefined) {
    throw new TypeError('shopping and shoppingBackendKind cannot both select a backend');
  }
  const shopping = options.shopping ?? (shoppingBackendKind === 'ebay'
    ? new EbayShoppingBackend(new EbayClient({
      clientId: requiredEnv('EBAY_CLIENT_ID'),
      clientSecret: requiredEnv('EBAY_CLIENT_SECRET')
    }))
    : new FixtureShoppingBackend());
  const loginWaitMs = options.facebookLoginWaitMs ?? parseLoginWaitMs(process.env.FACEBOOK_LOGIN_WAIT_SECONDS);
  if (!Number.isSafeInteger(loginWaitMs) || loginWaitMs <= 0) {
    throw new RangeError('facebookLoginWaitMs must be a positive safe integer');
  }
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('port must be an integer between 0 and 65535');
  }
  if (!host.trim()) throw new Error('host must not be empty');
  const backendTimeoutMs = options.backendTimeoutMs ?? BACKEND_TIMEOUT_MS;
  if (!Number.isSafeInteger(backendTimeoutMs) || backendTimeoutMs <= 0 || backendTimeoutMs >= 60_000) {
    throw new RangeError('backendTimeoutMs must be a positive integer below 60000');
  }
  const logger = options.logger ?? console;
  const browser = options.browser ?? new BrowserSessionManager({
    ...(options.browserProfileDir !== undefined ? { profileDir: options.browserProfileDir } : {}),
    logger
  });
  const facebook = new FacebookSessionProbe({
    browser,
    ...(options.facebookBaseUrl !== undefined ? { baseUrl: options.facebookBaseUrl } : {}),
    logger
  });
  const messengerEnabled = options.messengerEnabled ?? parseMessengerEnabled(process.env.MARKETPLACE_MESSENGER);
  const messengerBrowser = selectedBackendKind === 'facebook' && messengerEnabled && options.backend === undefined
    ? (options.messengerBrowser ?? new BrowserSessionManager({
      profileDir: options.messengerProfileDir ?? process.env.MESSENGER_PROFILE_DIR ?? join(homedir(), '.marketplace', 'browser-profile-messenger'),
      logger
    }))
    : undefined;
  if (messengerBrowser !== undefined && messengerBrowser.profileDir === browser.profileDir) {
    // Session isolation is the point of the second scope: two scopes sharing one profile would
    // share cookies and one session assessment, so the conflict fails startup rather than the
    // first conversation call.
    throw new Error('The messenger scope must not share the marketplace browser profile directory; set MESSENGER_PROFILE_DIR (or messengerProfileDir) to a distinct path.');
  }
  const messengerProbe = messengerBrowser === undefined
    ? undefined
    : (options.messengerProbe ?? new FacebookSessionProbe({
      browser: messengerBrowser,
      surface: 'messenger',
      ...(options.messengerBaseUrl !== undefined ? { baseUrl: options.messengerBaseUrl } : options.facebookBaseUrl !== undefined ? { baseUrl: options.facebookBaseUrl } : {}),
      logger
    }));
  // Read here rather than at module load, and only when the Facebook backend can actually use it:
  // a fixture service has no business touching the secret, and must not fail on a half-configured
  // pair. A half-configured pair still fails loudly once the Facebook backend is selected.
  const credentials = selectedBackendKind === 'facebook' && options.backend === undefined
    ? (options.facebookCredentials ?? facebookCredentialsFromEnv(process.env))
    : undefined;
  const login = credentials === undefined
    ? undefined
    : new FacebookCredentialLogin({
      browser,
      username: credentials.username,
      password: credentials.password,
      ...(options.facebookBaseUrl !== undefined ? { baseUrl: options.facebookBaseUrl } : {}),
      waitMs: loginWaitMs,
      logger
    });
  const messengerLogin = credentials === undefined || messengerBrowser === undefined
    ? undefined
    : new FacebookCredentialLogin({
      browser: messengerBrowser,
      username: credentials.username,
      password: credentials.password,
      ...(options.messengerBaseUrl !== undefined
        ? { baseUrl: options.messengerBaseUrl }
        : options.facebookBaseUrl !== undefined ? { baseUrl: options.facebookBaseUrl } : {}),
      surface: 'messenger',
      waitMs: loginWaitMs,
      logger
    });
  const backend = options.backend ?? (selectedBackendKind === 'facebook'
    ? new FacebookMarketplaceBackend({
      browser,
      probe: facebook,
      ...(login !== undefined ? { login } : {}),
      ...(options.facebookMarkets !== undefined ? { markets: options.facebookMarkets } : {}),
      logger
    })
    : new FixtureBackend());
  const backendName = backendNameSchema.parse(backend.name);
  const conversations: ConversationBackend | undefined = messengerBrowser !== undefined && messengerProbe !== undefined
    ? new FacebookMessengerBackend({
      browser: messengerBrowser,
      probe: messengerProbe,
      ...(messengerLogin !== undefined ? { login: messengerLogin } : {}),
      logger
    })
    : options.backend === undefined && selectedBackendKind === 'facebook'
      ? undefined
      : isConversationBackend(backend) ? backend : undefined;
  const adminPort = options.adminPort ?? REAUTH_ADMIN_PORT;
  const viewerPort = options.reauthViewerPort ?? REAUTH_VIEWER_PORT;
  const leaseMs = options.reauthLeaseMs ?? REAUTH_LEASE_MS;
  validateServicePort(adminPort, 'adminPort');
  validateServicePort(viewerPort, 'reauthViewerPort');
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > REAUTH_LEASE_MAX_MS) {
    throw new RangeError(`reauthLeaseMs must be a positive safe integer no greater than ${REAUTH_LEASE_MAX_MS}`);
  }
  const reauth = options.reauth ?? new ReauthManager({
    browser,
    runtime: options.reauthRuntime ?? new ProcessReauthRuntime(),
    ...(options.reauthTargetUrl !== undefined ? { targetUrl: options.reauthTargetUrl } : {}),
    ...(viewerPort > 0 ? { viewerPort } : {}),
    leaseMs,
    logger: {
      error: (...args: Parameters<Console['error']>) => logger.error(...args),
      info: () => undefined
    }
  });
  const admin = createReauthAdminServer({ reauth, port: adminPort, logger });
  const active = new Set<{ mcp: Server; transport: StreamableHTTPServerTransport }>();
  let shuttingDown = false;
  const shutdownController = new AbortController();
  let closePromise: Promise<void> | undefined;

  const httpServer = createServer();
  httpServer.on('request', (request, response) => {
    const pathname = getPathname(request);
    if (pathname === '/mcp' && request.headers.origin !== undefined) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Origin headers are not allowed' }));
      request.resume();
      return;
    }
    if (pathname === '/mcp' && request.method === 'POST') {
      void handleMcpRequest(request, response);
    } else {
      void routeRequest(request, response);
    }
  });
  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 12_000;
  httpServer.keepAliveTimeout = 5_000;

  async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = getPathname(request);
    if (pathname === '/mcp') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Method not allowed' }));
      request.resume();
      return;
    }
    if (pathname === '/healthz') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Method not allowed' }));
        request.resume();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
    request.resume();
  }

  async function handleMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Create the connection synchronously, before any await, so the close()
    // snapshot can never miss an in-flight request while its body is still
    // being read. The unconditional 'close' cleanup below covers early exits.
    const mcp = new Server({ name: 'marketplace', version: SERVICE_VERSION }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE
    });
    const connection = { mcp, transport };
    active.add(connection);
    let finished = false;
    const cleanup = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      active.delete(connection);
      await Promise.allSettled([mcp.close(), transport.close()]);
    };
    response.once('close', () => void cleanup());

    const accept = request.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      response.writeHead(406, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Accept must include application/json and text/event-stream' }));
      request.resume();
      return;
    }
    if (shuttingDown) {
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Service shutting down' }));
      request.resume();
      return;
    }
    let body: unknown | typeof BODY_ERROR;
    try {
      body = await readBoundedBody(request, response);
    } catch (error) {
      if (!request.aborted && !response.destroyed) logger.error('Could not read MCP request body:', error);
      return;
    }
    if (body === BODY_ERROR) return;
    if (hasMalformedToolArguments(body)) {
      const requestId = getJsonRpcRequestId(body);
      if (requestId.present) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          id: requestId.value,
          error: { code: -32602, message: 'Tool arguments must be a JSON object' }
        }));
      } else {
        // A notification has no response slot; acknowledge it and drop it.
        response.writeHead(202).end();
      }
      return;
    }

    try {
      registerMarketplaceTools(mcp, backend, logger, {
        backendName,
        backendTimeoutMs,
        shutdownSignal: shutdownController.signal,
        sessionAssessment: () => toProviderSessionAssessment(browser.getInfo()),
        conversations,
        shopping
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
      if (response.writableEnded || response.destroyed) await cleanup();
      else response.once('finish', () => void cleanup());
    } catch (error) {
      logger.error('MCP request failed:', error);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Internal server error' }));
      }
      await cleanup();
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    shuttingDown = true;
    shutdownController.abort(new Error('Service shutting down'));
    closePromise = (async () => {
      if (backend instanceof FacebookMarketplaceBackend) await backend.close();
      if (conversations instanceof FacebookMessengerBackend) await conversations.close();
      await stopReauthBounded(reauth, logger);
      await admin.close().catch((error: unknown) => {
        try {
          logger.error('Reauth admin shutdown failed:', error instanceof Error ? error.name : 'UnknownError');
        } catch {
          // Continue the remaining service teardown if logging fails.
        }
      });
      const closing = new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) return resolve();
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      httpServer.closeAllConnections();
      await Promise.allSettled([...active].map(async ({ mcp, transport }) => {
        await Promise.allSettled([mcp.close(), transport.close()]);
      }));
      await closing;
      try {
        await browser.close();
      } finally {
        await messengerBrowser?.close();
      }
    })();
    return closePromise;
  };

  return {
    server: httpServer,
    host,
    port,
    browser,
    facebook,
    reauth,
    admin,
    ...(messengerBrowser !== undefined ? { messengerBrowser } : {}),
    ...(messengerProbe !== undefined ? { messengerProbe } : {}),
    shopping,
    address: () => httpServer.address(),
    close
  };
}

function isConversationBackend(backend: MarketplaceBackend): backend is MarketplaceBackend & ConversationBackend {
  return typeof (backend as Partial<ConversationBackend>).listThreads === 'function' &&
    typeof (backend as Partial<ConversationBackend>).readThread === 'function';
}

function parseHost(value: string | undefined): string {
  const host = value ?? '127.0.0.1';
  if (!host.trim() || host !== host.trim() || /\s/.test(host)) {
    throw new Error('HOST must be a non-empty hostname or IP address');
  }
  return host;
}

export function parseMessengerEnabled(value: string | undefined): boolean {
  return value === '1';
}

export function parseShoppingBackendKind(value: string | undefined): 'fixture' | 'ebay' {
  if (value === undefined || value === 'fixture') return 'fixture';
  if (value === 'ebay') return 'ebay';
  throw new RangeError('SHOPPING_BACKEND must be either "fixture" or "ebay"');
}

function requiredEnv(name: 'EBAY_CLIENT_ID' | 'EBAY_CLIENT_SECRET'): string {
  const value = process.env[name];
  if (!value) throw new RangeError(`${name} is required when SHOPPING_BACKEND=ebay`);
  return value;
}

export function parseBackendKind(value: string | undefined): 'fixture' | 'facebook' {
  if (value === undefined || value === 'fixture') return 'fixture';
  if (value === 'facebook') return 'facebook';
  throw new RangeError('MARKETPLACE_BACKEND must be either "fixture" or "facebook"');
}

export function parseBackendTimeout(value: string | undefined): number {
  if (value === undefined) return 30_000;
  if (!/^\d+$/.test(value)) throw new RangeError('BACKEND_TIMEOUT_MS must be a positive integer below 60000');
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout >= 60_000) {
    throw new RangeError('BACKEND_TIMEOUT_MS must be a positive integer below 60000');
  }
  return timeout;
}

export function parseLoginWaitMs(value: string | undefined): number {
  if (value === undefined) return FACEBOOK_LOGIN_WAIT_DEFAULT_MS;
  if (!/^\d+$/.test(value)) throw new RangeError('FACEBOOK_LOGIN_WAIT_SECONDS must be a positive integer');
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError('FACEBOOK_LOGIN_WAIT_SECONDS must be a positive integer');
  }
  return seconds * 1_000;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080;
  if (!/^\d+$/.test(value)) throw new RangeError('PORT must be an integer between 0 and 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new RangeError('PORT must be an integer between 0 and 65535');
  return port;
}

function parseConfiguredPort(value: string | undefined, name: string, defaultPort: number): number {
  if (value === undefined) return defaultPort;
  if (!/^\d+$/.test(value)) throw new RangeError(`${name} must be an integer between 0 and 65535`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new RangeError(`${name} must be an integer between 0 and 65535`);
  return port;
}

function parseReauthLease(value: string | undefined): number {
  if (value === undefined) return REAUTH_LEASE_DEFAULT_MS;
  if (!/^\d+$/.test(value)) throw new RangeError(`REAUTH_LEASE_MS must be a positive safe integer no greater than ${REAUTH_LEASE_MAX_MS}`);
  const leaseMs = Number(value);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > REAUTH_LEASE_MAX_MS) {
    throw new RangeError(`REAUTH_LEASE_MS must be a positive safe integer no greater than ${REAUTH_LEASE_MAX_MS}`);
  }
  return leaseMs;
}

function validateServicePort(port: number, name: string): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError(`${name} must be an integer between 0 and 65535`);
  }
}

function hasMalformedToolArguments(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('method' in body) || body.method !== 'tools/call') return false;
  if (!('params' in body) || typeof body.params !== 'object' || body.params === null || !('arguments' in body.params)) return false;
  const args = body.params.arguments;
  // Batch arrays bypass this pre-check; the SDK validates each item.
  if (args === undefined) return false;
  if (Array.isArray(args) || args === null) return true;
  return typeof args !== 'object';
}

function getJsonRpcRequestId(body: unknown): { present: boolean; value: unknown } {
  if (typeof body !== 'object' || body === null || !('id' in body)) return { present: false, value: undefined };
  return { present: true, value: body.id };
}

function getPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

async function readBoundedBody(request: IncomingMessage, response: ServerResponse): Promise<unknown | typeof BODY_ERROR> {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > MAX_REQUEST_BODY_SIZE) {
    response.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Request body too large' }));
    request.resume();
    return BODY_ERROR;
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    response.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    request.resume();
    return BODY_ERROR;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_SIZE) {
      response.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Request body too large' }));
      request.resume();
      return BODY_ERROR;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    }));
    return BODY_ERROR;
  }
}

export async function listen(service: MarketplaceService): Promise<void> {
  const results = await Promise.allSettled([
    listenServer(service.server, service.port, service.host),
    listenServer(service.admin.server, service.admin.port, service.admin.host)
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    await service.close().catch(() => undefined);
    throw failure.reason;
  }
}

export function installShutdownHandlers(service: MarketplaceService): void {
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    console.log(`Received ${signal}; shutting down Marketplace MCP.`);
    try {
      await service.close();
      process.exitCode = 0;
    } catch (error) {
      console.error('Marketplace MCP shutdown failed:', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

async function listenServer(server: HttpServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function stopReauthBounded(reauth: ReauthManager, logger: Pick<Console, 'error'>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      Promise.resolve().then(() => reauth.stop()).catch((error: unknown) => {
        try {
          logger.error('Reauth shutdown failed:', error instanceof Error ? error.name : 'UnknownError');
        } catch {
          // Shutdown remains best-effort if a custom logger fails.
        }
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, REAUTH_SHUTDOWN_TIMEOUT_MS);
      })
    ]);
  } catch {
    // Reauth shutdown must not prevent the remaining service teardown.
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    try {
      logger.error('Reauth shutdown exceeded its deadline');
    } catch {
      // Shutdown remains best-effort if a custom logger fails.
    }
  }
}
