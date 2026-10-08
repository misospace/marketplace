import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ActionDefinition, ActionRequest, ApprovalGrant } from '../src/authorization.js';
import {
  ACTION_RISK_CLASSES,
  authorizeAction,
  canonicalActionInput,
  DenyAllAuthorizer,
  subjectDigest
} from '../src/authorization.js';
import { UnverifiedGrantAuthorizer } from './helpers/unverified-grant-authorizer.js';
import { FixtureBackend } from '../src/backend.js';
import { registerMarketplaceTools, assertWritableToolsHaveAuthorizer, TOOL_DEFINITIONS } from '../src/tools.js';

const request: ActionRequest = {
  provider: 'facebook',
  account: 'acct-test-1',
  surface: 'marketplace',
  action: 'send_message',
  subjectDigest: subjectDigest({ listing_id: 'listing-test-1', message: 'synthetic test message' })
};

function grant(overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    grant_id: `grant-${'a'.repeat(20)}`,
    provider: request.provider,
    account: request.account,
    surface: request.surface,
    action: request.action,
    subject_digest: request.subjectDigest,
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides
  };
}

const sendDefinition: ActionDefinition = {
  riskClass: 'send',
  scope: { provider: request.provider, account: request.account, surface: request.surface }
};

const fixedNow = new Date('2098-01-01T00:00:00.000Z');

describe('canonical action subjects', () => {
  it('is key-order independent at every object depth and deterministic across calls', () => {
    const first = { z: 1, nested: { y: true, x: 'value' }, a: null };
    const second = { a: null, nested: { x: 'value', y: true }, z: 1 };

    expect(canonicalActionInput(first)).toBe(canonicalActionInput(second));
    expect(subjectDigest(first)).toBe(subjectDigest(second));
    expect(subjectDigest(first)).toBe(subjectDigest(first));
  });

  it('preserves array order and changes the digest when values change', () => {
    expect(canonicalActionInput({ values: [1, 2] })).not.toBe(canonicalActionInput({ values: [2, 1] }));
    expect(subjectDigest({ nested: { value: 1 } })).not.toBe(subjectDigest({ nested: { value: 2 } }));
  });
});

describe('action authorization gate', () => {
  it.each(['read', 'prepare'] as const)('allows %s without consulting the authorizer', (riskClass) => {
    const authorizer = { authorize: vi.fn(() => ({ ok: false as const, code: 'APPROVAL_REQUIRED' as const, message: 'no' })) };
    const definition: ActionDefinition = { riskClass, scope: sendDefinition.scope };

    expect(authorizeAction(definition, request, authorizer, undefined)).toEqual({ ok: true });
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it('fails closed for send when no approval authority is configured', () => {
    expect(authorizeAction(sendDefinition, request, new DenyAllAuthorizer(), undefined)).toEqual({
      ok: false,
      code: 'APPROVAL_REQUIRED',
      message: 'No approval authority is configured for write actions.'
    });
  });

  it('accepts a valid send grant through the in-memory authorizer', () => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    expect(authorizeAction(sendDefinition, request, authorizer, grant())).toEqual({ ok: true });
  });

  it('refuses high-consequence actions even with a valid grant and authorizer', () => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    const definition: ActionDefinition = { riskClass: 'high_consequence', scope: sendDefinition.scope };

    expect(authorizeAction(definition, request, authorizer, grant())).toEqual({
      ok: false,
      code: 'ACTION_FORBIDDEN',
      message: 'High-consequence actions are not enabled.'
    });
    expect(authorizer.authorize(request, grant())).toEqual({ ok: true });
  });
});

describe('in-memory approval grants', () => {
  it('accepts one correctly scoped, unexpired grant', () => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    expect(authorizer.authorize(request, grant())).toEqual({ ok: true });
  });

  it('requires a schema-valid grant', () => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    expect(authorizer.authorize(request, {})).toEqual({
      ok: false,
      code: 'APPROVAL_REQUIRED',
      message: 'A valid approval grant is required for this action.'
    });
  });

  it.each([
    ['provider', { provider: 'other-provider' }],
    ['account', { account: 'other-account' }],
    ['surface', { surface: 'other-surface' }],
    ['action', { action: 'other-action' }],
    ['subject_digest', { subject_digest: '0'.repeat(64) }]
  ] as const)('rejects a grant with a mismatched %s', (_field, mismatch) => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    expect(authorizer.authorize(request, grant(mismatch))).toMatchObject({ ok: false, code: 'ACTION_FORBIDDEN' });
  });

  it('treats expiry equal to now as expired and accepts a grant one millisecond in the future', () => {
    const expiredAuthorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    expect(expiredAuthorizer.authorize(request, grant({ expires_at: fixedNow.toISOString() }))).toEqual({
      ok: false,
      code: 'ACTION_FORBIDDEN',
      message: 'The approval grant has expired.'
    });

    const futureAuthorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    expect(futureAuthorizer.authorize(request, grant({ expires_at: new Date(fixedNow.getTime() + 1).toISOString() }))).toEqual({ ok: true });
  });

  it('rejects replay after consuming a grant', () => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    const approval = grant();

    expect(authorizer.authorize(request, approval)).toEqual({ ok: true });
    expect(authorizer.authorize(request, approval)).toEqual({
      ok: false,
      code: 'ACTION_FORBIDDEN',
      message: 'The approval grant has already been used.'
    });
  });

  it('consumes exactly one grant across repeated attempts (synchronous verify-then-consume)', () => {
    const authorizer = new UnverifiedGrantAuthorizer({ now: () => fixedNow });
    const approval = grant();
    const decisions = [authorizer.authorize(request, approval), authorizer.authorize(request, approval)];

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.ok)).toHaveLength(1);
  });
});

describe('write-tool registration guard', () => {
  const readEntry = { name: 'marketplace_search', definition: { riskClass: 'read', scope: sendDefinition.scope } as const };
  const sendEntry = { name: 'marketplace_send_message', definition: sendDefinition };

  it('fails registration when a send-class tool has no authorizer', () => {
    expect(() => assertWritableToolsHaveAuthorizer([readEntry, sendEntry], undefined)).toThrow(
      'Tool marketplace_send_message requires an authorizer for write actions'
    );
  });

  it('accepts send-class tools with an authorizer and never gates read-only tools', () => {
    expect(() => assertWritableToolsHaveAuthorizer([readEntry, sendEntry], new DenyAllAuthorizer())).not.toThrow();
    expect(() => assertWritableToolsHaveAuthorizer([readEntry], undefined)).not.toThrow();
  });
});

describe('registered tool action boundaries', () => {
  it('declares every registered tool read-only and dispatches through the real MCP server', async () => {
    expect(ACTION_RISK_CLASSES).toEqual(['read', 'prepare', 'send', 'high_consequence']);
    expect(Object.values(TOOL_DEFINITIONS).every(({ riskClass }) => riskClass === 'read')).toBe(true);
    expect(TOOL_DEFINITIONS.messenger_threads_list.scope).toEqual({ provider: 'facebook', account: 'default', surface: 'messenger' });
    expect(TOOL_DEFINITIONS.messenger_thread_read.scope).toEqual({ provider: 'facebook', account: 'default', surface: 'messenger' });

    const server = new Server({ name: 'authorization-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'authorization-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerMarketplaceTools(server, new FixtureBackend(), { error: vi.fn() });

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const registeredNames = tools.tools.map(({ name }) => name).sort();
      expect(registeredNames).toEqual(Object.keys(TOOL_DEFINITIONS).sort());
      expect(Object.keys(TOOL_DEFINITIONS).every((name) => tools.tools.some((tool) => tool.name === name))).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
