import {
  conversationMessageSchema,
  conversationThreadSchema,
  type ConversationMessage,
  type ConversationThread,
  type ProviderErrorCode
} from './domain.js';
import type { ExtractedInboxPage, ExtractedThreadPage } from './facebook-messenger-extract.js';
import { buildMessengerThreadUrl } from './facebook-messenger-url.js';
import type { MessengerInboxGraphQLObservation } from './facebook-messenger-inbox-graphql.js';

export type MessengerInboxPageKind = 'captcha' | 'checkpoint' | 'login' | 'threads' | 'empty' | 'unknown';
export type MessengerThreadPageKind = 'captcha' | 'checkpoint' | 'login' | 'messages' | 'unknown';

function isExpectedPathname(url: string, baseUrl: string, expectedPathname: (pathname: string) => boolean): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(baseUrl).origin && expectedPathname(parsed.pathname);
  } catch {
    return false;
  }
}

export function classifyMessengerInboxPage(page: ExtractedInboxPage): MessengerInboxPageKind {
  if (page.signals.hasCaptchaFrame || page.signals.mentionsCaptcha) return 'captcha';
  if (page.signals.hasCheckpointForm || page.signals.mentionsCheckpoint) return 'checkpoint';
  if (page.signals.hasPasswordInput || page.signals.hasLoginForm || page.signals.hasLoginPrompt) return 'login';
  if (page.signals.hasMainLandmark && page.signals.hasAuthenticatedMarker && page.threads.length > 0) return 'threads';
  if (page.signals.hasMainLandmark && page.signals.hasAuthenticatedMarker && page.hasEmptyStateMarker && page.threads.length === 0) return 'empty';
  return 'unknown';
}

export type MessengerInboxOutcome =
  | { kind: 'threads'; threads: ConversationThread[] }
  | { kind: 'empty' }
  | { kind: 'error'; code: ProviderErrorCode; message: string };

export function interpretMessengerInboxPage(input: {
  page: ExtractedInboxPage;
  baseUrl: string;
  inboxPath: string;
  limit: number;
  graphql?: MessengerInboxGraphQLObservation;
}): MessengerInboxOutcome {
  const kind = classifyMessengerInboxPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Marketplace conversations.' };
  // Navigation follows redirects, so the page that rendered may not be the page that was asked
  // for. Content is only trusted from the configured inbox address; anything else is a typed
  // error rather than data attributed to the inbox.
  const inboxPrefix = input.inboxPath.endsWith('/') ? input.inboxPath.slice(0, -1) : input.inboxPath;
  const atInbox = isExpectedPathname(input.page.url, input.baseUrl, (pathname) => pathname === inboxPrefix || pathname.startsWith(`${inboxPrefix}/`));
  if (!atInbox) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox page was not reached at the expected address.' };
  const graphql = input.graphql;
  if (graphql && graphql.threadIds.length > 0) {
    const threads: ConversationThread[] = [];
    for (const threadId of graphql.threadIds.slice(0, input.limit)) {
      const parsed = conversationThreadSchema.safeParse({ thread_id: threadId });
      if (parsed.success) threads.push(parsed.data);
    }
    if (threads.length > 0) return { kind: 'threads', threads };
  }
  if (graphql?.malformed) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox threads could not be parsed.' };
  if (graphql?.empty) return { kind: 'empty' };
  if (graphql?.recognized) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox threads could not be parsed.' };
  // Without a verified GraphQL connection the DOM anchors are the only remaining signal, and they
  // are trusted only when the page is a recognized authenticated inbox (never on an unknown layout).
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox page layout was not recognized.' };
  if (kind === 'empty') return { kind: 'empty' };

  const threads: ConversationThread[] = [];
  for (const extracted of input.page.threads.slice(0, input.limit)) {
    try {
      // Rebuild against the configured origin; extracted page links never become navigation targets.
      buildMessengerThreadUrl({ baseUrl: input.baseUrl, threadId: extracted.threadId });
    } catch {
      continue;
    }
    const candidate = {
      thread_id: extracted.threadId,
      ...(extracted.preview ? { preview: extracted.preview } : {}),
      ...(extracted.itemId ? { item_id: extracted.itemId } : {})
    };
    const parsed = conversationThreadSchema.safeParse(candidate);
    if (parsed.success) threads.push(parsed.data);
  }
  if (threads.length === 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox threads could not be parsed.' };
  }
  return { kind: 'threads', threads };
}

export function classifyMessengerThreadPage(page: ExtractedThreadPage): MessengerThreadPageKind {
  if (page.signals.hasCaptchaFrame || page.signals.mentionsCaptcha) return 'captcha';
  if (page.signals.hasCheckpointForm || page.signals.mentionsCheckpoint) return 'checkpoint';
  if (page.signals.hasPasswordInput || page.signals.hasLoginForm || page.signals.hasLoginPrompt) return 'login';
  if (page.signals.hasMainLandmark && page.signals.hasAuthenticatedMarker && page.messages.length > 0) return 'messages';
  return 'unknown';
}

export type MessengerThreadOutcome =
  | { kind: 'messages'; messages: ConversationMessage[] }
  | { kind: 'error'; code: ProviderErrorCode; message: string };

export function interpretMessengerThreadPage(input: {
  page: ExtractedThreadPage;
  baseUrl: string;
  threadId: string;
}): MessengerThreadOutcome {
  const kind = classifyMessengerThreadPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Marketplace conversations.' };
  // A stale or redirected thread id can land on a different conversation. Messages are only
  // trusted from the requested thread's own address; anything else is a typed error, never
  // content attributed to the requested thread.
  const threadPrefix = `/messages/t/${input.threadId}/`;
  const atThread = isExpectedPathname(input.page.url, input.baseUrl, (pathname) => {
    const withoutTrailingSlash = threadPrefix.slice(0, -1);
    return pathname === withoutTrailingSlash || pathname.startsWith(threadPrefix);
  });
  if (!atThread) return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread page was not reached at the requested thread.' };
  if (kind === 'unknown') return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread page layout was not recognized.' };

  const messages: ConversationMessage[] = [];
  for (const extracted of input.page.messages) {
    if (!extracted.sender) continue;
    const senderName = extracted.senderName?.trim();
    const candidate = {
      sender: extracted.sender,
      ...(senderName ? { sender_name: senderName } : {}),
      text: extracted.text,
      ...(extracted.sentAt ? { sent_at: extracted.sentAt } : {})
    };
    const parsed = conversationMessageSchema.safeParse(candidate);
    if (parsed.success) messages.push(parsed.data);
  }
  if (messages.length === 0) {
    return { kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread messages could not be parsed.' };
  }
  return { kind: 'messages', messages };
}
