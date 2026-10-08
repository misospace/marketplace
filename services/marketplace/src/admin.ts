import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { ReauthManager } from './reauth.js';

const MAX_BODY_SIZE = 4 * 1024;
const REAUTH_PATHS = new Set(['/reauth/start', '/reauth/stop', '/reauth/status']);

export interface ReauthAdminServer {
  readonly server: HttpServer;
  readonly host: '127.0.0.1';
  readonly port: number;
  close(): Promise<void>;
  address(): ReturnType<HttpServer['address']>;
}

export function createReauthAdminServer(options: {
  reauth: ReauthManager;
  port?: number;
  logger?: Pick<Console, 'error'>;
}): ReauthAdminServer {
  if (!options || typeof options !== 'object' || !(options.reauth instanceof ReauthManager)) {
    throw new TypeError('options.reauth must be a ReauthManager');
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('port must be an integer between 0 and 65535');
  }
  const logger = options.logger ?? console;
  const host = '127.0.0.1' as const;
  const server = createServer((request, response) => { void handleRequest(request, response); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;
  server.keepAliveTimeout = 5_000;
  let closePromise: Promise<void> | undefined;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== undefined || !isLoopbackHost(request.headers.host)) {
      request.resume();
      sendJson(response, 403, { error: 'Forbidden' });
      return;
    }
    const pathname = getPathname(request);
    if (!REAUTH_PATHS.has(pathname)) {
      request.resume();
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const allowedMethod = pathname === '/reauth/status' ? 'GET' : 'POST';
    if (request.method !== allowedMethod) {
      request.resume();
      sendJson(response, 405, { error: 'Method not allowed' }, { allow: allowedMethod });
      return;
    }

    let bodySize = 0;
    let tooLarge = Number(request.headers['content-length']) > MAX_BODY_SIZE;
    // Always settle body reads on end, error, abort, or close.
    const bodyComplete = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (complete: boolean): void => {
        if (settled) return;
        settled = true;
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onFailure);
        request.off('aborted', onFailure);
        request.off('close', onClose);
        resolve(complete);
      };
      const onData = (chunk: Buffer | string): void => {
        bodySize += Buffer.byteLength(chunk);
        if (bodySize > MAX_BODY_SIZE) tooLarge = true;
      };
      const onEnd = (): void => finish(true);
      const onFailure = (): void => finish(false);
      const onClose = (): void => finish(false);
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('error', onFailure);
      request.once('aborted', onFailure);
      request.once('close', onClose);
      request.resume();
    });
    if (!bodyComplete) {
      if (!response.destroyed && !response.writableEnded) sendJson(response, 400, { error: 'Incomplete request body' });
      return;
    }
    if (tooLarge) {
      sendJson(response, 413, { error: 'Request body too large' });
      return;
    }
    try {
      if (pathname === '/reauth/start') await options.reauth.start();
      else if (pathname === '/reauth/stop') await options.reauth.stop();
      sendJson(response, 200, options.reauth.status());
    } catch (error) {
      logger.error('Reauth admin request failed:', error instanceof Error ? error.name : 'UnknownError');
      sendJson(response, 500, { error: 'Reauth operation failed' });
    }
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closePromise;
  };

  return {
    server,
    host,
    port,
    close,
    address: () => server.address()
  };
}

function isLoopbackHost(header: string | undefined): boolean {
  if (!header || header !== header.trim() || header.includes(',')) return false;
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::(\d{1,5}))?$/i.exec(header);
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65_535);
}

function getPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}
