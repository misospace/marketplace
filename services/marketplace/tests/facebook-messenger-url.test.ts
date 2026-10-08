import { describe, expect, it } from 'vitest';
import {
  buildMessengerInboxUrl,
  buildMessengerThreadUrl,
  extractMessengerThreadId,
  MESSENGER_INBOX_PATH
} from '../src/facebook-messenger-url.js';

describe('Facebook Messenger URL helpers', () => {
  it('builds canonical same-origin inbox and thread URLs', () => {
    expect(buildMessengerInboxUrl({ baseUrl: 'http://127.0.0.1:9010' })).toBe(`http://127.0.0.1:9010${MESSENGER_INBOX_PATH}`);
    expect(buildMessengerInboxUrl({ baseUrl: 'https://www.facebook.com', inboxPath: '/custom/inbox/' }))
      .toBe('https://www.facebook.com/custom/inbox/');
    expect(buildMessengerThreadUrl({ baseUrl: 'https://www.facebook.com', threadId: '1684432532' }))
      .toBe('https://www.facebook.com/messages/t/1684432532/');
  });

  it.each(['', 'x'.repeat(129), 'has/slash', 'caf\u00e9'])('rejects invalid thread ids: %s', (threadId) => {
    expect(() => buildMessengerThreadUrl({ baseUrl: 'https://www.facebook.com', threadId })).toThrow(TypeError);
  });

  it('rejects inbox paths that are not absolute paths or change origin', () => {
    expect(() => buildMessengerInboxUrl({ baseUrl: 'https://www.facebook.com', inboxPath: 'marketplace/inbox/' })).toThrow(TypeError);
    expect(() => buildMessengerInboxUrl({ baseUrl: 'https://www.facebook.com', inboxPath: '//evil.example/inbox' })).toThrow(TypeError);
  });

  it('extracts only valid opaque ids from absolute URLs or paths', () => {
    expect(extractMessengerThreadId('https://www.facebook.com/messages/t/abc-123._/')).toBe('abc-123._');
    expect(extractMessengerThreadId('/messages/t/1684432532/')).toBe('1684432532');
    expect(extractMessengerThreadId('/messages/t/')).toBeUndefined();
    expect(extractMessengerThreadId('/messages/t/bad%2Fid/')).toBeUndefined();
    expect(extractMessengerThreadId('/marketplace/item/123456789/')).toBeUndefined();
  });
});
