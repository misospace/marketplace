import { describe, expect, it } from 'vitest';
import { FixtureBackend } from '../src/backend.js';
import { FIXTURE_CONVERSATIONS } from '../src/fixtures.js';
import {
  sendDeliveryStatusSchema,
  sendOutputSchema,
  sendSuccessSchema,
  threadReadInputSchema,
  threadSendInputSchema
} from '../src/domain.js';

const signal = new AbortController().signal;
const bikeFixtureMessages = [
  { sender: 'other', sender_name: 'Synthetic Seller', text: 'Is the bike still available?', sent_at: '2025-03-06T10:00:00.000Z' },
  { sender: 'you', text: 'Yes, it is available.', sent_at: '2025-03-06T10:05:00.000Z' },
  { sender: 'other', sender_name: 'Synthetic Seller', text: 'Could I see it this weekend?', sent_at: '2025-03-06T10:10:00.000Z' }
];

function sendPayload(
  overrides: Partial<{ thread_id: string; message: string; idempotency_token: string }> = {}
): { thread_id: string; message: string; idempotency_token: string } {
  return {
    thread_id: 't-synth-0001',
    message: 'Yes, it is available. (idempotency: tok-abc123def456ghij)',
    idempotency_token: 'tok-abc123def456ghij',
    ...overrides
  };
}

describe('FixtureBackend.sendThread', () => {
  it('appends the sent message after the fixture messages without mutating fixture data', () => {
    const backend = new FixtureBackend();
    const payload = sendPayload();
    backend.sendThread(payload, signal);

    const result = backend.readThread({ thread_id: payload.thread_id }, signal);
    expect(result).toEqual({
      thread_id: payload.thread_id,
      messages: [
        ...bikeFixtureMessages,
        { sender: 'you', text: `${payload.message} [${payload.idempotency_token}]` }
      ]
    });
    expect(FIXTURE_CONVERSATIONS.find(({ thread }) => thread.thread_id === payload.thread_id)?.messages).toEqual(bikeFixtureMessages);
  });

  it('makes readThread return a thread entry for a sent-to thread id that has no fixture data', () => {
    const backend = new FixtureBackend();
    const payload = sendPayload({ thread_id: 't-unknown-0001', message: 'Is this still for sale?' });
    backend.sendThread(payload, signal);

    const result = backend.readThread({ thread_id: payload.thread_id }, signal);
    expect(result).toEqual({
      thread_id: payload.thread_id,
      messages: [{ sender: 'you', text: `${payload.message} [${payload.idempotency_token}]` }]
    });
  });

  it('embeds the idempotency token by the backend even when the message text does not contain it', () => {
    const backend = new FixtureBackend();
    const payload = sendPayload({ message: 'Is this still for sale?', idempotency_token: 'tok-xyz789abcdef0123' });
    expect(payload.message).not.toContain(payload.idempotency_token);
    backend.sendThread(payload, signal);

    const result = backend.readThread({ thread_id: payload.thread_id }, signal);
    const sent = result?.messages.at(-1);
    expect(sent?.text).toBe(`${payload.message} [${payload.idempotency_token}]`);
    expect(sent?.text).toContain(payload.idempotency_token);
  });

  it('still returns null from readThread for a never-touched unknown thread', () => {
    const backend = new FixtureBackend();
    expect(backend.readThread({ thread_id: 't-untouched-0001' }, signal)).toBeNull();
  });

  it('keeps sends isolated per FixtureBackend instance', () => {
    const first = new FixtureBackend();
    const second = new FixtureBackend();
    first.sendThread(sendPayload({ thread_id: 't-isolated-0001', message: 'Only for this instance.' }), signal);
    first.sendThread(sendPayload({ message: 'Fixture thread send.' }), signal);

    expect(second.readThread({ thread_id: 't-isolated-0001' }, signal)).toBeNull();
    expect(second.readThread({ thread_id: 't-synth-0001' }, signal)?.messages).toEqual(bikeFixtureMessages);
  });
});

describe('threadSendInputSchema', () => {
  it('rejects a payload without an idempotency_token', () => {
    const { idempotency_token: _idempotency_token, ...rest } = sendPayload();
    expect(threadSendInputSchema.safeParse({ ...rest, extra: undefined }).success).toBe(false);
    expect(threadSendInputSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an idempotency_token shorter than 16 characters', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ idempotency_token: 'a12345678901234' })).success).toBe(false);
  });

  it('rejects an idempotency_token with invalid characters', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ idempotency_token: 'tok!abc123def456ghij' })).success).toBe(false);
    expect(threadSendInputSchema.safeParse(sendPayload({ idempotency_token: '.tok-abc123def456g' })).success).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ message: '' })).success).toBe(false);
  });

  it('rejects a message longer than 2000 characters', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ message: 'x'.repeat(2001) })).success).toBe(false);
  });

  it('rejects a message containing a newline', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ message: 'a\nb' })).success).toBe(false);
  });

  it('rejects a message containing a tab', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ message: 'a\tb' })).success).toBe(false);
  });

  it('accepts a message with unicode accents and emoji', () => {
    expect(threadSendInputSchema.safeParse(sendPayload({ message: 'Café — 🚲 à vendre' })).success).toBe(true);
  });

  it('rejects a payload with extra keys', () => {
    expect(threadSendInputSchema.safeParse({ ...sendPayload(), draft: true }).success).toBe(false);
  });

  it('accepts a valid payload', () => {
    expect(threadSendInputSchema.safeParse(sendPayload()).success).toBe(true);
    expect(threadSendInputSchema.safeParse(sendPayload({ idempotency_token: 'a123456789012345' })).success).toBe(true);
  });
});

describe('sendSuccessSchema / sendOutputSchema', () => {
  function successOutput(status: string) {
    return { ok: true, backend: 'fixture', thread_id: 't-synth-0001', status };
  }

  it('accepts status sent on both schemas', () => {
    expect(sendSuccessSchema.safeParse(successOutput('sent')).success).toBe(true);
    expect(sendOutputSchema.safeParse(successOutput('sent')).success).toBe(true);
  });

  it('accepts status unknown on both schemas', () => {
    expect(sendSuccessSchema.safeParse(successOutput('unknown')).success).toBe(true);
    expect(sendOutputSchema.safeParse(successOutput('unknown')).success).toBe(true);
    expect(sendDeliveryStatusSchema.safeParse('unknown').success).toBe(true);
  });

  it('rejects any delivery status other than sent or unknown', () => {
    for (const status of ['failed', 'pending', 'sent ', 'SENT']) {
      expect(sendSuccessSchema.safeParse(successOutput(status)).success).toBe(false);
      expect(sendOutputSchema.safeParse(successOutput(status)).success).toBe(false);
    }
  });
});
