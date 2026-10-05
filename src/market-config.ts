import { readFileSync, statSync, type Stats } from 'node:fs';
import { z } from 'zod';
import { validateFacebookMarkets, validateMarket, type FacebookMarket } from './facebook-marketplace-url.js';

/** Bounds a mounted ConfigMap; the built-in map is ten entries. */
const MAX_MARKETS_FILE_BYTES = 64 * 1024;

// Structure only. The slug, currency, label and alias rules deliberately stay in
// validateMarket / validateFacebookMarkets, so a configured file cannot drift from the rules
// the built-in map is held to.
const marketsSchema = z.array(z.object({
  slug: z.string(),
  label: z.string(),
  currency: z.string(),
  aliases: z.array(z.string()).optional()
}).strict()).min(1);

/**
 * Resolves the configured market-map path. `FACEBOOK_MARKETS_FILE` is the documented name;
 * `MARKETPLACE_MARKETS_FILE` is the name this first shipped under and stays as a fallback so an
 * existing deployment keeps working. A blank value counts as unset.
 */
export function facebookMarketsFilePath(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const value of [env.FACEBOOK_MARKETS_FILE, env.MARKETPLACE_MARKETS_FILE]) {
    if (value !== undefined && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Loads a replacement market map from a JSON file of `FacebookMarket` entries. An explicit file
 * replaces the built-in defaults; an unset or blank path leaves them in place. Invalid
 * configuration fails startup with an error naming the file and the offending entry, without
 * echoing file contents.
 */
export function loadFacebookMarkets(path: string | undefined): readonly FacebookMarket[] | undefined {
  if (path === undefined || !path.trim()) return undefined;
  const source = `the Facebook markets file at ${path}`;

  let stats: Stats;
  try {
    // statSync, not lstatSync: it follows symlinks, which is how a Kubernetes ConfigMap volume
    // projects a file. Reject anything that is not a regular file first, because readFileSync
    // would block indefinitely on a FIFO or device path.
    stats = statSync(path);
  } catch (error) {
    throw new Error(`Could not read ${source}: ${describe(error)}`);
  }
  if (!stats.isFile()) throw new Error(`Could not read ${source}: not a regular file`);
  // Bound before reading. readFileSync pulls the whole file into memory, so checking the size
  // afterwards would let an oversized file exhaust memory instead of failing cleanly.
  if (stats.size > MAX_MARKETS_FILE_BYTES) {
    throw new RangeError(`${source} is larger than the ${MAX_MARKETS_FILE_BYTES} byte limit`);
  }

  let contents: Buffer;
  try {
    contents = readFileSync(path);
  } catch (error) {
    throw new Error(`Could not read ${source}: ${describe(error)}`);
  }
  if (contents.byteLength > MAX_MARKETS_FILE_BYTES) {
    // The file grew between the stat and the read.
    throw new RangeError(`${source} is larger than the ${MAX_MARKETS_FILE_BYTES} byte limit`);
  }

  let value: unknown;
  try {
    value = JSON.parse(stripByteOrderMark(contents.toString('utf8')));
  } catch {
    // V8's SyntaxError message quotes the offending input, so the parser detail is dropped
    // rather than echoed into startup logs.
    throw new TypeError(`${source} is not valid JSON`);
  }

  const parsed = marketsSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${source} is not a valid market map: ${formatIssue(parsed.error)}`);
  }

  parsed.data.forEach((market, index) => {
    try {
      validateMarket(market);
    } catch (error) {
      throw new TypeError(`${source} has an invalid market at index ${index}: ${describe(error)}`);
    }
  });
  try {
    validateFacebookMarkets(parsed.data);
  } catch (error) {
    throw new TypeError(`${source} is not a valid market map: ${describe(error)}`);
  }

  return parsed.data;
}

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid document';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
