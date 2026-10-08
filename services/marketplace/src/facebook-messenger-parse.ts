import {
  conversationMessageSchema,
  conversationThreadSchema,
  type ConversationMessage,
  type ConversationThread,
  type ProviderErrorCode
} from './domain.js';
import type { ExtractedInboxPage, ExtractedThreadPage } from './facebook-messenger-extract.js';
import { buildMessengerThreadUrl } from './facebook-messenger-url.js';

export type MessengerInboxPageKind = 'captcha' | 'checkpoint' | 'login' | 'threads' | 'empty' | 'unknown';
export type MessengerThreadPageKind = 'captcha' | 'checkpoint' | 'login' | 'messages' | 'unknown';

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
  limit: number;
}): MessengerInboxOutcome {
  const kind = classifyMessengerInboxPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Marketplace conversations.' };
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
  threadId: string;
}): MessengerThreadOutcome {
  const kind = classifyMessengerThreadPage(input.page);
  if (kind === 'captcha') return { kind: 'error', code: 'CAPTCHA_REQUIRED', message: 'Facebook requires a captcha challenge.' };
  if (kind === 'checkpoint') return { kind: 'error', code: 'SESSION_INVALID', message: 'The Facebook session requires a security check.' };
  if (kind === 'login') return { kind: 'error', code: 'LOGIN_REQUIRED', message: 'Facebook login is required to read Marketplace conversations.' };
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
