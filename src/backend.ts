import { fetchInputSchema, searchInputSchema, type Listing } from './domain.js';
import { FIXTURE_LISTINGS } from './fixtures.js';

export interface MarketplaceBackend {
  search(input: ReturnType<typeof searchInputSchema.parse>): Promise<Listing[]> | Listing[];
  fetch(input: ReturnType<typeof fetchInputSchema.parse>): Promise<Listing | null> | Listing | null;
}

export class FixtureBackend implements MarketplaceBackend {
  constructor(private readonly listings: readonly Listing[] = FIXTURE_LISTINGS) {}

  search(input: ReturnType<typeof searchInputSchema.parse>): Listing[] {
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

  fetch(input: ReturnType<typeof fetchInputSchema.parse>): Listing | null {
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
