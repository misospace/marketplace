import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFacebookMarkets } from '../src/market-config.js';
import { resolveFacebookMarket } from '../src/facebook-marketplace-url.js';

const dirs: string[] = [];
function file(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'market-config-'));
  dirs.push(dir);
  const path = join(dir, 'markets.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const calgary = { slug: 'calgary', label: 'Calgary, AB', currency: 'CAD', aliases: ['calgary alberta'] };

describe('runtime market map', () => {
  it('preserves defaults when unset', () => expect(loadFacebookMarkets(undefined)).toBeUndefined());
  it('resolves configured Calgary aliases with CAD', () => {
    const markets = loadFacebookMarkets(file([calgary]));
    expect(resolveFacebookMarket('calgary alberta', markets)).toEqual({ ok: true, market: calgary });
    expect(resolveFacebookMarket('nyc', markets).ok).toBe(false);
  });
  it.each([[], {}, [{ ...calgary, currency: 'cad' }], [{ ...calgary, slug: '../bad' }], [calgary, calgary], [calgary, { ...calgary, slug: 'other' }]])('rejects invalid maps', (value) => {
    expect(() => loadFacebookMarkets(file(value))).toThrow('valid market map');
  });
  it('rejects unreadable and malformed files without exposing content', () => {
    expect(() => loadFacebookMarkets('/nonexistent/markets.json')).toThrow('valid market map');
    const path = file(null);
    writeFileSync(path, 'private malformed content');
    expect(() => loadFacebookMarkets(path)).toThrow('MARKETPLACE_MARKETS_FILE must contain a readable, valid market map');
  });
});
