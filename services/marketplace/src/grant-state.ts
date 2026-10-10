import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single-use consumption state for approval grants. A claim is atomic
 * check-and-set: exactly one caller can claim a grant id and win.
 */
export interface GrantConsumptionStore {
  claim(grantId: string, expiresAtMs: number): boolean;
}

const GRANT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Map-based consumption store. Entries whose stored expiry has passed are
 * pruned during claim: an expired grant can never re-verify anyway, because
 * the expiry check precedes the claim.
 */
export class InMemoryGrantConsumptionStore implements GrantConsumptionStore {
  private readonly consumed = new Map<string, number>();
  private readonly now: () => Date;

  constructor(options?: { readonly now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  claim(grantId: string, expiresAtMs: number): boolean {
    const nowMs = this.now().getTime();
    for (const [id, expiresAtMs] of this.consumed) {
      if (expiresAtMs <= nowMs) this.consumed.delete(id);
    }
    if (this.consumed.has(grantId)) return false;
    this.consumed.set(grantId, expiresAtMs);
    return true;
  }
}

const PRUNE_INTERVAL_MS = 60_000;

/**
 * File-backed consumption store: a grant is claimed by exclusively creating
 * `${dir}/${grantId}` containing its expiry, so a claim survives process
 * restarts and is visible to every replica sharing the directory. EEXIST
 * means the id is already claimed.
 */
export class FileGrantConsumptionStore implements GrantConsumptionStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private lastPruneAtMs: number | undefined;

  constructor(options: { dir: string; now?: () => Date }) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });
  }

  claim(grantId: string, expiresAtMs: number): boolean {
    // Grant ids are validated upstream by approvalGrantSchema; re-check here
    // because the id is spliced into a file path.
    if (!GRANT_ID_PATTERN.test(grantId)) {
      throw new TypeError('grantId must match /^[A-Za-z0-9._:-]+$/');
    }
    const nowMs = this.now().getTime();
    if (this.lastPruneAtMs === undefined || nowMs - this.lastPruneAtMs >= PRUNE_INTERVAL_MS) {
      this.lastPruneAtMs = nowMs;
      try {
        this.pruneExpired(nowMs);
      } catch {
        // Pruning is best-effort hygiene; a failure must never break a claim.
      }
    }
    try {
      const handle = openSync(join(this.dir, grantId), 'wx');
      try {
        writeSync(handle, String(expiresAtMs));
      } finally {
        closeSync(handle);
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
    return true;
  }

  private pruneExpired(nowMs: number): void {
    for (const name of readdirSync(this.dir)) {
      try {
        const stored = Number(readFileSync(join(this.dir, name), 'utf8').trim());
        if (Number.isFinite(stored) && stored <= nowMs) {
          rmSync(join(this.dir, name));
        }
      } catch {
        // One unreadable or undeletable entry must not stop the rest of the prune.
      }
    }
  }
}
