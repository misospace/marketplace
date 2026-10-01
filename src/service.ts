import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { MarketplaceBackend } from './backend.js';
import { FixtureBackend } from './backend.js';
import { backendNameSchema, SERVICE_VERSION } from './domain.js';
import { BrowserSessionManager } from './browser.js';
import { registerMarketplaceTools } from './tools.js';

const MAX_REQUEST_BODY_SIZE = 64 * 1024;
const BODY_ERROR = Symbol('body-error');
const HOST = parseHost(process.env.HOST);
const PORT = parsePort(process.env.PORT);
const BACKEND_TIMEOUT_MS = parseBackendTimeout(process.env.BACKEND_TIMEOUT_MS);

export interface ServiceOptions {
  backend?: MarketplaceBackend;
  host?: string;
  port?: number;
  logger?: Pick<Console, 'error'>;
  backendTimeoutMs?: number;
  browser?: BrowserSessionManager;
  browserProfileDir?: string;
}

export interface MarketplaceService {
  readonly server: HttpServer;
  readonly host: string;
  readonly port: number;
  readonly browser: BrowserSessionManager;
  close(): Promise<void>;
  address(): ReturnType<HttpServer['address']>;
}

export function createMarketplaceService(options: ServiceOptions = {}): MarketplaceService {
  const backend = options.backend ?? new FixtureBackend();
  const backendName = backendNameSchema.parse(backend.name);
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
      registerMarketplaceTools(mcp, backend, logger, { backendName, backendTimeoutMs, shutdownSignal: shutdownController.signal });
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
      const closing = new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) return resolve();
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      httpServer.closeAllConnections();
      await Promise.allSettled([...active].map(async ({ mcp, transport }) => {
        await Promise.allSettled([mcp.close(), transport.close()]);
      }));
      await closing;
      await browser.close();
    })();
    return closePromise;
  };

  return {
    server: httpServer,
    host,
    port,
    browser,
    address: () => httpServer.address(),
    close
  };
}

function parseHost(value: string | undefined): string {
  const host = value ?? '127.0.0.1';
  if (!host.trim() || host !== host.trim() || /\s/.test(host)) {
    throw new Error('HOST must be a non-empty hostname or IP address');
  }
  return host;
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

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080;
  if (!/^\d+$/.test(value)) throw new RangeError('PORT must be an integer between 0 and 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new RangeError('PORT must be an integer between 0 and 65535');
  return port;
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
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(service.port, service.host, () => {
      service.server.off('error', reject);
      resolve();
    });
  });
}
