/**
 * C-0006-B2 — identity backfill CLI (dry-run by default).
 *
 *   cd apps/api
 *   npx tsx src/tools/identity-backfill.ts                 # dry-run + stats
 *   npx tsx src/tools/identity-backfill.ts --apply         # writes (needs approval)
 *
 * Step 1 only allows measuring; `--apply` exists for Step 2 and must not be
 * used until the architecture review approves the switch.
 */

import { PrismaClient } from '@prisma/client';

import { applyIdentityBackfill, planIdentityBackfill } from '../services/canonical';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const orgIndex = process.argv.indexOf('--org');
    const organizationId = orgIndex === -1 ? undefined : process.argv[orgIndex + 1];
    const dryRun = !process.argv.includes('--apply');

    const plan = await planIdentityBackfill(prisma, organizationId ? { organizationId } : {});
    const result = await applyIdentityBackfill(prisma, plan, { dryRun });

    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: result.dryRun,
          scanned: plan.scanned,
          alreadyMapped: plan.alreadyMapped,
          plannedUpdates: plan.updates.length,
          updated: result.updated,
          unmapped: plan.unmapped,
          unmappedSamples: plan.unmappedSamples,
          canSwitch: plan.canSwitch,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
