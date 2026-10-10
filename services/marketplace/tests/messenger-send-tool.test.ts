import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { HmacGrantAuthorizer, canonicalActionInput, subjectDigest, type ActionRequest } from '../src/authorization.js';
import { FixtureBackend, ProviderError, renderDeliveredMessage, type ConversationBackend } from '../src/backend.js';
import type { ConversationMessage, ConversationThreadMessages, ThreadSendInput } from '../src/domain.js';
import { registerMarketplaceTools, type MarketplaceToolOptions } from '../src/tools.js';

const SECRET = '0123456789abcdef0123456789abcdef01234567';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';

type CallToolHandler = (
  request: { id?: unknown; params: { name: string; arguments?: Record<string, unknown> } },
  extra: { signal: AbortSignal }
) => Promise<unknown>;

type CapturedHandlers = {
  call?: CallToolHandler;
  list?: (...args: unknown[]) => unknown;
};

function captureHandlers(): { server: Server; handlers: CapturedHandlers } {
  const handlers: CapturedHandlers = {};
  const server = {
    registerCapabilities: () => undefined,
    setRequestHandler: (schema: unknown, handler: (...args: unknown[]) => unknown) => {
      if (schema === CallToolRequestSchema) handlers.call = handler as unknown as CallToolHandler;
      else if (schema === ListToolsRequestSchema) handlers.list = handler;
    }
  };
  return { server: server as unknown as Server, handlers };
}

function register(options: MarketplaceToolOptions = {}): CapturedHandlers {
  const { server, handlers } = captureHandlers();
  registerMarketplaceTools(server, new FixtureBackend(), { error: vi.fn() }, options);
  return handlers;
}

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: { ok: boolean } & Record<string, unknown>;
  isError?: boolean;
};

async function invoke(handlers: CapturedHandlers, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  expect(handlers.call).toBeDefined();
  const signal = new AbortController().signal;
  const result = await handlers.call!({ id: 1, params: { name, arguments: args } }, { signal });
  return result as unknown as ToolCallResult;
}

function sendInput(overrides: Partial<ThreadSendInput> = {}): ThreadSendInput {
  return {
    thread_id: 't-synth-0001',
    message: 'Yes, it is still available.',
    idempotency_token: 'tok-abc123def456ghij',
    ...overrides
  };
}

type GrantFields = {
  grant_id: string;
  provider: string;
  account: string;
  surface: string;
  action: string;
  subject_digest: string;
  expires_at: string;
};

function signEnvelope(grant: GrantFields): { grant: GrantFields; signature: string } {
  return { grant, signature: createHmac('sha256', SECRET).update(canonicalActionInput(grant), 'utf8').digest('hex') };
}

function buildGrant(input: ThreadSendInput, overrides: Partial<GrantFields> = {}): { grant: GrantFields; signature: string } {
  return signEnvelope({
    grant_id: 'grant-0123456789abcdef0123456789',
    provider: 'facebook',
    account: 'default',
    surface: 'messenger',
    action: 'messenger_send',
    subject_digest: subjectDigest(input),
    expires_at: EXPIRES_AT,
    ...overrides
  });
}

type SendBehavior = 'ok' | 'timeout' | 'submit-upstream' | 'upstream' | 'session-invalid';
type ReadBehavior = 'confirmed' | 'bare-token' | 'unconfirmed' | 'null' | 'throws';

function fakeConversations(send: SendBehavior, read: ReadBehavior, input: ThreadSendInput) {
  const calls = { sendThread: 0, readThread: 0 };
  const conversations = {
    name: 'fixture',
    listThreads: () => [],
    readThread: () => {
      calls.readThread += 1;
      if (read === 'throws') throw new ProviderError('TIMEOUT', 'The backend operation exceeded its deadline.');
      if (read === 'confirmed') {
        return { thread_id: input.thread_id, messages: [{ sender: 'you', text: renderDeliveredMessage(input) }] as ConversationMessage[] };
      }
      if (read === 'bare-token') {
        // The bare token, without the brackets of the delivered form, is a different text and
        // must not count as delivery confirmation.
        return { thread_id: input.thread_id, messages: [{ sender: 'you', text: `A reply that mentions ${input.idempotency_token} in plain text.` }] as ConversationMessage[] };
      }
      if (read === 'unconfirmed') {
        return { thread_id: input.thread_id, messages: [{ sender: 'you', text: 'A reply that carries no idempotency marker.' }] as ConversationMessage[] };
      }
      return null;
    },
    sendThread: () => {
      calls.sendThread += 1;
      if (send === 'timeout') throw new ProviderError('TIMEOUT', 'The backend operation exceeded its deadline.');
      if (send === 'submit-upstream') {
        throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Messenger message could not be sent.', { submit_triggered: true });
      }
      if (send === 'upstream') throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Messenger message could not be sent.');
      if (send === 'session-invalid') throw new ProviderError('SESSION_INVALID', 'The messenger session is no longer valid.');
    }
  } satisfies ConversationBackend;
  return { conversations, calls };
}

describe('messenger_send grant enforcement', () => {
  it('sends exactly once with a valid signed grant and confirms delivery through one thread read', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'confirmed', input);
    const approvalGrant = vi.fn((request: ActionRequest) => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'sent' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
    expect(approvalGrant).toHaveBeenCalledTimes(1);
    expect(approvalGrant.mock.calls[0]?.[0]).toMatchObject({
      provider: 'facebook',
      account: 'default',
      surface: 'messenger',
      action: 'messenger_send',
      subjectDigest: subjectDigest(input)
    });
  });

  it('refuses a grant whose subject_digest was computed over a different message without sending', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'confirmed', input);
    const approvalGrant = vi.fn((request: ActionRequest) =>
      buildGrant(input, { subject_digest: subjectDigest({ ...input, message: 'A different message than the granted one.' }) }));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'ACTION_FORBIDDEN', message: 'The presented grant does not authorize this action.' }
    });
    expect(calls.sendThread).toBe(0);
    expect(calls.readThread).toBe(0);
  });

  it('consumes the grant on first use and refuses a replay of the same grant id without sending again', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'confirmed', input);
    const envelope = buildGrant(input);
    const approvalGrant = vi.fn(() => envelope);
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const first = await invoke(handlers, 'messenger_send', { ...input });
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({ ok: true, status: 'sent' });

    const second = await invoke(handlers, 'messenger_send', { ...input });
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toEqual({
      ok: false,
      error: { code: 'ACTION_FORBIDDEN', message: 'The approval grant has already been used.' }
    });

    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
    expect(approvalGrant).toHaveBeenCalledTimes(2);
  });

  it('fails closed with APPROVAL_REQUIRED when the host seam is absent', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'confirmed', input);
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'APPROVAL_REQUIRED', message: 'A valid approval grant is required for this action.' }
    });
    expect(calls.sendThread).toBe(0);
    expect(calls.readThread).toBe(0);
  });

  it('fails closed with APPROVAL_REQUIRED when the host seam throws', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'confirmed', input);
    const approvalGrant = vi.fn(() => {
      throw new Error('approval channel unavailable');
    });
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'APPROVAL_REQUIRED', message: 'A valid approval grant is required for this action.' }
    });
    expect(calls.sendThread).toBe(0);
    expect(calls.readThread).toBe(0);
  });

  it('surfaces a session-invalid send as a standard provider failure without reconciling', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('session-invalid', 'confirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'SESSION_INVALID', message: 'The messenger session is no longer valid.' }
    });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(0);
  });
});

describe('messenger_send post-success delivery observation', () => {
  it('reports a resolved send as unknown when the observation read finds no token in the thread', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'unconfirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('reports a resolved send as unknown when the observation read fails, without resending', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'throws', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('reports a resolved send as unknown when the observation read returns no thread', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'null', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('does not treat a bare (non-bracketed) token in a thread message as delivery confirmation', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('ok', 'bare-token', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });
});

describe('messenger_send timeout reconciliation', () => {
  it('reconciles a timed-out send as sent when the thread contains the idempotency token', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('timeout', 'confirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'sent' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('reports a timed-out send as unknown when no thread message carries the token', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('timeout', 'unconfirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('reports a timed-out send as unknown when the reconciliation read itself times out', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('timeout', 'throws', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('rejects with the abort reason when the request signal aborts during timeout reconciliation', async () => {
    const input = sendInput();
    let readCalled = false;
    let resolveRead: (value: ConversationThreadMessages | null) => void = () => undefined;
    const readInFlight = new Promise<ConversationThreadMessages | null>((resolve) => { resolveRead = resolve; });
    const conversations = {
      name: 'fixture',
      listThreads: () => [],
      readThread: () => {
        readCalled = true;
        return readInFlight;
      },
      sendThread: () => {
        throw new ProviderError('TIMEOUT', 'The backend operation exceeded its deadline.');
      }
    } satisfies ConversationBackend;
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const abort = new AbortController();
    const promise = handlers.call!({ id: 1, params: { name: 'messenger_send', arguments: { ...input } } }, { signal: abort.signal });

    // Wait until the reconciliation read is in flight, then abort the MCP request mid-read.
    let attempts = 0;
    while (!readCalled && attempts < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      attempts += 1;
    }
    expect(readCalled).toBe(true);

    const reason = new Error('MCP request aborted during reconciliation');
    abort.abort(reason);
    resolveRead(null);

    await expect(promise).rejects.toBe(reason);
  });
});

describe('messenger_send post-submit failure reconciliation', () => {
  it('reconciles an upstream failure whose submit was triggered as sent when the observation finds the token', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('submit-upstream', 'confirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'sent' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('reconciles an upstream failure whose submit was triggered as unknown when the observation does not confirm the token', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('submit-upstream', 'unconfirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, backend: 'fixture', thread_id: input.thread_id, status: 'unknown' });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(1);
  });

  it('keeps the provider failure shape when the send failed before the submit was triggered', async () => {
    const input = sendInput();
    const { conversations, calls } = fakeConversations('upstream', 'confirmed', input);
    const approvalGrant = vi.fn(() => buildGrant(input));
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_send', { ...input });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'UPSTREAM_ERROR', message: 'The Facebook Messenger message could not be sent.' }
    });
    expect(calls.sendThread).toBe(1);
    expect(calls.readThread).toBe(0);
  });
});

describe('messenger_send registration', () => {
  it('fails registration when the conversation surface is configured without an authorizer', () => {
    const { conversations } = fakeConversations('ok', 'confirmed', sendInput());
    const { server } = captureHandlers();

    expect(() => registerMarketplaceTools(server, new FixtureBackend(), { error: vi.fn() }, { conversations }))
      .toThrow('Tool messenger_send requires an authorizer for write actions');
  });

  it('lists messenger_send only when the conversation surface is configured', async () => {
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const { conversations } = fakeConversations('ok', 'confirmed', sendInput());

    const withSurface = captureHandlers();
    registerMarketplaceTools(withSurface.server, new FixtureBackend(), { error: vi.fn() }, { conversations, authorizer });
    const listedWith = (await withSurface.handlers.list!()) as { tools: Array<{ name: string }> };
    expect(listedWith.tools.map(({ name }) => name)).toContain('messenger_send');

    const withoutSurface = captureHandlers();
    registerMarketplaceTools(withoutSurface.server, new FixtureBackend(), { error: vi.fn() }, { authorizer });
    const listedWithout = (await withoutSurface.handlers.list!()) as { tools: Array<{ name: string }> };
    expect(listedWithout.tools.map(({ name }) => name)).not.toContain('messenger_send');
  });

  it('rejects a messenger_send call as an unknown tool when the surface is not configured', async () => {
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const handlers = register({ authorizer });

    await expect(invoke(handlers, 'messenger_send', { ...sendInput() })).rejects.toMatchObject({
      name: 'McpError',
      code: ErrorCode.InvalidParams,
      message: `MCP error ${ErrorCode.InvalidParams}: Unknown tool: messenger_send`
    });
  });

  it('keeps messenger_thread_read grant-free and successful while the send surface is active', async () => {
    const conversations = new FixtureBackend();
    const authorizer = new HmacGrantAuthorizer({ secret: SECRET });
    const approvalGrant = vi.fn();
    const handlers = register({ conversations, authorizer, approvalGrant });

    const result = await invoke(handlers, 'messenger_thread_read', { thread_id: 't-synth-0001' });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true, backend: 'fixture', thread_id: 't-synth-0001' });
    expect(result.structuredContent.messages).toHaveLength(3);
    expect(approvalGrant).not.toHaveBeenCalled();
  });
});
