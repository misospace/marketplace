import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const ACTION_RISK_CLASSES = ['read', 'prepare', 'send', 'high_consequence'] as const;
export type ActionRiskClass = typeof ACTION_RISK_CLASSES[number];

export interface ActionScope {
  readonly provider: string;
  readonly account: string;
  readonly surface: string;
}

export interface ActionDefinition {
  readonly riskClass: ActionRiskClass;
  readonly scope: ActionScope;
}

export const approvalGrantSchema = z.object({
  grant_id: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  provider: z.string().min(1).max(64).regex(/\S/),
  account: z.string().min(1).max(128).regex(/\S/),
  surface: z.string().min(1).max(64).regex(/\S/),
  action: z.string().min(1).max(64).regex(/\S/),
  subject_digest: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: z.string().datetime({ offset: true })
}).strict();

export type ApprovalGrant = z.infer<typeof approvalGrantSchema>;

export const signedGrantEnvelopeSchema = z
  .object({
    grant: approvalGrantSchema,
    signature: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

export type SignedGrantEnvelope = z.infer<typeof signedGrantEnvelopeSchema>;

export function canonicalActionInput(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${Array.from(value, canonicalActionInput).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalActionInput(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function subjectDigest(value: unknown): string {
  return createHash('sha256').update(canonicalActionInput(value), 'utf8').digest('hex');
}

export interface ActionRequest extends ActionScope {
  readonly action: string;
  readonly subjectDigest: string;
}

export type AuthorizationFailureCode = 'APPROVAL_REQUIRED' | 'ACTION_FORBIDDEN';

export type AuthorizationDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AuthorizationFailureCode; readonly message: string };

export interface ActionAuthorizer {
  authorize(request: ActionRequest, grant: unknown): AuthorizationDecision;
}

export class DenyAllAuthorizer implements ActionAuthorizer {
  authorize(_request: ActionRequest, _grant: unknown): AuthorizationDecision {
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      message: 'No approval authority is configured for write actions.'
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class HmacGrantAuthorizer implements ActionAuthorizer {
  private readonly secret: string;
  private readonly consumedGrantIds = new Set<string>();
  private readonly now: () => Date;

  constructor(options: { readonly secret: string; readonly now?: () => Date }) {
    if (typeof options.secret !== 'string' || options.secret.length < 32) {
      throw new TypeError('secret must be a string of at least 32 characters');
    }
    this.secret = options.secret;
    this.now = options.now ?? (() => new Date());
  }

  authorize(request: ActionRequest, grant: unknown): AuthorizationDecision {
    const parsed = signedGrantEnvelopeSchema.safeParse(grant);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'APPROVAL_REQUIRED',
        message: 'A valid approval grant is required for this action.'
      };
    }

    const envelope = parsed.data;
    const expected = createHmac('sha256', this.secret)
      .update(canonicalActionInput(envelope.grant), 'utf8')
      .digest('hex');
    if (!constantTimeEqual(expected, envelope.signature)) {
      return {
        ok: false,
        code: 'ACTION_FORBIDDEN',
        message: 'The presented grant does not carry a valid issuer signature.'
      };
    }

    if (
      envelope.grant.provider !== request.provider ||
      envelope.grant.account !== request.account ||
      envelope.grant.surface !== request.surface ||
      envelope.grant.action !== request.action ||
      envelope.grant.subject_digest !== request.subjectDigest
    ) {
      return {
        ok: false,
        code: 'ACTION_FORBIDDEN',
        message: 'The presented grant does not authorize this action.'
      };
    }

    if (Date.parse(envelope.grant.expires_at) <= this.now().getTime()) {
      return { ok: false, code: 'ACTION_FORBIDDEN', message: 'The approval grant has expired.' };
    }

    if (this.consumedGrantIds.has(envelope.grant.grant_id)) {
      return { ok: false, code: 'ACTION_FORBIDDEN', message: 'The approval grant has already been used.' };
    }

    this.consumedGrantIds.add(envelope.grant.grant_id);
    return { ok: true };
  }
}

export function authorizeAction(
  definition: ActionDefinition,
  request: ActionRequest,
  authorizer: ActionAuthorizer,
  grant: unknown
): AuthorizationDecision {
  switch (definition.riskClass) {
    case 'read':
    case 'prepare':
      return { ok: true };
    case 'high_consequence':
      return { ok: false, code: 'ACTION_FORBIDDEN', message: 'High-consequence actions are not enabled.' };
    case 'send':
      return authorizer.authorize(request, grant);
  }
}
