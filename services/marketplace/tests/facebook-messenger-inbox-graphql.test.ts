import { describe, expect, it } from 'vitest';
import { MessengerInboxGraphQLCollector, parseMessengerInboxGraphQLResponse } from '../src/facebook-messenger-inbox-graphql.js';

function response(edges: unknown[]) {
  return { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges } } } };
}
function edge(threadId: unknown, extra: Record<string, unknown> = {}) {
  return { node: { __typename: 'MessageThread', thread_key: { thread_fbid: threadId }, ...extra } };
}

describe('Messenger inbox GraphQL response parsing', () => {
  it('parses valid connections, deduplicates ids, and accepts literal and base64 thread ids', () => {
    const base64Id = Buffer.from('message_thread:abc').toString('base64');
    expect(parseMessengerInboxGraphQLResponse(response([edge('abc'), edge('abc', { id: 'message_thread:abc' }), edge('abc', { id: base64Id })]))).toEqual({
      kind: 'connection', threadIds: ['abc'], empty: false, malformed: false
    });
  });

  it('recognizes a well-formed empty connection', () => {
    expect(parseMessengerInboxGraphQLResponse(response([]))).toEqual({ kind: 'connection', threadIds: [], empty: true, malformed: false });
  });

  it('marks invalid thread keys and inconsistent ids malformed without returning them', () => {
    const mismatchedBase64 = Buffer.from('message_thread:other').toString('base64');
    for (const item of [
      edge('not numeric?'),
      edge('valid', { id: 'message_thread:other' }),
      edge('valid', { id: mismatchedBase64 }),
      edge('valid', { id: 'message_thread:valid:extra' }),
      edge(123)
    ]) {
      expect(parseMessengerInboxGraphQLResponse(response([item]))).toMatchObject({ kind: 'connection', threadIds: [], malformed: true });
    }
  });

  it('ignores unrelated payloads and marks malformed connections', () => {
    expect(parseMessengerInboxGraphQLResponse(null)).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLResponse({ data: { viewer: {} } })).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLResponse({ data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: null } } } }))
      .toMatchObject({ kind: 'connection', malformed: true });
    expect(parseMessengerInboxGraphQLResponse(response([null, { node: null }]))).toMatchObject({ kind: 'connection', malformed: true });
  });

  it('bounds ids and tolerates hostile inputs in observe', () => {
    const collector = new MessengerInboxGraphQLCollector({ maxThreads: 1 });
    expect(() => {
      collector.observe(response([edge('first'), edge('second')]));
      collector.observe(Object.create(null));
      collector.observe(new Proxy({}, { get: () => { throw new Error('hostile'); } }));
    }).not.toThrow();
    expect(collector.snapshot()).toEqual({ recognized: true, malformed: true, empty: false, threadIds: ['first'] });
  });
});
