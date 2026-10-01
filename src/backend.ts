import { z } from 'zod';
import {
  fetchInputSchema,
  providerErrorMetadataSchema,
  providerErrorSchema,
  searchInputSchema,
  type Listing,
  type ProviderErrorCode,
  type ProviderErrorMetadata
} from './domain.js';
import { FIXTURE_LISTINGS } from './fixtures.js';

export interface MarketplaceBackend {
  readonly name: string;
  search(input: ReturnType<typeof searchInputSchema.parse>, signal: AbortSignal): Promise<Listing[]> | Listing[];
  fetch(input: ReturnType<typeof fetchInputSchema.parse>, signal: AbortSignal): Promise<Listing | null> | Listing | null;
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

export class FixtureBackend implements MarketplaceBackend {
  readonly name = 'fixture';

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
}

export function canonicalHttpUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}
