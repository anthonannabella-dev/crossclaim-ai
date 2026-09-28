/**
 * C-0006-B2 Step 2 — identity parity report.
 * ---------------------------------------------------------------
 * Dual-write is only trustworthy when the old identity and the new identity
 * describe the same logical evaluation. This report answers:
 *   - how many evaluations already carry the business-fact identity (coverage)
 *   - are there duplicate canonical identities (two rows, one fact+rule)?
 *   - does every canonicalFactId still link back to the row's raw transaction?
 *   - which rows still have no canonical identity (never silently ignored)
 */

import type { PrismaClient } from '@prisma/client';

export interface IdentityParityReport {
  scanned: number;
  withCanonicalIdentity: number;
  withoutCanonicalIdentity: number;
  coverageRate: string;
  duplicateCanonicalIdentities: string[];
  factLinkMismatches: string[];
  withoutIdentitySamples: string[];
  parity: 'OK' | 'MISMATCH';
}

function rate(part: number, total: number): string {
  if (total === 0) return '1.0000';
  const scaled = (BigInt(part) * 10_000n) / BigInt(total);
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}`;
}

export async function buildIdentityParityReport(
  prisma: PrismaClient,
  input: { organizationId?: string } = {},
): Promise<IdentityParityReport> {
  const rows = await prisma.ruleEvaluation.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      sourceTransactionId: true,
      canonicalFactId: true,
      canonicalDedupeKey: true,
      dedupeKey: true,
    },
    orderBy: { evaluatedAt: 'asc' },
  });

  const withIdentity: typeof rows = [];
  const withoutIdentity: typeof rows = [];
  for (const row of rows) {
    if (row.canonicalFactId && row.canonicalDedupeKey) withIdentity.push(row);
    else withoutIdentity.push(row);
  }

  const byKey = new Map<string, string[]>();
  for (const row of withIdentity) {
    const key = row.canonicalDedupeKey as string;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row.id);
    else byKey.set(key, [row.id]);
  }
  const duplicates = [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key]) => key);

  const links = await prisma.canonicalFactSource.findMany({
    where: {
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      canonicalFactId: { in: withIdentity.map((row) => row.canonicalFactId as string) },
    },
    select: { canonicalFactId: true, sourceTransactionId: true },
  });
  const linkSet = new Set(links.map((link) => `${link.canonicalFactId}|${link.sourceTransactionId}`));

  const mismatches: string[] = [];
  for (const row of withIdentity) {
    const key = `${row.canonicalFactId}|${row.sourceTransactionId ?? ''}`;
    if (!row.sourceTransactionId || !linkSet.has(key)) mismatches.push(row.id);
  }

  return {
    scanned: rows.length,
    withCanonicalIdentity: withIdentity.length,
    withoutCanonicalIdentity: withoutIdentity.length,
    coverageRate: rate(withIdentity.length, rows.length),
    duplicateCanonicalIdentities: duplicates,
    factLinkMismatches: mismatches,
    withoutIdentitySamples: withoutIdentity.slice(0, 20).map((row) => row.id),
    parity: duplicates.length === 0 && mismatches.length === 0 ? 'OK' : 'MISMATCH',
  };
}
