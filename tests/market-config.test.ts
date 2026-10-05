import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { facebookMarketsFilePath, loadFacebookMarkets } from '../src/market-config.js';
import { resolveFacebookMarket } from '../src/facebook-marketplace-url.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'market-config-'));
  dirs.push(dir);
  const path = join(dir, 'markets.json');
  writeFileSync(path, contents);
  return path;
}

function file(value: unknown): string {
  return write(JSON.stringify(value));
}

const calgary = { slug: 'calgary', label: 'Calgary, AB', currency: 'CAD', aliases: ['calgary alberta'] };

describe('runtime market map', () => {
  it('keeps the built-in defaults when no path is configured', () => {
    expect(loadFacebookMarkets(undefined)).toBeUndefined();
    expect(loadFacebookMarkets('')).toBeUndefined();
    expect(loadFacebookMarkets('   ')).toBeUndefined();
  });

  it('replaces the defaults with the configured map', () => {
    const markets = loadFacebookMarkets(file([calgary]));
    expect(resolveFacebookMarket('calgary alberta', markets!)).toEqual({ ok: true, market: calgary });
    expect(resolveFacebookMarket('Calgary, AB', markets!)).toEqual({ ok: true, market: calgary });
    expect(resolveFacebookMarket('nyc', markets!)).toEqual({ ok: false, reason: 'unknown', candidates: [] });
  });

  it('tolerates a byte-order mark', () => {
    const markets = loadFacebookMarkets(write('\uFEFF' + JSON.stringify([calgary])));
    expect(resolveFacebookMarket('calgary', markets!)).toEqual({ ok: true, market: calgary });
  });

  it('names the file when it cannot be read', () => {
    expect(() => loadFacebookMarkets('/nonexistent/markets.json')).toThrow(
      'Could not read the Facebook markets file at /nonexistent/markets.json'
    );
  });

  it('names the file when the JSON is malformed', () => {
    const path = write('{ not json');
    expect(() => loadFacebookMarkets(path)).toThrow(`${path} is not valid JSON`);
  });

  it('rejects a document that is not a non-empty array of markets', () => {
    expect(() => loadFacebookMarkets(file({ markets: [calgary] }))).toThrow('is not a valid market map');
    expect(() => loadFacebookMarkets(file([]))).toThrow('is not a valid market map');
  });

  it('rejects unknown keys rather than ignoring them', () => {
    expect(() => loadFacebookMarkets(file([{ ...calgary, currency_code: 'CAD' }]))).toThrow('is not a valid market map');
  });

  it('reports the index of an entry that breaks the built-in rules', () => {
    // Every case here is rejected by validateMarket, the same rule set the built-in map satisfies,
    // so a configured map cannot drift from it.
    const cases: Array<[unknown, string]> = [
      [{ ...calgary, slug: 'Calgary' }, 'Market slug is invalid'],
      [{ ...calgary, slug: '-calgary' }, 'Market slug is invalid'],
      [{ ...calgary, currency: 'cad' }, 'Market currency is invalid'],
      [{ ...calgary, currency: 'CADS' }, 'Market currency is invalid'],
      [{ ...calgary, label: '   ' }, 'Market label must not be blank'],
      [{ ...calgary, aliases: [''] }, 'Market aliases must be non-blank strings']
    ];
    for (const [entry, message] of cases) {
      const path = file([calgary, entry]);
      expect(() => loadFacebookMarkets(path)).toThrow(`${path} has an invalid market at index 1: ${message}`);
    }
  });

  it('rejects duplicate slugs and labels shared by two markets', () => {
    expect(() => loadFacebookMarkets(file([calgary, calgary]))).toThrow('Market slugs must be unique');
    expect(() => loadFacebookMarkets(file([calgary, { ...calgary, slug: 'yyc' }]))).toThrow(
      'Market keys must not map to different market configurations'
    );
  });

  it('rejects an oversized file', () => {
    const path = write(JSON.stringify([{ ...calgary, label: 'x'.repeat(70 * 1024) }]));
    expect(() => loadFacebookMarkets(path)).toThrow('is larger than the 65536 byte limit');
  });

  it('does not echo configured values in errors', () => {
    const path = file([{ ...calgary, label: 'MARKER_VALUE', currency: 'cad' }]);
    let message = '';
    try {
      loadFacebookMarkets(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Market currency is invalid');
    expect(message).not.toContain('MARKER_VALUE');
  });

  it('does not echo file contents when the JSON is malformed', () => {
    // V8's SyntaxError quotes the offending input, so the parser detail must not be threaded
    // through to startup logs.
    const path = write('{ "MARKER_VALUE": oops');
    let message = '';
    try {
      loadFacebookMarkets(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('is not valid JSON');
    expect(message).not.toContain('MARKER_VALUE');
  });

  it('rejects a path that is not a regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'market-config-'));
    dirs.push(dir);
    expect(() => loadFacebookMarkets(dir)).toThrow('not a regular file');
  });

  it('prefers FACEBOOK_MARKETS_FILE and falls back to the deprecated name', () => {
    expect(facebookMarketsFilePath({ FACEBOOK_MARKETS_FILE: '/new.json', MARKETPLACE_MARKETS_FILE: '/old.json' })).toBe('/new.json');
    expect(facebookMarketsFilePath({ MARKETPLACE_MARKETS_FILE: '/old.json' })).toBe('/old.json');
    expect(facebookMarketsFilePath({ FACEBOOK_MARKETS_FILE: '  ' })).toBeUndefined();
    expect(facebookMarketsFilePath({})).toBeUndefined();
  });
});
