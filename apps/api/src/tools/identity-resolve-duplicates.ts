/**
 * C-0006-B2 Step 3 Final Gate — mark equivalent duplicates as resolved.
 *
 *   cd apps/api
 *   npx tsx src/tools/identity-resolve-duplicates.ts [--org <uuid>]
 *
 * Writes an audit event (`identity.duplicate_resolved`) per equivalent
 * duplicate and prints the resulting switch gate. It never deletes or
 * overwrites a RuleEvaluation.
 */

import { PrismaClient } from '@prisma/client';

import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { buildIdentitySwitchGate, resolveEquivalentDuplicates } from '../services/canonical';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const orgIndex = process.argv.indexOf('--org');
    const organizationId = orgIndex === -1 ? undefined : process.argv[orgIndex + 1];
    const salt = process.env.AUDIT_IP_SALT ?? process.env.STORAGE_URL_SECRET ?? '';
    if (salt.length < 16) {
      throw new Error('需要 AUDIT_IP_SALT（或 STORAGE_URL_SECRET）至少 16 位才能写审计');
    }
    const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: salt });

    const outcome = await resolveEquivalentDuplicates(
      prisma,
      audit,
      organizationId ? { organizationId } : {},
    );
    const gate = await buildIdentitySwitchGate(prisma, organizationId ? { organizationId } : {});
    process.stdout.write(`${JSON.stringify({ outcome, gate }, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
