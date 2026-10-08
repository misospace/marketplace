import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError } from '../src/backend.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { threadsListInputSchema, threadReadInputSchema } from '../src/domain.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

const fixtureDir = new URL('./fixtures/facebook-messenger/', import.meta.url);
const fixtures = new Map([
  'inbox-normal.html', 'inbox-empty.html', 'inbox-login.html', 'inbox-checkpoint.html', 'inbox-layout-changed.html',
  'thread-normal.html', 'thread-layout-changed.html'
].map((name) => [name, readFileSync(new URL(name, fixtureDir), 'utf8')]));

let server: Server;
let origin: string;
let inboxFixture = 'inbox-normal.html';
let threadFixture = 'thread-normal.html';
let hangInbox = false;
let inboxRedirectTarget: string | undefined;
let threadRedirectTarget: string | undefined;
const requests: string[] = [];
const managers: BrowserSessionManager[] = [];
const profileDirs: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(request.url ?? pathname);
    if (hangInbox && pathname === '/marketplace/inbox/') return;
    // Redirect hooks simulate Facebook canonicalizing or moving an address; the redirect target
    // is served by the ordinary route table so only the URL assertion can tell the difference.
    if (inboxRedirectTarget && pathname === '/marketplace/inbox/') {
      response.writeHead(302, { location: inboxRedirectTarget });
      response.end();
      return;
    }
    if (threadRedirectTarget && pathname !== threadRedirectTarget && /^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) {
      response.writeHead(302, { location: threadRedirectTarget });
      response.end();
      return;
    }
    let name: string | undefined;
    if (pathname === '/marketplace/inbox/' || pathname === '/messages/') name = inboxFixture;
    else if (/^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) name = threadFixture;
    const html = name ? fixtures.get(name) : undefined;
    response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html ?? 'missing synthetic route');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
});

afterEach(async () => {
  expect(requests.every((request) => /^\/(?:messages\/|marketplace\/inbox\/|messages\/t\/[A-Za-z0-9._-]+\/)$/.test(request))).toBe(true);
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  requests.length = 0;
  inboxFixture = 'inbox-normal.html';
  threadFixture = 'thread-normal.html';
  hangInbox = false;
  inboxRedirectTarget = undefined;
  threadRedirectTarget = undefined;
});

function configure(nextInbox = 'inbox-normal.html', nextThread = 'thread-normal.html', nextHangInbox = false): void {
  inboxFixture = nextInbox;
  threadFixture = nextThread;
  hangInbox = nextHangInbox;
  requests.length = 0;
}

function createBackend(options: { settleTimeoutMs?: number; maxThreads?: number } = {}): FacebookMessengerBackend {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-messenger-test-'));
  profileDirs.push(parent);
  const browser = new BrowserSessionManager({
    profileDir: join(parent, 'profile'),
    launchArgs: ['--host-resolver-rules=MAP * 127.0.0.1', '--disable-background-networking'],
    launchTimeoutMs: 10_000,
    settleTimeoutMs: 1_000,
    logger: { error: () => undefined }
  });
  managers.push(browser);
  const probe = new FacebookSessionProbe({ browser, baseUrl: origin, surface: 'messenger', navigationTimeoutMs: 5_000, settleTimeoutMs: 100 });
  return new FacebookMessengerBackend({
    browser,
    probe,
    navigationTimeoutMs: 5_000,
    settleTimeoutMs: options.settleTimeoutMs ?? 50,
    ...(options.maxThreads !== undefined ? { maxThreads: options.maxThreads } : {}),
    logger: { error: () => undefined }
  });
}

const listInput = (overrides: Record<string, unknown> = {}) => threadsListInputSchema.parse({ limit: 10, ...overrides });
const readInput = (threadId = '1684432532') => threadReadInputSchema.parse({ thread_id: threadId });
function expectProviderError(promise: Promise<unknown>, code: ProviderError['code'], message?: string) {
  return expect(promise).rejects.toMatchObject({ name: 'ProviderError', code, ...(message ? { message } : {}) });
}

describe.skipIf(!browserAvailable)('Facebook Messenger backend', () => {
  it('lists threads from the isolated Messenger inbox and applies caller limits', async () => {
    configure();
    const backend = createBackend();
    const threads = await backend.listThreads(listInput({ limit: 2 }), new AbortController().signal);
    expect(backend.name).toBe('facebook');
    expect(threads).toEqual([
      { thread_id: '1684432532', preview: 'Synthetic Seller: Is the desk available?' },
      { thread_id: '1684432533', preview: 'Sample Buyer: Thanks for the details.Listing details', item_id: '123456789' }
    ]);
    expect(requests).toEqual(['/messages/', '/marketplace/inbox/']);
  });

  it('returns empty only for a recognized empty inbox', async () => {
    configure('inbox-empty.html');
    const backend = createBackend();
    await expect(backend.listThreads(listInput(), new AbortController().signal)).resolves.toEqual([]);
  });

  it('fails closed when the inbox layout changes', async () => {
    configure('inbox-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Marketplace inbox page layout was not recognized.'
    );
  });

  it('requires login when the Messenger probe sees a login form and no credentials are configured', async () => {
    configure('inbox-login.html');
    const backend = createBackend();
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'LOGIN_REQUIRED',
      'Facebook login is required to read Marketplace conversations.'
    );
    expect(requests).toEqual(['/messages/']);
  });

  it('uses the shared credential recovery path after a Messenger login probe', async () => {
    configure();
    const backend = createBackend();
    let probeCount = 0;
    vi.spyOn(backend['probe'], 'probeSession').mockImplementation(async () => {
      probeCount += 1;
      if (probeCount === 1) return { status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' };
      return { status: 'session_usable', outcome: 'messages_authenticated' };
    });
    const login = new FacebookCredentialLogin({ browser: backend['browser'], username: 'synthetic-user', password: 'synthetic-password' });
    const attempt = vi.spyOn(login, 'attempt').mockResolvedValue({ outcome: 'authenticated' });
    const credentialBackend = new FacebookMessengerBackend({
      browser: backend['browser'], probe: backend['probe'], login, logger: { error: () => undefined }
    });

    await expect(credentialBackend.listThreads(listInput({ limit: 1 }), new AbortController().signal)).resolves.toHaveLength(1);
    expect(probeCount).toBe(2);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reads attributed messages and echoes the requested thread id', async () => {
    configure();
    const backend = createBackend();
    const result = await backend.readThread(readInput(), new AbortController().signal);
    expect(result).toMatchObject({
      thread_id: '1684432532',
      messages: [
        { sender: 'other', sender_name: 'Synthetic Seller', text: 'Hello there.10:30' },
        { sender: 'you', text: 'Is the desk available?' },
        { sender: 'other', sender_name: 'Synthetic Seller', text: 'Yes, it is available.10:30' },
        { sender: 'other', sender_name: 'Example Buyer', text: 'Could I pick it up tomorrow?' }
      ]
    });
    expect(requests).toEqual(['/messages/', '/messages/t/1684432532/']);
  });

  it('fails closed for a thread page with no recognized message rows', async () => {
    configure('inbox-normal.html', 'thread-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(
      backend.readThread(readInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger thread page layout was not recognized.'
    );
  });

  it('honors cancellation promptly with the exact abort reason', async () => {
    configure();
    const backend = createBackend();
    const controller = new AbortController();
    const reason = new Error('cancel Messenger read');
    const operation = backend.listThreads(listInput(), controller.signal);
    const deadline = Date.now() + 5_000;
    while (!requests.includes('/marketplace/inbox/') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
  });

  it('maps a hanging inbox navigation to TIMEOUT', async () => {
    configure('inbox-normal.html', 'thread-normal.html', true);
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    await expectProviderError(backend.listThreads(listInput(), new AbortController().signal), 'TIMEOUT');
  }, 10_000);

  it('does not trust inbox content served from a redirected address', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    // The redirect target serves the same inbox content; only the final URL can tell the
    // difference, and trusting it would mean reading whatever page Facebook redirected to.
    inboxRedirectTarget = '/messages/';
    await expect(backend.listThreads(listInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Marketplace inbox page was not reached at the expected address.'
    });
    await backend.close();
  }, 15_000);

  it('does not return another conversation for a redirected thread id', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    threadRedirectTarget = '/messages/t/99999/';
    await expect(backend.readThread(readInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Messenger thread page was not reached at the requested thread.'
    });
    await backend.close();
  }, 15_000);

  it('validates constructor bounds', () => {
    const backend = createBackend();
    expect(backend.name).toBe('facebook');
    expect(() => new FacebookMessengerBackend({ browser: {} as BrowserSessionManager, probe: {} as FacebookSessionProbe })).toThrow(TypeError);
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), maxThreads: 0 })).toThrow(RangeError);
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), inboxPath: '//elsewhere.invalid/' })).toThrow(TypeError);
  });
});
