import { createHash } from 'node:crypto';
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
