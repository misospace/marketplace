import { MAX_THREAD_ID_LENGTH, conversationThreadSchema } from './domain.js';

export const MESSENGER_INBOX_OPERATIONS = [
  'CometMarketplaceInboxBuyerTabViewContainerQuery',
  'CometMarketplaceInboxBuyerTabViewPaginationQuery'
] as const;

export interface MessengerInboxGraphQLObservation {
  recognized: boolean;
  malformed: boolean;
  empty: boolean;
  threadIds: string[];
}

type ParsedResponse =
  | { kind: 'unrelated' }
  | { kind: 'connection'; threadIds: string[]; empty: boolean; malformed: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMessengerInboxGraphQLResponse(payload: unknown): ParsedResponse {
  if (!isObject(payload) || !isObject(payload.data) || !isObject(payload.data.viewer)) {
    return { kind: 'unrelated' };
  }
  const viewer = payload.data.viewer;
  if (!Object.prototype.hasOwnProperty.call(viewer, 'marketplaceInboxBuyerMessageThreads')) {
    return { kind: 'unrelated' };
  }
  const connection = viewer.marketplaceInboxBuyerMessageThreads;
  if (!isObject(connection) || !Array.isArray(connection.edges)) {
    return { kind: 'connection', threadIds: [], empty: false, malformed: true };
  }
  if (connection.edges.length === 0) {
    return { kind: 'connection', threadIds: [], empty: true, malformed: false };
  }

  const threadIds: string[] = [];
  const seen = new Set<string>();
  let malformed = false;
  for (const edge of connection.edges) {
    if (!isObject(edge) || !isObject(edge.node)) {
      malformed = true;
      continue;
    }
    const node = edge.node;
    const threadKey = node.thread_key;
    const threadId = isObject(threadKey) ? threadKey.thread_fbid : undefined;
    if (
      node.__typename !== 'MessageThread' ||
      typeof threadId !== 'string' ||
      threadId.length < 1 ||
      threadId.length > MAX_THREAD_ID_LENGTH ||
      !conversationThreadSchema.safeParse({ thread_id: threadId }).success
    ) {
      malformed = true;
      continue;
    }
    if (typeof node.id === 'string' && !isConsistentThreadId(node.id, threadId)) {
      malformed = true;
      continue;
    }
    if (!seen.has(threadId)) {
      seen.add(threadId);
      threadIds.push(threadId);
    }
  }
  return { kind: 'connection', threadIds, empty: false, malformed };
}

/**
 * The verified GraphQL `id` is a Facebook global id that decodes to `message_thread:<thread_fbid>`.
 * Accept the literal form or its exact base64 encoding; anything else is an inconsistent key and is
 * skipped rather than attributed to a thread. Non-thread id shapes are left to `thread_key`.
 */
function isConsistentThreadId(id: string, threadId: string): boolean {
  const expected = `message_thread:${threadId}`;
  return id === expected || id === Buffer.from(expected).toString('base64');
}

export class MessengerInboxGraphQLCollector {
  private readonly maxThreads: number;
  private readonly maxResponses: number;
  private readonly threadIds: string[] = [];
  private readonly seen = new Set<string>();
  private recognized = false;
  private malformed = false;
  private empty = false;
  private recognizedResponses = 0;

  constructor(options: { maxThreads?: number; maxResponses?: number } = {}) {
    this.maxThreads = options.maxThreads ?? 20;
    this.maxResponses = options.maxResponses ?? 40;
  }

  observe(payload: unknown): void {
    try {
      if (this.recognizedResponses >= this.maxResponses) return;
      const parsed = parseMessengerInboxGraphQLResponse(payload);
      if (parsed.kind === 'unrelated') return;
      this.recognized = true;
      this.recognizedResponses += 1;
      this.malformed ||= parsed.malformed;
      this.empty ||= parsed.empty;
      for (const threadId of parsed.threadIds) {
        if (this.threadIds.length >= this.maxThreads) break;
        if (this.seen.has(threadId)) continue;
        this.seen.add(threadId);
        this.threadIds.push(threadId);
      }
    } catch {
      this.recognized = true;
      this.malformed = true;
    }
  }

  snapshot(): MessengerInboxGraphQLObservation {
    return {
      recognized: this.recognized,
      malformed: this.malformed,
      empty: this.empty && this.threadIds.length === 0,
      threadIds: [...this.threadIds]
    };
  }
}
