import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, errors } from 'playwright';
import type { Page } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError } from '../src/backend.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { threadsListInputSchema, threadReadInputSchema, threadSendInputSchema } from '../src/domain.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

const fixtureDir = new URL('./fixtures/facebook-messenger/', import.meta.url);
const fixtures = new Map([
  'inbox-normal.html', 'inbox-empty.html', 'inbox-login.html', 'inbox-checkpoint.html', 'inbox-layout-changed.html',
  'thread-normal.html', 'thread-layout-changed.html',
  'thread-composer.html', 'thread-no-composer.html', 'thread-two-composers.html'
].map((name) => [name, readFileSync(new URL(name, fixtureDir), 'utf8')]));

let server: Server;
let origin: string;
let inboxFixture = 'inbox-normal.html';
let threadFixture = 'thread-normal.html';
let hangInbox = false;
let hangThread = false;
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
    if (hangThread && /^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) return;
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
  hangThread = false;
  inboxRedirectTarget = undefined;
  threadRedirectTarget = undefined;
});

function configure(nextInbox = 'inbox-normal.html', nextThread = 'thread-normal.html', nextHangInbox = false, nextHangThread = false): void {
  inboxFixture = nextInbox;
  threadFixture = nextThread;
  hangInbox = nextHangInbox;
  hangThread = nextHangThread;
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
const sendInput = (overrides: Record<string, unknown> = {}) =>
  threadSendInputSchema.parse({
    thread_id: '1684432532',
    message: 'Is the blue desk still available?',
    idempotency_token: 'tok-abc123def456ghij',
    ...overrides
  });

// The serialized send task receives its page through the browser's runExclusive seam. Driving
// that seam with a controlled page rejects one page operation in isolation — the composer
// contract check (pre-Enter) or the Enter press (post-Enter) — without launching a real browser,
// so these cases run even when Chromium is unavailable.
function controlledMessengerPage(options: { composerCount: number; rejectPress?: unknown }): Record<string, unknown> {
  const url = 'http://127.0.0.1/messages/t/1684432532/';
  const threadPage = {
    url,
    signals: {
      hasPasswordInput: false, hasLoginForm: false, hasCheckpointForm: false, hasCaptchaFrame: false,
      hasMainLandmark: true, hasAuthenticatedMarker: true, hasLoginPrompt: false,
      mentionsCheckpoint: false, mentionsCaptcha: false
    },
    messages: [{ sender: 'other', senderName: 'Synthetic Seller', text: 'Hello' }]
  };
  return {
    goto: async () => undefined,
    evaluate: async (_fn: unknown, arg: unknown) => {
      const a = (arg ?? {}) as { selector?: unknown };
      return a.selector !== undefined ? { url, composerCount: options.composerCount } : threadPage;
    },
    locator: () => ({ focus: async () => undefined }),
    keyboard: {
      type: async () => undefined,
      press: async () => { if (options.rejectPress !== undefined) throw options.rejectPress; }
    }
  };
}

function driveSendWithPage(backend: FacebookMessengerBackend, page: Record<string, unknown>): void {
  const manager = backend['browser'];
  const implementation = (async (
    signal: AbortSignal,
    task: (page: Page, signal: AbortSignal) => Promise<never>
  ) => task(page as unknown as Page, signal)) as unknown as typeof manager['runExclusive'];
  vi.spyOn(manager, 'runExclusive').mockImplementation(implementation);
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

describe.skipIf(!browserAvailable)('Facebook Messenger backend send', () => {
  it('sends into the recognized composer and the typed text is observable on the page', async () => {
    configure(undefined, 'thread-composer.html');
    const backend = createBackend();
    await backend.sendThread(sendInput(), new AbortController().signal);
    // Re-navigate with the same persistent profile; the fixture mirrors the last sent text
    // into a hidden input from persistent storage. That hidden value is the page-side signal
    // that the typed text reached the page (no content is read out of the send itself).
    const manager = backend['browser'];
    const lastSent = await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${origin}/messages/t/1684432532/`, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => (document.getElementById('last-sent') as HTMLInputElement | null)?.value ?? '');
    });
    expect(lastSent).toBe('Is the blue desk still available? [tok-abc123def456ghij]');
  });

  it('fails closed with the composer error when no contract composer is present', async () => {
    configure(undefined, 'thread-no-composer.html');
    const backend = createBackend();
    await expectProviderError(
      backend.sendThread(sendInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger message composer was not recognized.'
    );
  });

  it('fails closed with the composer error when two composers make it ambiguous', async () => {
    configure(undefined, 'thread-two-composers.html');
    const backend = createBackend();
    await expectProviderError(
      backend.sendThread(sendInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger message composer was not recognized.'
    );
  });

  it('fails closed before typing when the thread page is not a recognized thread page', async () => {
    configure(undefined, 'thread-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(
      backend.sendThread(sendInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger thread could not be verified before sending.'
    );
  });

  it('maps a hanging thread navigation to TIMEOUT', async () => {
    configure(undefined, 'thread-composer.html', false, true);
    const backend = createBackend();
    await expectProviderError(backend.sendThread(sendInput(), new AbortController().signal), 'TIMEOUT');
  }, 10_000);

  it('rejects with the exact abort reason when aborted during a send', async () => {
    // The unknown layout keeps the pre-send settle loop running, giving the abort a reliable
    // window to land while the serialized browser operation is still in flight.
    configure(undefined, 'thread-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    const controller = new AbortController();
    const reason = new Error('cancel Messenger send');
    const operation = backend.sendThread(sendInput(), controller.signal);
    const deadline = Date.now() + 5_000;
    while (!requests.includes('/messages/t/1684432532/') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
  });
});

// These cases drive the send task through the runExclusive page-seam with a controlled page, so
// they need no real browser and run regardless of whether Chromium is available.
describe('Facebook Messenger backend send submit-triggered metadata', () => {
  it('tags a post-Enter failure with submit_triggered and maps its code to TIMEOUT', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    // A present composer carries the task through the focus/type steps to the Enter press, which
    // is rejected after submitTriggered has been set. The rejection is a Playwright timeout, so it
    // must map to TIMEOUT and carry submit_triggered (never reported as a clean unsent failure).
    driveSendWithPage(backend, controlledMessengerPage({
      composerCount: 1,
      rejectPress: new errors.TimeoutError('the Enter press failed after the submit was dispatched')
    }));
    const error = (await backend.sendThread(sendInput(), new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toBe('The Messenger send did not complete in time.');
    expect(error.metadata.submit_triggered).toBe(true);
  });

  it('does not tag a pre-Enter composer classification failure with submit_triggered', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    // An absent (count 0) composer rejects before any typing or Enter press, so the thrown error
    // is the original pre-Enter upstream error and must carry no submit_triggered metadata.
    driveSendWithPage(backend, controlledMessengerPage({ composerCount: 0 }));
    const error = (await backend.sendThread(sendInput(), new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('The Facebook Messenger message composer was not recognized.');
    expect(error.metadata).not.toHaveProperty('submit_triggered');
  });
});
