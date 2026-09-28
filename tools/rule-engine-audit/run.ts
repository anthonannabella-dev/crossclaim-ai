/**
 * C-0012 Rule Engine Audit — CLI（只读；产物落 reports/）。
 * 用法（在 apps/api 目录下运行，那里已装 tsx）：
 *   cd apps/api
 *   npx tsx ../../tools/rule-engine-audit/run.ts --org <organizationId> [--role OWNER] [--out reports]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildRuleEngineAudit,
  createRuleEngineAuditClient,
  renderRuleEngineAuditMarkdown,
} from '../../apps/api/src/services/audit/rule-engine-audit';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const organizationId = arg('--org');
if (!organizationId) {
  console.error('usage: npx tsx ../../tools/rule-engine-audit/run.ts --org <organizationId> [--role OWNER] [--out reports]');
  process.exit(2);
}
const role = arg('--role', 'OWNER') as string;
const outDir = arg('--out', 'reports') as string;

/**
 * apps/api 的 package.json 是 CommonJS，所以这里不用顶层 await：
 * 用 async main() + catch 保证 tsx 在 CJS 输出格式下也能运行。
 */
async function main(): Promise<void> {
  const prisma = createRuleEngineAuditClient();
  try {
    const audit = await buildRuleEngineAudit(prisma, { organizationId: organizationId as string, role });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'C-0012-rule-engine-audit.json'), JSON.stringify(audit, null, 2), 'utf8');
    writeFileSync(path.join(outDir, 'C-0012-rule-engine-audit.md'), renderRuleEngineAuditMarkdown(audit), 'utf8');

    console.log(`engineeringStatus   : ${audit.engineeringStatus}`);
    console.log(`auditRunStatus      : ${audit.auditRunStatus}`);
    console.log(`commercialConclusion: ${audit.commercialConclusion}`);
    console.log(
      `residuals           : NO_HUMAN_REVIEW=${audit.residuals.classification.NO_HUMAN_REVIEW} ` +
        `CONFIRMED=${audit.residuals.classification.CONFIRMED} ADJUSTED=${audit.residuals.classification.ADJUSTED}`,
    );
    console.log(`driftPairs          : ${audit.drift.changedPairs.length}`);
    console.log(`staleRules          : ${audit.freshness.staleRuleCount} (threshold ${audit.freshness.thresholdDays}d)`);
    console.log(`out                 : ${outDir}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
