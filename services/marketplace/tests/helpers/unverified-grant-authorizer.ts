import {
  approvalGrantSchema,
  type ActionAuthorizer,
  type ActionRequest,
  type AuthorizationDecision
} from '../../src/authorization.js';

/**
 * Test-only grant verifier. It checks grant structure, scope, payload digest,
 * expiry, and single-use consumption — but it does NOT establish that anyone
 * actually approved the action: any well-formed grant with matching fields is
 * accepted on first use. It exists to exercise the verifier mechanics the
 * contract describes. The production verifier that authenticates grant
 * issuance is `HmacGrantAuthorizer` (#63), which verifies a shared-secret
 * HMAC-SHA256 signature over the canonical grant form before any scope,
 * expiry, or consumption check. This test double must still never be wired
 * into a production service.
 */
export class UnverifiedGrantAuthorizer implements ActionAuthorizer {
  private readonly consumedGrantIds = new Set<string>();
  private readonly now: () => Date;

  constructor(options?: { readonly now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  authorize(request: ActionRequest, grant: unknown): AuthorizationDecision {
    const parsed = approvalGrantSchema.safeParse(grant);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'APPROVAL_REQUIRED',
        message: 'A valid approval grant is required for this action.'
      };
    }

    const approved = parsed.data;
    if (
      approved.provider !== request.provider ||
      approved.account !== request.account ||
      approved.surface !== request.surface ||
      approved.action !== request.action ||
      approved.subject_digest !== request.subjectDigest
    ) {
      return {
        ok: false,
        code: 'ACTION_FORBIDDEN',
        message: 'The presented grant does not authorize this action.'
      };
    }

    if (Date.parse(approved.expires_at) <= this.now().getTime()) {
      return { ok: false, code: 'ACTION_FORBIDDEN', message: 'The approval grant has expired.' };
    }

    if (this.consumedGrantIds.has(approved.grant_id)) {
      return { ok: false, code: 'ACTION_FORBIDDEN', message: 'The approval grant has already been used.' };
    }

    this.consumedGrantIds.add(approved.grant_id);
    return { ok: true };
  }
}
