/**
 * HISTORICAL_RECOVERY_SCAN_V1 / PHASE 14 —— **acceptance-only** 扫描数据种子（dev/test）。
 * ---------------------------------------------------------------
 * 用途：浏览器验收旅程需要一条真实的 durable 扫描结果来渲染只读结果页
 *       `/recoveries/scans/:id`。本脚本**只调用既有的 server-owned 链路**：
 *         compileAgentGoal / validateAgentGoalDraft（Goal 确定性编译）
 *         → createOrGetRecoveryScan（PHASE 2 durable 扫描）
 *         → claimRecoveryScanRun + runHistoricalBackfill（PHASE 6 分片回填，synthetic 端口）
 *       不新增 runtime / scheduler / 第二事实源，不产生任何外部动作。
 *
 * 用法：npx tsx acceptance/seed-recovery-scan.ts --email customer@example.com
 * 输出：SCAN_ID=<id>（供 journey 拼接 URL）
 */

import { PrismaClient } from '@prisma/client';

import { compileAgentGoal } from '../src/services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../src/services/agent-goal/goal-validator';
import {
  claimRecoveryScanRun,
  createOrGetRecoveryScan,
  runHistoricalBackfill,
} from '../src/services/historical-scan';
import { evaluateCustomsHistoricalBatch } from '../src/services/historical-scan/customs-historical-pipeline';

const prisma = new PrismaClient();

/**
 * 每次运行使用**唯一** Goal 文本 → 唯一 goalDigest / goalId / scan 身份，
 * 避免上一次验收运行的 durable 行（属于上一个临时组织）与本轮组织冲突。
 */
const RUN_STAMP = Date.now().toString(36);
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理（验收 ' + RUN_STAMP + '）';
const NOW = new Date();
const SOURCE_FROM = '2025-10-08';

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : null;
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const COMPLETE_CHAIN = { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] };

function syntheticRecord(entryNumber: string, organizationId: string, kind: 'PERFECT' | 'NO_EVIDENCE' | 'SPECIAL_PROVISION') {
  return {
    entryNumber,
    scope: { organizationId, platformAccountId: 'acct-acceptance' },
    hts: kind === 'SPECIAL_PROVISION' ? '9801.00.1012' : '8471.30.0100',
    jurisdiction: 'US',
    entryDate: '2025-01-01',
    liquidationDate: '2025-06-01',
    exportDate: '2026-06-01',
    destructionDate: null,
    evidenceChain: kind === 'NO_EVIDENCE' ? null : COMPLETE_CHAIN,
    counterpartMatch: { status: 'EXACT' },
    verifiedDeadlinePolicy: {
      policyId: 'us-drawback-v1',
      policyVersion: '1.0.0',
      anchorField: 'exportDate',
      daysFromAnchor: 1825,
      verification: 'LEGAL_VERIFIED',
    },
    requestFiling: false,
    now: NOW,
    historicalWindow: { blocksClaimReady: false, reasonCodes: ['FULL_COVERAGE'] },
  };
}

async function main(): Promise<void> {
  const email = argValue('--email');
  if (email === null) throw new Error('SEED_RECOVERY_SCAN_EMAIL_REQUIRED');

  const user = await prisma.user.findFirst({ where: { email } });
  if (user === null) throw new Error('SEED_RECOVERY_SCAN_USER_NOT_FOUND:' + email);
  const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (membership === null) throw new Error('SEED_RECOVERY_SCAN_MEMBERSHIP_NOT_FOUND');
  const organizationId = membership.organizationId;
  console.log('SEED_ORG=' + organizationId + ' ROLE=' + membership.role + ' EMAIL=' + email);

  const compiled = compileAgentGoal({ text: INTENT });
  if (!compiled.ok) throw new Error('SEED_RECOVERY_SCAN_COMPILE_FAILED');
  const validated = validateAgentGoalDraft({
    draft: compiled.draft,
    context: { organizationId, actorUserId: user.id, now: NOW },
  });

  // Goal 行必须落在**本组织**内：`validated.goalId` 是确定性 id（不含组织），跨运行会命中上一轮的旧行，
  // 因此这里追加本次运行 stamp 生成唯一 id（AgentGoal.id 为 String，允许显式赋值）。
  const goalId = validated.goalId + '-acc-' + RUN_STAMP;
  await prisma.agentGoal.create({
    data: {
      id: goalId,
      organizationId,
      createdBy: user.id,
      rawUserIntent: INTENT,
      normalizedGoal: { version: validated.version, goalDigest: validated.goalDigest },
      status: 'ADMITTED',
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const requestedTo = dayString(NOW);
  const created = await createOrGetRecoveryScan(prisma, {
    organizationId,
    goalId,
    goalDigest: validated.goalDigest,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: null,
    requestedFrom: '2021-10-08',
    requestedTo,
    effectiveFrom: SOURCE_FROM,
    effectiveTo: requestedTo,
    requestedMonths: 60,
  });

  const claimed = await claimRecoveryScanRun(prisma, {
    organizationId,
    scanId: created.row.id,
    leaseOwner: 'acceptance-seed',
    leaseExpiresAt: new Date(NOW.getTime() + 600_000),
    now: NOW,
  });
  if (claimed === null && created.created === false) {
    // 已存在的扫描可能已被认领/完成——直接复用其当前状态
    console.log('SCAN_ID=' + created.row.id);
    return;
  }

  const result = await runHistoricalBackfill(prisma, {
    organizationId,
    scanId: created.row.id,
    pagePort: {
      async fetchPage({ shard }) {
        return {
          records: [
            syntheticRecord('ACC-' + shard.key + '-A', organizationId, 'PERFECT'),
            syntheticRecord('ACC-' + shard.key + '-B', organizationId, 'NO_EVIDENCE'),
            syntheticRecord('ACC-' + shard.key + '-C', organizationId, 'SPECIAL_PROVISION'),
          ],
          nextCursor: null,
          coverageFrom: SOURCE_FROM,
          coverageTo: requestedTo,
          coverageStatus: 'SOURCE_LIMITED' as const,
        };
      },
    },
    ingestPort: {
      async ingest({ records }) {
        const batch = evaluateCustomsHistoricalBatch(records as never);
        return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
      },
    },
    maxPages: 3,
  });
  console.log('SCAN_ID=' + created.row.id);
  console.log('SCAN_STATUS=' + result.status);
}

main()
  .catch((error: unknown) => {
    console.error('SEED_RECOVERY_SCAN_FAILED ' + String((error as Error)?.message ?? error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
