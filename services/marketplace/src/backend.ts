import { z } from 'zod';
import {
  fetchInputSchema,
  threadsListInputSchema,
  threadReadInputSchema,
  threadSendInputSchema,
  shoppingFetchInputSchema,
  shoppingSearchInputSchema,
  providerErrorMetadataSchema,
  providerErrorSchema,
  searchInputSchema,
  type Listing,
  type ConversationMessage,
  type ConversationThread,
  type ConversationThreadMessages,
  type ProductOffer,
  type ProviderErrorCode,
  type ProviderErrorMetadata,
  type ThreadSendInput
} from './domain.js';
import { FIXTURE_CONVERSATIONS, FIXTURE_LISTINGS } from './fixtures.js';

export interface MarketplaceBackend {
  readonly name: string;
  search(input: ReturnType<typeof searchInputSchema.parse>, signal: AbortSignal): Promise<Listing[]> | Listing[];
  fetch(input: ReturnType<typeof fetchInputSchema.parse>, signal: AbortSignal): Promise<Listing | null> | Listing | null;
}

export interface ConversationBackend {
  readonly name: string;
  listThreads(input: ReturnType<typeof threadsListInputSchema.parse>, signal: AbortSignal): Promise<ConversationThread[]> | ConversationThread[];
  readThread(input: ReturnType<typeof threadReadInputSchema.parse>, signal: AbortSignal): Promise<ConversationThreadMessages | null> | ConversationThreadMessages | null;
  sendThread(input: ReturnType<typeof threadSendInputSchema.parse>, signal: AbortSignal): Promise<void> | void;
}

// Cross-site shopping surface (#48). HTTP-API-backed, no browser session; `name` is the
// configured backend kind ('ebay'), while each offer carries its own `provider` value.
export interface ShoppingBackend {
  readonly name: string;
  search(input: ReturnType<typeof shoppingSearchInputSchema.parse>, signal: AbortSignal): Promise<ProductOffer[]> | ProductOffer[];
  fetch(input: ReturnType<typeof shoppingFetchInputSchema.parse>, signal: AbortSignal): Promise<ProductOffer | null> | ProductOffer | null;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly metadata: ProviderErrorMetadata;

  constructor(code: ProviderErrorCode, message: string, metadata: ProviderErrorMetadata = {}) {
    const parsedMetadata = providerErrorMetadataSchema.safeParse(metadata);
    const parsed = providerErrorSchema.safeParse({ ...metadata, code, message });
    if (!parsedMetadata.success || !parsed.success) throw new TypeError('Invalid ProviderError fields');
    super(parsed.data.message);
    this.name = 'ProviderError';
    this.code = parsed.data.code;
    this.metadata = parsedMetadata.data;
  }
}

// The delivery form that binds the grant's idempotency token into the delivered text, so a
// timed-out send can be reconciled against the thread (matched by the token substring).
export function renderDeliveredMessage(input: ThreadSendInput): string {
  return `${input.message} [${input.idempotency_token}]`;
}

export class FixtureBackend implements MarketplaceBackend, ConversationBackend {
  readonly name = 'fixture';
  // Per-instance store of messages 'you' sent through sendThread; fixture data is never mutated.
  private readonly sentMessages = new Map<string, ConversationMessage[]>();

  constructor(private readonly listings: readonly Listing[] = FIXTURE_LISTINGS) {}

  search(input: ReturnType<typeof searchInputSchema.parse>, _signal: AbortSignal): Listing[] {
    const query = input.query.toLowerCase();
    const location = input.location.toLowerCase();

    return this.listings.filter((listing) => {
      const matchesText = listing.title.toLowerCase().includes(query) || listing.description.toLowerCase().includes(query);
      const matchesLocation = listing.location.toLowerCase().includes(location);
      const matchesMin = input.min_price === undefined || (listing.price !== null && listing.price >= input.min_price);
      const matchesMax = input.max_price === undefined || (listing.price !== null && listing.price <= input.max_price);
      return matchesText && matchesLocation && matchesMin && matchesMax;
    }).slice(0, input.limit);
  }

  fetch(input: ReturnType<typeof fetchInputSchema.parse>, _signal: AbortSignal): Listing | null {
    if (input.id !== undefined) {
      return this.listings.find((listing) => listing.id === input.id) ?? null;
    }

    const canonicalTarget = canonicalHttpUrl(input.url!);
    return this.listings.find((listing) => canonicalHttpUrl(listing.url) === canonicalTarget) ?? null;
  }

  listThreads(input: ReturnType<typeof threadsListInputSchema.parse>, _signal: AbortSignal): ConversationThread[] {
    return FIXTURE_CONVERSATIONS.slice(0, input.limit).map(({ thread }) => thread);
  }

  readThread(input: ReturnType<typeof threadReadInputSchema.parse>, _signal: AbortSignal): ConversationThreadMessages | null {
    const conversation = FIXTURE_CONVERSATIONS.find(({ thread }) => thread.thread_id === input.thread_id);
    const sent = this.sentMessages.get(input.thread_id);
    if (!conversation && !sent) return null;
    return {
      thread_id: input.thread_id,
      messages: [...(conversation?.messages ?? []), ...(sent ?? [])]
    };
  }

  sendThread(input: ReturnType<typeof threadSendInputSchema.parse>, _signal: AbortSignal): void {
    const messages = this.sentMessages.get(input.thread_id) ?? [];
    messages.push({ sender: 'you' as const, text: renderDeliveredMessage(input) });
    this.sentMessages.set(input.thread_id, messages);
  }
}

export function canonicalHttpUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}
