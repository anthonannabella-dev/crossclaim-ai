/**
 * C-0006-B2 — business fact identity key.
 * ---------------------------------------------------------------
 * Kept dependency-free (no import from ../rules) so the detection repository
 * can dual-write the new identity without creating an import cycle.
 */

import { createHash } from 'node:crypto';

export function canonicalDedupeKeyFor(input: {
  organizationId: string;
  ruleVersionId: string;
  canonicalFactId: string;
}): string {
  return createHash('sha256')
    .update([input.organizationId, input.ruleVersionId, input.canonicalFactId].join('|'), 'utf8')
    .digest('hex');
}
