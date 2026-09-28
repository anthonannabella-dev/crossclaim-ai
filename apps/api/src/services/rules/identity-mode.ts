/**
 * C-0006-B2 Step 3 — detection identity mode switch.
 * ---------------------------------------------------------------
 * Approved semantics:
 *   legacy    (default) : old dedupeKey decides idempotency, new identity is dual-written
 *   canonical           : canonicalDedupeKey decides idempotency; a missing
 *                         canonical identity is a hard failure
 *                         (`CANONICAL_IDENTITY_REQUIRED`) — never a silent
 *                         fallback to the old key.
 *
 * The mode is read from the trusted environment; callers may pass an explicit
 * value for tests.
 */

export type DetectionIdentityMode = 'legacy' | 'canonical';

export const DETECTION_IDENTITY_MODE_ENV = 'DETECTION_IDENTITY_MODE';

export function resolveDetectionIdentityMode(
  explicit?: DetectionIdentityMode,
): DetectionIdentityMode {
  if (explicit) return explicit;
  const env =
    typeof process === 'undefined' ? undefined : process.env[DETECTION_IDENTITY_MODE_ENV];
  return env === 'canonical' ? 'canonical' : 'legacy';
}

export class CanonicalIdentityRequiredError extends Error {
  readonly code = 'CANONICAL_IDENTITY_REQUIRED';
  readonly sourceTransactionId: string | null;

  constructor(sourceTransactionId: string | null) {
    super(
      `CANONICAL_IDENTITY_REQUIRED：canonical 模式下 sourceTransaction=${
        sourceTransactionId ?? 'null'
      } 没有可用的业务事实身份（缺少 ACTIVE CanonicalFact）；拒绝生成正式 RuleEvaluation`,
    );
    this.name = 'CanonicalIdentityRequiredError';
    this.sourceTransactionId = sourceTransactionId;
  }
}
