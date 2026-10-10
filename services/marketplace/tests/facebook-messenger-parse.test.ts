import { describe, expect, it } from 'vitest';
import {
  classifyMessengerInboxPage,
  classifyMessengerThreadPage,
  interpretMessengerInboxPage,
  interpretMessengerThreadPage
} from '../src/facebook-messenger-parse.js';
import type { ExtractedInboxPage, ExtractedThreadPage } from '../src/facebook-messenger-extract.js';

const authenticatedSignals = {
  hasPasswordInput: false,
  hasLoginForm: false,
  hasCheckpointForm: false,
  hasCaptchaFrame: false,
  hasMainLandmark: true,
  hasAuthenticatedMarker: true,
  hasLoginPrompt: false,
  mentionsCheckpoint: false,
  mentionsCaptcha: false
};

function inbox(overrides: Partial<ExtractedInboxPage> = {}): ExtractedInboxPage {
  return {
    url: 'https://www.facebook.com/marketplace/inbox/',
    signals: { ...authenticatedSignals },
    hasEmptyStateMarker: false,
    threads: [],
    ...overrides
  };
}

function thread(overrides: Partial<ExtractedThreadPage> = {}): ExtractedThreadPage {
  return {
    url: 'https://www.facebook.com/messages/t/1684432532/',
    signals: { ...authenticatedSignals },
    messages: [],
    ...overrides
  };
}

describe('Messenger page interpretation', () => {
  it('classifies inbox states with challenge precedence and distinguishes empty from unknown', () => {
    expect(classifyMessengerInboxPage(inbox({ threads: [{ threadId: 'abc' }] }))).toBe('threads');
    expect(classifyMessengerInboxPage(inbox({ hasEmptyStateMarker: true }))).toBe('empty');
    expect(classifyMessengerInboxPage(inbox())).toBe('unknown');
    expect(classifyMessengerInboxPage(inbox({ signals: { ...authenticatedSignals, hasLoginForm: true, hasCaptchaFrame: true } }))).toBe('captcha');
    expect(classifyMessengerInboxPage(inbox({ signals: { ...authenticatedSignals, hasCheckpointForm: true } }))).toBe('checkpoint');
    expect(classifyMessengerInboxPage(inbox({ signals: { ...authenticatedSignals, hasLoginPrompt: true } }))).toBe('login');
  });

  it('maps threads safely, includes optional fields, and applies the requested limit', () => {
    const page = inbox({ threads: [
      { threadId: '1684432532', preview: 'Synthetic preview', itemId: '123456789' },
      { threadId: '1684432533' }
    ] });
    expect(interpretMessengerInboxPage({ page, baseUrl: 'https://www.facebook.com', limit: 1, inboxPath: '/marketplace/inbox/' })).toEqual({
      kind: 'threads',
      threads: [{ thread_id: '1684432532', preview: 'Synthetic preview', item_id: '123456789' }]
    });
    expect(interpretMessengerInboxPage({ page: inbox({ hasEmptyStateMarker: true }), baseUrl: 'https://www.facebook.com', limit: 1, inboxPath: '/marketplace/inbox/' }))
      .toEqual({ kind: 'empty' });
    expect(interpretMessengerInboxPage({ page: inbox(), baseUrl: 'https://www.facebook.com', limit: 1, inboxPath: '/marketplace/inbox/' }))
      .toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox page layout was not recognized.' });
  });

  it('uses validated GraphQL ids before DOM anchors and fails closed on unusable recognized connections', () => {
    const page = inbox({ threads: [{ threadId: 'dom-id', preview: 'DOM preview' }] });
    expect(interpretMessengerInboxPage({
      page, baseUrl: 'https://www.facebook.com', inboxPath: '/marketplace/inbox/', limit: 1,
      graphql: { recognized: true, malformed: false, empty: false, threadIds: ['graphql-id'] }
    })).toEqual({ kind: 'threads', threads: [{ thread_id: 'graphql-id' }] });
    expect(interpretMessengerInboxPage({
      page, baseUrl: 'https://www.facebook.com', inboxPath: '/marketplace/inbox/', limit: 1,
      graphql: { recognized: true, malformed: true, empty: false, threadIds: [] }
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
    expect(interpretMessengerInboxPage({
      page: inbox(), baseUrl: 'https://www.facebook.com', inboxPath: '/marketplace/inbox/', limit: 1,
      graphql: { recognized: true, malformed: false, empty: true, threadIds: [] }
    })).toEqual({ kind: 'empty' });
    expect(interpretMessengerInboxPage({
      page: inbox(), baseUrl: 'https://www.facebook.com', inboxPath: '/marketplace/inbox/', limit: 1,
      graphql: { recognized: true, malformed: false, empty: false, threadIds: [] }
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR' });
    expect(interpretMessengerInboxPage({
      page, baseUrl: 'https://www.facebook.com', inboxPath: '/marketplace/inbox/', limit: 1,
      graphql: { recognized: false, malformed: false, empty: false, threadIds: [] }
    })).toEqual({ kind: 'threads', threads: [{ thread_id: 'dom-id', preview: 'DOM preview' }] });
  });

  it('classifies thread rows only on an authenticated main page and fails closed for zero rows', () => {
    expect(classifyMessengerThreadPage(thread({ messages: [{ sender: 'you', text: 'Hello' }] }))).toBe('messages');
    expect(classifyMessengerThreadPage(thread())).toBe('unknown');
    expect(classifyMessengerThreadPage(thread({ signals: { ...authenticatedSignals, hasLoginForm: true } }))).toBe('login');
  });

  it('maps message attribution and timestamps while omitting malformed rows', () => {
    const outcome = interpretMessengerThreadPage({
      page: thread({ messages: [
        { sender: 'other', senderName: 'Synthetic Seller', text: 'Hello', sentAt: '2026-09-14T10:30:00.000Z' },
        { sender: 'you', text: 'Thanks' },
        { text: 'Unattributed must not be mapped' },
        { sender: 'other', senderName: ' ', text: 'bad optional name' }
      ] }),
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    });
    expect(outcome).toEqual({ kind: 'messages', messages: [
      { sender: 'other', sender_name: 'Synthetic Seller', text: 'Hello', sent_at: '2026-09-14T10:30:00.000Z' },
      { sender: 'you', text: 'Thanks' },
      { sender: 'other', text: 'bad optional name' }
    ] });
    expect(interpretMessengerThreadPage({ page: thread(), baseUrl: 'https://www.facebook.com', threadId: '1684432532' })).toMatchObject({
      kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread page layout was not recognized.'
    });
  });

  it('does not trust content from a redirected address, but login still wins on a redirected login page', () => {
    const inboxElsewhere = inbox({ url: 'https://www.facebook.com/messages/' });
    expect(interpretMessengerInboxPage({ page: inboxElsewhere, baseUrl: 'https://www.facebook.com', inboxPath: '/marketplace/inbox/', limit: 1 }))
      .toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Marketplace inbox page was not reached at the expected address.' });
    // A redirect to a login page must still be reported as the login requirement it is.
    expect(interpretMessengerInboxPage({
      page: inbox({ url: 'https://www.facebook.com/login/', signals: { ...authenticatedSignals, hasLoginForm: true } }),
      baseUrl: 'https://www.facebook.com',
      inboxPath: '/marketplace/inbox/',
      limit: 1
    })).toMatchObject({ kind: 'error', code: 'LOGIN_REQUIRED' });
    // A stale thread id that Facebook redirects to another conversation is never attributed.
    const otherThread = thread({ url: 'https://www.facebook.com/messages/t/99999/' });
    expect(interpretMessengerThreadPage({
      page: otherThread,
      baseUrl: 'https://www.facebook.com',
      threadId: '1684432532'
    })).toMatchObject({ kind: 'error', code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger thread page was not reached at the requested thread.' });
  });
});
