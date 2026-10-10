import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FileGrantConsumptionStore,
  InMemoryGrantConsumptionStore
} from '../src/grant-state.js';
import {
  canonicalActionInput,
  HmacGrantAuthorizer,
  subjectDigest,
  type ActionRequest,
  type ApprovalGrant,
  type SignedGrantEnvelope
} from '../src/authorization.js';

const SECRET = '0123456789abcdef0123456789abcdef01234567';
// Far in the future relative to any real clock, so a store using the real
// clock never prunes these entries during the same claim.
const FAR_FUTURE_MS = Date.parse('2100-01-01T00:00:00.000Z');

describe('InMemoryGrantConsumptionStore', () => {
  it('claims a grant id exactly once: the first caller wins, replays are rejected', () => {
    const store = new InMemoryGrantConsumptionStore();
    expect(store.claim('grant-one', FAR_FUTURE_MS)).toBe(true);
    expect(store.claim('grant-one', FAR_FUTURE_MS)).toBe(false);
    expect(store.claim('grant-two', FAR_FUTURE_MS)).toBe(true);
  });

  it('prunes entries whose stored expiry has passed during a later claim', () => {
    let nowMs = 1_000;
    const store = new InMemoryGrantConsumptionStore({ now: () => new Date(nowMs) });
    expect(store.claim('grant-a', 2_000)).toBe(true);
    expect(store.claim('grant-a', 2_000)).toBe(false);
    nowMs = 3_000;
    // The stored entry is expired, so it is pruned and the id can be claimed again.
    expect(store.claim('grant-a', 2_000)).toBe(true);
  });
});

describe('FileGrantConsumptionStore', () => {
  let root: string;
  const createdDirs: string[] = [];

  function freshDir(): string {
    const dir = mkdtempSync(join(root, 'grant-state-'));
    createdDirs.push(dir);
    return dir;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'marketplace-grant-state-'));
  });

  afterAll(() => {
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('creates its state directory recursively at construction', () => {
    const dir = join(root, 'nested', 'deep', 'state');
    new FileGrantConsumptionStore({ dir });
    expect(existsSync(join(dir, '..'))).toBe(true);
  });

  it('claims a grant id exactly once: a replay in the same store is rejected', () => {
    const dir = freshDir();
    const store = new FileGrantConsumptionStore({ dir });
    expect(store.claim('grant-a', FAR_FUTURE_MS)).toBe(true);
    expect(existsSync(join(dir, 'grant-a'))).toBe(true);
    expect(store.claim('grant-a', FAR_FUTURE_MS)).toBe(false);
  });

  it('rejects an already-claimed grant from a second store instance over the same directory (replica)', () => {
    const dir = freshDir();
    const first = new FileGrantConsumptionStore({ dir });
    expect(first.claim('grant-b', FAR_FUTURE_MS)).toBe(true);
    const replica = new FileGrantConsumptionStore({ dir });
    expect(replica.claim('grant-b', FAR_FUTURE_MS)).toBe(false);
  });

  it('rejects an already-claimed grant from a new store over the same directory (restart)', () => {
    const dir = freshDir();
    const first = new FileGrantConsumptionStore({ dir });
    expect(first.claim('grant-c', FAR_FUTURE_MS)).toBe(true);
    // The claim is on disk; a fresh process (fresh instance) sees it.
    const restarted = new FileGrantConsumptionStore({ dir });
    expect(restarted.claim('grant-c', FAR_FUTURE_MS)).toBe(false);
  });

  it('prunes expired files during claim, throttled to once per 60s per store instance', () => {
    const dir = freshDir();
    let nowMs = 1_000;
    const first = new FileGrantConsumptionStore({ dir, now: () => new Date(nowMs) });
    expect(first.claim('grant-expired', 2_000)).toBe(true);
    // Within the 60s throttle window the expired file is left alone.
    nowMs = 2_500;
    expect(first.claim('grant-still-valid', 90_000)).toBe(true);
    expect(existsSync(join(dir, 'grant-expired'))).toBe(true);
    // A new instance has a fresh throttle budget and prunes on its first claim.
    const second = new FileGrantConsumptionStore({ dir, now: () => new Date(nowMs) });
    expect(second.claim('grant-third', 90_000)).toBe(true);
    expect(existsSync(join(dir, 'grant-expired'))).toBe(false);
    expect(existsSync(join(dir, 'grant-still-valid'))).toBe(true);
  });

  it('prunes expired numeric markers but keeps empty and non-numeric (corrupt) markers', () => {
    const dir = freshDir();
    const nowMs = 100_000;
    const store = new FileGrantConsumptionStore({ dir, now: () => new Date(nowMs) });
    // One expired numeric marker plus a far-future marker that must survive.
    expect(store.claim('grant-expired', 10_000)).toBe(true);
    expect(store.claim('grant-future', 999_999_999)).toBe(true);
    // Simulate a concurrent replica's in-flight claim: an empty file (the write not yet
    // flushed) and a crash-truncated / corrupt non-numeric marker.
    writeFileSync(join(dir, 'grant-empty'), '');
    writeFileSync(join(dir, 'grant-corrupt'), 'not-a-number');
    // A fresh instance has a fresh throttle budget, so its first claim runs a prune.
    const pruner = new FileGrantConsumptionStore({ dir, now: () => new Date(nowMs) });
    expect(pruner.claim('grant-new', 999_999_999)).toBe(true);

    expect(existsSync(join(dir, 'grant-expired'))).toBe(false);
    expect(existsSync(join(dir, 'grant-empty'))).toBe(true);
    expect(existsSync(join(dir, 'grant-corrupt'))).toBe(true);
    expect(existsSync(join(dir, 'grant-future'))).toBe(true);
  });

  it('never lets a prune failure break a claim', () => {
    const dir = freshDir();
    let nowMs = 1_000;
    const store = new FileGrantConsumptionStore({ dir, now: () => new Date(nowMs) });
    expect(store.claim('grant-a', 2_000)).toBe(true);
    // A subdirectory whose name matches the grant id pattern makes the prune
    // fail when it tries to read it as a file; the failure is swallowed.
    mkdirSync(join(dir, 'subdir'));
    nowMs = 100_000;
    expect(store.claim('grant-b', 200_000)).toBe(true);
    expect(existsSync(join(dir, 'grant-b'))).toBe(true);
  });

  it('rejects grant ids that do not match the validated pattern instead of touching paths', () => {
    const dir = freshDir();
    const store = new FileGrantConsumptionStore({ dir });
    expect(() => store.claim('../outside', 10_000)).toThrow(TypeError);
    expect(() => store.claim('a/b', 10_000)).toThrow(TypeError);
    expect(() => store.claim('bad\nid', 10_000)).toThrow(TypeError);
    expect(() => store.claim('', 10_000)).toThrow(TypeError);
    expect(() => store.claim('.', 10_000)).toThrow(TypeError);
    expect(() => store.claim('..', 10_000)).toThrow(TypeError);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('shared in-memory store across HmacGrantAuthorizer instances', () => {
  const request: ActionRequest = {
    provider: 'facebook',
    account: 'acct-test-1',
    surface: 'marketplace',
    action: 'send_message',
    subjectDigest: subjectDigest({ listing_id: 'listing-test-1', message: 'shared store message' })
  };

  function signedGrant(grantId: string): SignedGrantEnvelope {
    const grant: ApprovalGrant = {
      grant_id: grantId,
      provider: request.provider,
      account: request.account,
      surface: request.surface,
      action: request.action,
      subject_digest: request.subjectDigest,
      expires_at: '2099-01-01T00:00:00.000Z'
    };
    return {
      grant,
      signature: createHmac('sha256', SECRET).update(canonicalActionInput(grant), 'utf8').digest('hex')
    };
  }

  it('replays a valid signed envelope against a second authorizer sharing one store', () => {
    const store = new InMemoryGrantConsumptionStore();
    const first = new HmacGrantAuthorizer({ secret: SECRET, store });
    const second = new HmacGrantAuthorizer({ secret: SECRET, store });
    const envelope = signedGrant(`grant-shared-${'a'.repeat(16)}`);

    expect(first.authorize(request, envelope)).toEqual({ ok: true });
    expect(second.authorize(request, envelope)).toEqual({
      ok: false,
      code: 'ACTION_FORBIDDEN',
      message: 'The approval grant has already been used.'
    });
  });
});
