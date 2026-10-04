import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { normalizeLocationKey, type FacebookMarket } from './facebook-marketplace-url.js';

const nonBlank = z.string().trim().min(1).max(200);
const marketsSchema = z.array(z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100),
  label: nonBlank,
  currency: z.string().regex(/^[A-Z]{3}$/),
  aliases: z.array(nonBlank).max(50).optional()
}).strict()).min(1).max(100);

/** An explicit file replaces the defaults; invalid configuration fails startup. */
export function loadFacebookMarkets(path: string | undefined): readonly FacebookMarket[] | undefined {
  if (path === undefined) return undefined;
  try {
    if (!path.trim()) throw new Error();
    const data = readFileSync(path);
    if (data.length > 64 * 1024) throw new Error();
    const markets = marketsSchema.parse(JSON.parse(data.toString('utf8')));
    const slugs = new Set<string>();
    const keys = new Map<string, string>();
    for (const market of markets) {
      if (slugs.has(market.slug)) throw new Error();
      slugs.add(market.slug);
      for (const value of [market.slug, market.label, ...(market.aliases ?? [])]) {
        const key = normalizeLocationKey(value);
        if (!key || (keys.has(key) && keys.get(key) !== market.slug)) throw new Error();
        keys.set(key, market.slug);
      }
    }
    return markets;
  } catch {
    // Do not include file contents or parser diagnostics in startup logs.
    throw new Error('MARKETPLACE_MARKETS_FILE must contain a readable, valid market map');
  }
}
