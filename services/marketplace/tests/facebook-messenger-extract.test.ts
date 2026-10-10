import { readFileSync, existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  extractMessengerInboxPage,
  extractMessengerThreadPage,
  MESSENGER_EXTRACT_LIMITS,
  classifyMessengerComposerCount
} from '../src/facebook-messenger-extract.js';
import { MESSENGER_THREAD_PATH } from '../src/facebook-messenger-url.js';
import { classifyMessengerInboxPage, classifyMessengerThreadPage } from '../src/facebook-messenger-parse.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

let browser: Browser;
let page: Page;

describe.skipIf(!browserAvailable)('Facebook Messenger page extraction', () => {
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.route('**/*', async (route) => {
      // Static synthetic markup only; no request is permitted to escape the local browser.
      await route.abort();
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('extracts synthetic inbox threads, previews, and a unique listing id', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/inbox-normal.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    expect(extracted.signals.hasMainLandmark).toBe(true);
    expect(extracted.signals.hasAuthenticatedMarker).toBe(true);
    expect(extracted.threads).toEqual([
      { threadId: '1684432532', preview: 'Synthetic Seller: Is the desk available?' },
      { threadId: '1684432533', preview: 'Sample Buyer: Thanks for the details.Listing details', itemId: '123456789' },
      { threadId: '1684432534', preview: 'Example Seller: Pickup works tomorrow.' }
    ]);
    expect(classifyMessengerInboxPage(extracted)).toBe('threads');
  });

  it('recognizes only an explicit empty state and leaves a changed layout unknown', async () => {
    const emptyHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-empty.html', import.meta.url), 'utf8');
    await page.setContent(emptyHtml, { waitUntil: 'domcontentloaded' });
    const empty = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    expect(empty.hasEmptyStateMarker).toBe(true);
    expect(classifyMessengerInboxPage(empty)).toBe('empty');

    const changedHtml = readFileSync(new URL('./fixtures/facebook-messenger/inbox-layout-changed.html', import.meta.url), 'utf8');
    await page.setContent(changedHtml, { waitUntil: 'domcontentloaded' });
    const changed = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: MESSENGER_EXTRACT_LIMITS
    });
    expect(changed.hasEmptyStateMarker).toBe(false);
    expect(classifyMessengerInboxPage(changed)).toBe('unknown');
  });

  it('extracts only attributed text messages, sender names, and bounded valid dates', async () => {
    const html = readFileSync(new URL('./fixtures/facebook-messenger/thread-normal.html', import.meta.url), 'utf8');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const extracted = await page.evaluate(extractMessengerThreadPage, { limits: MESSENGER_EXTRACT_LIMITS });
    expect(extracted.messages).toEqual([
      { sender: 'other', senderName: 'Synthetic Seller', text: 'Hello there.10:30', sentAt: '2026-09-14T10:30:00.000Z' },
      { sender: 'you', text: 'Is the desk available?' },
      { sender: 'other', senderName: 'Synthetic Seller', text: 'Yes, it is available.10:30', sentAt: '2026-09-14T10:30:00.000Z' },
      { sender: 'other', senderName: 'Example Buyer', text: 'Could I pick it up tomorrow?' }
    ]);
    expect(classifyMessengerThreadPage(extracted)).toBe('messages');
  });

  it('caps thread and message extraction to configured bounds', async () => {
    const inboxHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      Array.from({ length: 8 }, (_, index) => `<a href="/messages/t/${1000 + index}/">${'P'.repeat(50)}</a>`).join('') + '</main></body></html>';
    await page.setContent(inboxHtml, { waitUntil: 'domcontentloaded' });
    const inbox = await page.evaluate(extractMessengerInboxPage, {
      threadPath: MESSENGER_THREAD_PATH,
      limits: { ...MESSENGER_EXTRACT_LIMITS, maxThreads: 2, maxPreviewLength: 12 }
    });
    expect(inbox.threads).toHaveLength(2);
    expect(inbox.threads[0]?.preview).toHaveLength(12);

    const threadHtml = '<!doctype html><html><body><main><a href="/logout/">Log out</a>' +
      Array.from({ length: 8 }, (_, index) => `<div role="row" aria-label="Synthetic Seller said: ${index}">Message ${index}</div>`).join('') + '</main></body></html>';
    await page.setContent(threadHtml, { waitUntil: 'domcontentloaded' });
    const messages = await page.evaluate(extractMessengerThreadPage, {
      limits: { ...MESSENGER_EXTRACT_LIMITS, maxMessages: 3, maxMessagesScan: 5, maxTextLength: 9 }
    });
    expect(messages.messages).toHaveLength(3);
    expect(messages.messages[0]?.text).toBe('Message 0');
  });
});

// Non-browser unit test: verifies the pure composer decision contract (count ->
// present/absent/ambiguous) that the real sendThread applies on the Node side after the
// thin in-page count. No page or browser APIs are involved, so this runs locally without
// Chromium.
describe('classifyMessengerComposerCount (pure composer decision contract)', () => {
  it('reports absent when there are no contract composers', () => {
    expect(classifyMessengerComposerCount(0)).toBe('absent');
  });

  it('reports present when there is exactly one contract composer', () => {
    expect(classifyMessengerComposerCount(1)).toBe('present');
  });

  it('reports ambiguous when there are two or more contract composers (unsafe to target)', () => {
    expect(classifyMessengerComposerCount(2)).toBe('ambiguous');
    expect(classifyMessengerComposerCount(3)).toBe('ambiguous');
    expect(classifyMessengerComposerCount(10)).toBe('ambiguous');
  });

  it('treats a non-positive count as absent (defensive)', () => {
    expect(classifyMessengerComposerCount(-1)).toBe('absent');
  });

  it('is deterministic across repeated calls for the same count', () => {
    for (let count = 0; count <= 4; count++) {
      expect(classifyMessengerComposerCount(count)).toBe(classifyMessengerComposerCount(count));
    }
  });
});
