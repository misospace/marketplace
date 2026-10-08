import { MAX_THREAD_ID_LENGTH } from './domain.js';
import { assertFacebookOrigin } from './facebook.js';

export const MESSENGER_THREAD_PATH = '/messages/t/';
export const MESSENGER_INBOX_PATH = '/marketplace/inbox/';

// Keep in sync with the thread id expression used by domain.ts.
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface MessengerInboxUrlInput {
  baseUrl: string;
  inboxPath?: string;
}

export interface MessengerThreadUrlInput {
  baseUrl: string;
  threadId: string;
}

export function buildMessengerInboxUrl(input: MessengerInboxUrlInput): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Inbox URL input is required');
  }
  const baseUrl = assertFacebookOrigin(input.baseUrl);
  const base = new URL(baseUrl);
  const inboxPath = input.inboxPath ?? MESSENGER_INBOX_PATH;
  if (typeof inboxPath !== 'string' || !inboxPath.startsWith('/')) {
    throw new TypeError('inboxPath must start with /');
  }
  const url = new URL(inboxPath, base.origin);
  url.search = '';
  url.hash = '';
  if (url.origin !== base.origin) throw new TypeError('inboxPath must resolve to the same origin as baseUrl');
  return url.href;
}

export function buildMessengerThreadUrl(input: MessengerThreadUrlInput): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Thread URL input is required');
  }
  if (typeof input.threadId !== 'string' || input.threadId.length > MAX_THREAD_ID_LENGTH || !THREAD_ID_PATTERN.test(input.threadId)) {
    throw new TypeError('Messenger thread id is invalid');
  }
  const baseUrl = assertFacebookOrigin(input.baseUrl);
  const base = new URL(baseUrl);
  return new URL(`${MESSENGER_THREAD_PATH}${input.threadId}/`, base.origin).href;
}

/** Parses the thread segment only; callers that know the expected origin must check it separately. */
export function extractMessengerThreadId(href: string): string | undefined {
  if (typeof href !== 'string' || !href) return undefined;
  let pathname: string;
  try {
    pathname = new URL(href, 'https://www.facebook.com').pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith(MESSENGER_THREAD_PATH)) return undefined;
  const threadId = pathname.slice(MESSENGER_THREAD_PATH.length).split('/')[0];
  if (!threadId || threadId.length > MAX_THREAD_ID_LENGTH || !THREAD_ID_PATTERN.test(threadId)) return undefined;
  return threadId;
}
