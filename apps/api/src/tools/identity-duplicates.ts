/**
 * C-0006-B2 Step 3 前置 — duplicate-resolution-report CLI (read-only).
 *
 *   cd apps/api
 *   npx tsx src/tools/identity-duplicates.ts [--org <uuid>]
 */

import { PrismaClient } from '@prisma/client';

import { buildDuplicateResolutionReport } from '../services/canonical';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const orgIndex = process.argv.indexOf('--org');
    const organizationId = orgIndex === -1 ? undefined : process.argv[orgIndex + 1];
    const report = await buildDuplicateResolutionReport(
      prisma,
      organizationId ? { organizationId } : {},
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
