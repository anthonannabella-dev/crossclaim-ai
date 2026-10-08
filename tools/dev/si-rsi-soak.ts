/**
 * PHASE 3 / R9-11 —— SI/RSI **连续运行 soak 取证器**（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 审计要求（MSG-20261009-02 / MSG-20261009-03）：
 *   · R9-11：真实 PostgreSQL **连续运行 60 分钟**，无任务永久卡死（"永久卡死"由**停滞检测**判定：
 *     仍有 READY/IN_PROGRESS 任务但连续 N 轮零收口 ⇒ 记为 STALL）；
 *   · R9-12：**不替换**被测路径 —— 全部走既有 `composeRsiRuntime()` + durable 任务源 + 生产 Recovery pack + 既有 verdictWatcher；
 *   · 禁止用缩短租约 TTL 掩盖问题；不得新增第二套 runtime / scheduler / controller。
 *
 * 性质：**一次性**脚本（跑满 `--minutes` 即退出、写证据、返回退出码）；无定时器守护、无服务端进程。
 * 只操作独立 `soak-org-*` 租户；结束时按 lease → task → incident 顺序清理自己创建的数据。
 *
 * 用法（cwd = 仓库根）：
 *   node apps/api/node_modules/tsx/dist/cli.mjs tools/dev/si-rsi-soak.ts --minutes 60 --label r9-11-60m
 *   node apps/api/node_modules/tsx/dist/cli.mjs tools/dev/si-rsi-soak.ts --minutes 2  --label r9-11-smoke
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const API_DIR = path.resolve(import.meta.dirname, '../../apps/api');
const requireFromApi = createRequire(path.join(API_DIR, 'package.json'));
const { PrismaClient } = requireFromApi('@prisma/client') as { PrismaClient: new () => any };

/**
 * 被测模块（既有产品路径）以**动态 import** 载入。
 * tsx 在本仓库根按 CJS 转译 ⇒ 不能用顶层 await，故统一在 `loadModules()` 里加载。
 */
type SoakModules = {
  mod: typeof import('../../apps/api/src/runtime/rsi-run');
  ds: typeof import('../../apps/api/src/runtime/rsi-durable-task-source');
  comp: typeof import('../../apps/api/src/runtime/recovery-si-production-composition');
  rec: typeof import('../../apps/api/src/runtime/recovery-domain-outcome-recorder');
  st: typeof import('../../apps/api/src/runtime/recovery-verdict-settlement');
  qp: typeof import('../../apps/api/src/services/agent-goal/prisma-task-queue-port');
};
let M: SoakModules | null = null;
const loadModules = async (): Promise<SoakModules> => ({
  mod: await import(pathToFileURL(path.join(API_DIR, 'src/runtime/rsi-run.ts')).href),
  ds: await import(pathToFileURL(path.join(API_DIR, 'src/runtime/rsi-durable-task-source.ts')).href),
  comp: await import(pathToFileURL(path.join(API_DIR, 'src/runtime/recovery-si-production-composition.ts')).href),
  rec: await import(pathToFileURL(path.join(API_DIR, 'src/runtime/recovery-domain-outcome-recorder.ts')).href),
  st: await import(pathToFileURL(path.join(API_DIR, 'src/runtime/recovery-verdict-settlement.ts')).href),
  qp: await import(pathToFileURL(path.join(API_DIR, 'src/services/agent-goal/prisma-task-queue-port.ts')).href),
});
const R = (): SoakModules => {
  if (M === null) throw new Error('SOAK_MODULES_NOT_LOADED');
  return M;
};

// 载入 apps/api/.env（缺 DATABASE_URL 时），只读、不打印取值
const envPath = path.join(API_DIR, '.env');
if ((process.env.DATABASE_URL ?? '') === '' && existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? String(args[index + 1]) : fallback;
};
const minutes = Math.max(1, Number(argOf('minutes', '60')));
const roundSeconds = Math.max(2, Number(argOf('round-seconds', '10')));
const batchSize = Math.max(1, Number(argOf('batch', '2')));
const workerCount = Math.max(1, Number(argOf('workers', '3')));
const label = argOf('label', `r9-11-${minutes}m`);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const logsDir = path.join(repoRoot, 'tools/dev/logs/si-rsi-soak');
const summaryPath = path.join(logsDir, `${label}-summary.json`);
mkdirSync(logsDir, { recursive: true });

const prisma = new PrismaClient();
const ORG = `soak-org-${randomUUID().slice(0, 8)}`;
const T0 = new Date();
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const databaseMarker = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}:${url.port === '' ? '5432' : url.port}${url.pathname}`;
  } catch {
    return 'DB_MARKER_UNAVAILABLE';
  }
})();

const tasks: { taskId: string; dedupeKey: string; opportunityRef: string }[] = [];
const faults: string[] = [];
const rounds: { round: number; admitted: number; settledTotal: number; active: number; pending: number }[] = [];
let invariantViolations: string[] = [];
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('SOAK_SIGINT -> 本轮结束后收尾并写证据');
});

async function seedTenant(): Promise<void> {
  await prisma.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: 'soak-acct',
      provider: 'AMAZON',
      allowedActionTypes: ['recovery.read'],
      monetaryLimitUsd: '0',
      currency: 'USD',
      domain: 'LOGISTICS',
      jurisdiction: 'US',
      effectiveAt: new Date(T0.getTime() - 60_000),
      expiresAt: new Date(T0.getTime() + 24 * 3600 * 1000),
      authorizationVersion: 1,
      termsPolicyVersion: 'v1',
      consentEvidenceRef: 'evidence://soak-seed',
      scopeDigest: 'a'.repeat(64),
      revocationState: 'ACTIVE',
      createdAt: T0,
    },
  });
}

async function admitBatch(round: number): Promise<number> {
  for (let i = 0; i < batchSize; i += 1) {
    const opportunityRef = `${ORG}-${round}-${i}`;
    await prisma.recoveryOpportunity.create({
      data: {
        id: opportunityRef,
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'FEDEX',
        status: 'DETECTED',
        opportunityType: 'RATE_DISCREPANCY',
        title: 'soak ' + opportunityRef,
        amountExpected: '100.0000',
        amountActual: '150.0000',
        recoverableAmount: '50.0000',
        currency: 'USD',
        detectedAt: T0,
        createdAt: T0,
      },
    });
    const dedupeKey = 'task:recovery:LOGISTICS:' + opportunityRef;
    await R().qp.createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: ORG,
      tasks: [
        {
          domain: 'LOGISTICS',
          dedupeKey,
          candidateActions: [],
          autoExecutableActions: [],
          blockedActions: [],
          executionMode: 'AUTO_WHEN_AUTHORIZED',
          requiresStandingAuthorizationForAutoExecution: true,
        },
      ],
    });
    const row = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey }, select: { id: true } });
    tasks.push({ taskId: row.id, dedupeKey, opportunityRef });
  }
  return batchSize;
}

async function composeWorker(ownerRef: string, readCounts: Map<string, number>) {
  let verdictSeq = 0;
  const packDeps = R().comp.createProductionRecoveryPackDeps({ prisma });
  const readPorts = {
    ...packDeps.readPorts,
    async opportunityRead(portInput: { organizationId: string; opportunityRef: string }) {
      readCounts.set(portInput.opportunityRef, (readCounts.get(portInput.opportunityRef) ?? 0) + 1);
      return packDeps.readPorts.opportunityRead(portInput);
    },
  };
  const taskSource = R().ds.createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 });
  const settlement = R().st.createRecoveryVerdictSettlement({ prisma, taskSource, ownerRef, now: () => T0 });
  const composition = await R().mod.composeRsiRuntime({
    readFile: async (p: string) => {
      if (p !== 'mem://verdict') return '[]';
      verdictSeq += 1;
      return JSON.stringify({ messageId: `${ownerRef}-msg-${verdictSeq}`, verdict: 'PASS' });
    },
    verdictPath: 'mem://verdict',
    verdictWatch: { intervalMs: 10_000 },
    intervalMs: 50,
    runtimeOwnerRef: ownerRef,
    taskSource,
    productRecoveryPack: { ...packDeps, readPorts },
    recoveryVerdictSettlement: settlement,
    onDomainPackEvidence: (record: unknown) =>
      R().rec.createRecoveryDomainOutcomeRecorder({ prisma, now: () => T0 }).record(record as never).then(() => undefined),
  });
  return { ownerRef, composition, taskSource };
}

async function cleanup(): Promise<void> {
  const ids = tasks.map((task) => task.taskId);
  await prisma.autonomyLease.deleteMany({ where: { taskId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.autonomyTask.deleteMany({ where: { id: { in: ids } } });
  const incidents = await prisma.autonomyIncident.findMany({
    where: { dedupeKey: `customer-goal-queue:${ORG}` },
    select: { id: true },
  });
  for (const incident of incidents) {
    const remaining = await prisma.autonomyTask.count({ where: { incidentId: incident.id } });
    if (remaining === 0) await prisma.autonomyIncident.delete({ where: { id: incident.id } });
  }
  await prisma.recoveryOpportunity.deleteMany({ where: { organizationId: ORG } });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

const startedAt = new Date();
const deadline = startedAt.getTime() + minutes * 60_000;
const readCounts = new Map<string, number>();
const main = async (): Promise<void> => {
  console.log(`SOAK_START label=${label} minutes=${minutes} workers=${workerCount} batch=${batchSize} roundSeconds=${roundSeconds} db=${databaseMarker} org=${ORG}`);
  await seedTenant();
  const workers = await Promise.all(
    Array.from({ length: workerCount }, (_, i) => composeWorker(`soak-w${i + 1}`, readCounts)),
  );

  let round = 0;
  let lastSettled = 0;
  let stallRounds = 0;
  const MAX_STALL_ROUNDS = Math.max(6, Math.ceil(120 / roundSeconds)); // 连续 2 分钟无进展即记 STALL

  try {
    while (Date.now() < deadline && !stopping) {
      round += 1;
      /**
       * 收尾策略：最后 30 秒**不再 admit 新任务**，让在飞任务排空；
       * 主循环结束后还有一次有界 drain（见下），避免把"刚 admit 的在飞任务"误判为卡死。
       */
      const admitting = Date.now() < deadline - 30_000;
      const admitted = admitting ? await admitBatch(round) : 0;
      await Promise.all(
        workers.map(async (worker) => {
          await worker.composition.controller.tick();
          await worker.composition.verdictWatcher.pollOnce();
        }),
      );

      // 故障注入：每 7 轮「INTENT 后崩溃 → 恢复」；每 13 轮重启一个 worker（不新增实例）
      if (round % 7 === 0) {
        const pending = tasks.filter(async () => true).slice(-1)[0];
        if (pending !== undefined) {
          await prisma.auditLog.create({
            data: {
              organizationId: ORG,
              actorType: 'SYSTEM',
              actorRef: 'soak:fault-injection',
              action: R().st.RECOVERY_SETTLEMENT_INTENT_ACTION,
              entityType: 'AutonomyTask',
              entityId: pending.taskId,
              changes: {
                dedupeKey: pending.dedupeKey,
                ownerRef: 'soak-fault',
                verdict: 'PASS',
                verdictRef: `soak-fault-${round}`,
                intentKey: `${pending.taskId}|soak-fault-${round}`,
                recordedAt: new Date().toISOString(),
              },
            },
          });
          const settlement = R().st.createRecoveryVerdictSettlement({
            prisma,
            taskSource: R().ds.createAutonomyTaskSource({ prisma, ownerRef: 'soak-fault' }),
            now: () => T0,
          });
          const resumed = await settlement.resumePendingSettlements(ORG);
          faults.push(`F1_INTENT_RESUME round=${round} resumed=${resumed.length}`);
        }
      }
      if (round % 13 === 0) {
        const worker = workers[round % workers.length]!;
        worker.composition.stop();
        const rebuilt = await composeWorker(worker.ownerRef, readCounts);
        workers[workers.indexOf(worker)] = rebuilt;
        faults.push(`F2_WORKER_RESTART round=${round} owner=${worker.ownerRef}`);
      }

      const [settledTotal, active, pendingCount] = await Promise.all([
        prisma.auditLog.count({ where: { organizationId: ORG, action: R().st.RECOVERY_SETTLEMENT_APPLIED_ACTION } }),
        prisma.autonomyLease.count({ where: { taskId: { in: tasks.map((t) => t.taskId) }, status: 'ACTIVE' } }),
        prisma.autonomyTask.count({
          where: { id: { in: tasks.map((t) => t.taskId) }, status: { in: ['READY', 'IN_PROGRESS'] } },
        }),
      ]);
      rounds.push({ round, admitted, settledTotal, active, pending: pendingCount });
      if (settledTotal === lastSettled && pendingCount > 0) stallRounds += 1;
      else stallRounds = 0;
      lastSettled = settledTotal;
      if (stallRounds >= MAX_STALL_ROUNDS) {
        invariantViolations.push(`STALL round=${round} pending=${pendingCount} settled=${settledTotal}`);
        console.log(`SOAK_STALL round=${round} pending=${pendingCount} settled=${settledTotal}`);
        break;
      }
      console.log(`SOAK_ROUND round=${round} admitted=${admitted} settled=${settledTotal} active=${active} pending=${pendingCount}`);
      await sleep(roundSeconds * 1000);
    }

    // ---- 有界 drain：主循环结束后继续推进，直到没有 pending/active 或到达上限（不 admit 新任务）----
    const drainDeadline = Date.now() + Math.max(60_000, (batchSize * 4 * 1000));
    for (;;) {
      const [pendingNow, activeNow] = await Promise.all([
        prisma.autonomyTask.count({
          where: { id: { in: tasks.map((t) => t.taskId) }, status: { in: ['READY', 'IN_PROGRESS'] } },
        }),
        prisma.autonomyLease.count({ where: { taskId: { in: tasks.map((t) => t.taskId) }, status: 'ACTIVE' } }),
      ]);
      if ((pendingNow === 0 && activeNow === 0) || Date.now() > drainDeadline) break;
      round += 1;
      await Promise.all(
        workers.map(async (worker) => {
          await worker.composition.controller.tick();
          await worker.composition.verdictWatcher.pollOnce();
        }),
      );
      await sleep(Math.max(250, roundSeconds * 200));
    }
  } finally {
    for (const worker of workers) worker.composition.stop();
  }

  // ---- 结束态不变量 ----
  const ids = tasks.map((task) => task.taskId);
  const taskRows = await prisma.autonomyTask.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, dedupeKey: true },
  });
  const nonTerminal = taskRows.filter((row) => row.status !== 'BLOCKED');
  const activeLeases = await prisma.autonomyLease.count({ where: { taskId: { in: ids }, status: 'ACTIVE' } });
  const applied = await prisma.auditLog.count({ where: { organizationId: ORG, action: R().st.RECOVERY_SETTLEMENT_APPLIED_ACTION } });
  const intents = await prisma.auditLog.count({ where: { organizationId: ORG, action: R().st.RECOVERY_SETTLEMENT_INTENT_ACTION } });
  const duplicateApplied = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM (SELECT "entityId" FROM "AuditLog" WHERE organization_id = '${ORG}' AND action = '${R().st.RECOVERY_SETTLEMENT_APPLIED_ACTION}' GROUP BY 1 HAVING count(*) > 1) t`,
  ).catch(() => [{ n: -1 }]);
  const externalWrites =
    (await prisma.claim.count({ where: { organizationId: ORG } })) +
    (await prisma.payment.count({ where: { organizationId: ORG } })) +
    (await prisma.settlement.count({ where: { organizationId: ORG } })) +
    (await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })) +
    (await prisma.billingInvoice.count({ where: { organizationId: ORG } })) +
    (await prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }));
  const doubleExecuted = [...readCounts.entries()].filter(([, count]) => count > 1);

  if (nonTerminal.length > 0) invariantViolations.push(`NON_TERMINAL_TASKS n=${nonTerminal.length}`);
  if (activeLeases !== 0) invariantViolations.push(`LEFTOVER_ACTIVE_LEASES n=${activeLeases}`);
  if (externalWrites !== 0) invariantViolations.push(`EXTERNAL_WRITE_ROWS n=${externalWrites}`);
  if (doubleExecuted.length > 0) invariantViolations.push(`DOMAIN_STEP_DUPLICATED n=${doubleExecuted.length}`);
  if (Number(duplicateApplied[0]?.n ?? 0) > 0) invariantViolations.push('DUPLICATE_APPLIED');

  const finishedAt = new Date();
  const summary = {
    label,
    minutes,
    roundSeconds,
    workers: workerCount,
    batchSize,
    databaseMarker,
    soakOrganizationId: ORG,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    rounds: rounds.length,
    tasksAdmitted: tasks.length,
    settlementsApplied: applied,
    settlementIntents: intents,
    tasksTerminal: taskRows.length - nonTerminal.length,
    nonTerminalTasks: nonTerminal.map((row) => ({ id: row.id, status: row.status })),
    activeLeases,
    externalWriteRows: externalWrites,
    domainStepDoubleExecutions: doubleExecuted.length,
    faultsInjected: faults,
    invariantViolations,
    result: invariantViolations.length === 0 ? 'SOAK_PASS' : 'SOAK_FAILED',
    roundDetail: rounds.slice(-60),
    note: 'R9-11 连续运行取证：全部走既有 composeRsiRuntime()/durable 源/生产 pack/既有 verdictWatcher；未替换被测路径（R9-12）；未缩短租约 TTL；无第二套 runtime/scheduler/controller',
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  await cleanup();
  await prisma.$disconnect();
  console.log(`SOAK_RESULT=${summary.result} rounds=${summary.rounds} tasks=${tasks.length} settled=${applied} violations=${invariantViolations.length}`);
  console.log(`SOAK_SUMMARY=${path.relative(repoRoot, summaryPath).replace(/\\/g, '/')}`);
  if (invariantViolations.length > 0) {
    console.log('SOAK_VIOLATIONS=' + JSON.stringify(invariantViolations));
    process.exit(1);
  }
  process.exit(0);
};

void (async () => { M = await loadModules(); await main(); })().catch(async (error: unknown) => {
  console.error('SOAK_ERROR ' + String((error as Error)?.message ?? error));
  try {
    await cleanup();
    await prisma.$disconnect();
  } catch {
    /* 清理失败不改变退出码语义 */
  }
  process.exit(2);
});
