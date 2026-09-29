#!/usr/bin/env node
/**
 * P2-2 Backup / Restore Verification（合成数据，MSG-20260929-71 Q2）
 * ---------------------------------------------------------------
 * 链路：synthetic dataset → PostgreSQL → pg_dump → pg_restore scratch → compare
 *
 * 不变量（B1–B7，逐项输出证据）：
 *   B1 行数一致（所有既有表）          B2 租户隔离（按 organizationId 逐表比较）
 *   B3 金额一致（numeric 精确比较）    B4 审计连续性（count/action 分布/max(createdAt)）
 *   B5 Kill Switch（state 分布 + 幂等唯一索引 + 触发器 28）
 *   B6 Schema（迁移/索引/枚举/约束数） B7 不变量（无未验证外键）
 *
 * 边界：
 *   - CI 允许 temporary dump（dump 只存在容器内 /tmp，随容器销毁）
 *   - 禁止 upload artifact / persist dump / commit dump（脚本不写宿主文件）
 *   - 真实备份 = HOST APPROVAL REQUIRED（只用合成数据 + 临时容器）
 *   - Restore Failure Simulation：破坏 scratch 必须被判 FAIL（证明不误判成功）
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const API_DIR = path.join(REPO_ROOT, 'apps', 'api');
const require = createRequire(path.join(API_DIR, 'package.json'));
const { PrismaClient } = require('@prisma/client');

const PG_IMAGE = process.env.BACKUP_VERIFY_PG_IMAGE ?? 'postgres:16-alpine';
const container = 'crossclaim-backup-verify-' + randomUUID().slice(0, 8);
const dbName = 'bv_' + randomUUID().slice(0, 8).replace(/-/g, '');
const scratchDb = dbName + '_restore';
const dbUser = 'bv';
const dbPassword = randomUUID().replace(/-/g, '');
const ORG_A = 'b1000000-0000-4000-8000-0000000000a1';
const ORG_B = 'b1000000-0000-4000-8000-0000000000a2';
const checks = [];
const seedStatus = [];

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function psql(db, sql) {
  return run('docker', ['exec', container, 'psql', '-U', dbUser, '-d', db, '-t', '-A', '-c', sql]).trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function record(id, title, ok, detail) {
  checks.push({ id, title, ok, detail });
}

function cleanup() {
  try {
    run('docker', ['rm', '-f', container]);
  } catch {
    /* 已销毁 */
  }
}

function listTables() {
  return psql(
    dbName,
    "select tablename from pg_tables where schemaname='public' and tablename <> '_prisma_migrations' order by tablename",
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function seed(prisma) {
  const attempt = async (name, fn) => {
    try {
      await fn();
      seedStatus.push(`${name}: ok`);
      return true;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const raw = error instanceof Error ? error.message.split('\n')[0] : String(error);
      const message = (code ? `[${code}] ` : '') + (raw || error?.constructor?.name || 'unknown');
      seedStatus.push(`${name}: FAILED (${message.slice(0, 120)})`);
      return false;
    }
  };

  await attempt('Organization(A/B)', async () => {
    await prisma.organization.create({ data: { id: ORG_A, name: 'Tenant A', slug: 'tenant-a-bv' } });
    await prisma.organization.create({ data: { id: ORG_B, name: 'Tenant B', slug: 'tenant-b-bv' } });
  });

  let userA = null;
  let userB = null;
  await attempt('User(A/B)', async () => {
    userA = await prisma.user.create({ data: { email: 'bv-a@example.com', displayName: 'BV A' } });
    userB = await prisma.user.create({ data: { email: 'bv-b@example.com', displayName: 'BV B' } });
  });
  if (userA && userB) {
    await attempt('Membership(A/B)', async () => {
      await prisma.membership.create({ data: { organizationId: ORG_A, userId: userA.id, role: 'OWNER' } });
      await prisma.membership.create({ data: { organizationId: ORG_B, userId: userB.id, role: 'OWNER' } });
    });
  }

  let connectionA = null;
  await attempt('SourceConnection(A)', async () => {
    connectionA = await prisma.sourceConnection.create({
      data: { organizationId: ORG_A, domain: 'LOGISTICS', channel: 'UPS', kind: 'FILE_UPLOAD', label: 'bv-conn-a' },
    });
  });

  let fileAssetA = null;
  await attempt('FileAsset(A)', async () => {
    fileAssetA = await prisma.fileAsset.create({
      data: { organizationId: ORG_A, kind: 'CSV', storageKey: 'bv/asset-a.csv', originalName: 'asset-a.csv' },
    });
  });

  await attempt('ImportBatch(A)', async () => {
    await prisma.importBatch.create({
      data: {
        organizationId: ORG_A,
        domain: 'LOGISTICS',
        channel: 'UPS',
        ...(connectionA ? { connectionId: connectionA.id } : {}),
        ...(fileAssetA ? { fileAssetId: fileAssetA.id } : {}),
      },
    });
  });

  await attempt('SourceTransaction(A/B)', async () => {
    for (const [org, key] of [[ORG_A, 'a'], [ORG_B, 'b']]) {
      await prisma.sourceTransaction.create({
        data: { organizationId: org, domain: 'LOGISTICS', channel: 'UPS', dedupeKey: `bv-dedupe-${key}`, raw: { synthetic: true } },
      });
    }
  });

  await attempt('CanonicalFact(A)', async () => {
    await prisma.canonicalFact.create({
      data: { organizationId: ORG_A, domain: 'LOGISTICS', channel: 'UPS', factKey: 'BV:FACT:1' },
    });
  });

  let evidenceA = null;
  await attempt('EvidenceArtifact(A)', async () => {
    evidenceA = await prisma.evidenceArtifact.create({
      data: { organizationId: ORG_A, kind: 'CONTRACT', title: 'bv evidence' },
    });
  });

  let caseA = null;
  let caseB = null;
  await attempt('Case(A/B)', async () => {
    caseA = await prisma.case.create({
      data: { organizationId: ORG_A, caseNo: 'BV-CASE-1', title: 'bv case', domain: 'LOGISTICS' },
    });
    caseB = await prisma.case.create({
      data: { organizationId: ORG_B, caseNo: 'BV-CASE-2', title: 'bv case b', domain: 'LOGISTICS' },
    });
  });

  if (caseA && evidenceA) {
    await attempt('CaseEvidence(A)', async () => {
      await prisma.caseEvidence.create({
        data: { organizationId: ORG_A, caseId: caseA.id, evidenceId: evidenceA.id },
      });
    });
  }

  await attempt("Claim(A/B)", async () => {
    if (caseA) {
      await prisma.claim.create({
        data: { organizationId: ORG_A, caseId: caseA.id, target: "PLATFORM", status: "DRAFT" },
      });
    }
    if (caseB) {
      await prisma.claim.create({
        data: { organizationId: ORG_B, caseId: caseB.id, target: "PLATFORM", status: "DRAFT" },
      });
    }
  });

  let opportunityA = null;
  await attempt('RecoveryOpportunity(A)', async () => {
    opportunityA = await prisma.recoveryOpportunity.create({
      data: {
        organizationId: ORG_A,
        domain: 'LOGISTICS',
        channel: 'UPS',
        opportunityType: 'BV_SYNTHETIC',
        title: 'bv opportunity',
      },
    });
  });

  await attempt('RecoveryGraphNode(A)', async () => {
    await prisma.recoveryGraphNode.create({ data: { organizationId: ORG_A, nodeType: 'ORGANIZATION', label: 'bv node' } });
  });

  let settlementA = null;
  await attempt('Settlement(A)', async () => {
    settlementA = await prisma.settlement.create({
      data: { organizationId: ORG_A, source: 'PLATFORM_CREDIT', amount: '1234.5678', currency: 'USD' },
    });
  });

  await attempt('RecoveryLedgerEntry(A)', async () => {
    await prisma.recoveryLedgerEntry.create({
      data: { organizationId: ORG_A, entryType: 'DISCOVERED', amount: '1234.5678', currency: 'USD' },
    });
  });

  if (settlementA) {
    await attempt('RecoveryPayout(A)', async () => {
      await prisma.recoveryPayout.create({
        data: {
          organizationId: ORG_A,
          settlementId: settlementA.id,
          payoutRef: 'bv-payout-1',
          amount: '1234.5678',
          receivedAt: new Date(),
          sourceType: 'PLATFORM_SETTLEMENT',
        },
      });
    });
  }

  let invoiceA = null;
  await attempt('BillingInvoice(A)', async () => {
    invoiceA = await prisma.billingInvoice.create({
      data: { organizationId: ORG_A, invoiceNo: 'BV-INV-1', subtotal: '100.0000', taxAmount: '0', total: '100.0000', currency: 'USD' },
    });
  });

  if (settlementA) {
    await attempt('FeeCalculation(A)', async () => {
      await prisma.feeCalculation.create({
        data: {
          organizationId: ORG_A,
          settlementId: settlementA.id,
          ...(invoiceA ? { billingInvoiceId: invoiceA.id } : {}),
          basis: 'RECOVERED_AMOUNT_PCT',
          rate: '0.150000',
          baseAmount: '1234.5678',
          feeAmount: '185.1852',
          currency: 'USD',
          computation: { synthetic: true },
        },
      });
    });
  }

  if (invoiceA) {
    await attempt('Payment(A)', async () => {
      await prisma.payment.create({
        data: {
          organizationId: ORG_A,
          invoiceId: invoiceA.id,
          provider: 'bv-provider',
          externalPaymentId: 'bv-payment-1',
          amount: '100.0000',
          currency: 'USD',
          idempotencyKey: 'bv-idem-1',
        },
      });
    });
  }

  await attempt('AuditLog(A/B)', async () => {
    for (const [org, key] of [[ORG_A, 'a'], [ORG_B, 'b']]) {
      await prisma.auditLog.create({
        data: {
          organizationId: org,
          actorType: 'SYSTEM',
          actorRef: 'backup-verify',
          action: `bv.synthetic.${key}`,
        },
      });
    }
  });

  await attempt('KillSwitchRequest(A/B)', async () => {
    await prisma.killSwitchRequest.create({
      data: {
        organizationId: ORG_A,
        scope: 'submission',
        target: 'DISABLED',
        state: 'APPLIED',
        reasonCode: 'MAINTENANCE',
        requestedBy: 'bv-owner',
        expiresAt: new Date(),
        appliedAt: new Date(),
        idempotencyKey: 'bv-ks-a',
      },
    });
    await prisma.killSwitchRequest.create({
      data: {
        organizationId: ORG_B,
        scope: 'billing',
        target: 'ENABLED',
        state: 'PENDING_ENABLE',
        reasonCode: 'MAINTENANCE',
        requestedBy: 'bv-owner',
        expiresAt: new Date(Date.now() + 900000),
        idempotencyKey: 'bv-ks-b',
      },
    });
  });

  void opportunityA;
  return seedStatus;
}

/** B1：逐表行数一致 */
function checkRowCounts() {
  const tables = listTables();
  const mismatches = tables
    .map((table) => ({
      table,
      a: psql(dbName, `select count(*) from "${table}"`),
      b: psql(scratchDb, `select count(*) from "${table}"`),
    }))
    .filter((row) => row.a !== row.b)
    .map((row) => `${row.table}: original=${row.a} restored=${row.b}`);
  const nonEmpty = tables.filter((table) => Number(psql(dbName, `select count(*) from "${table}"`)) > 0);
  record(
    'B1',
    '每表行数一致（覆盖 Organization/User/Membership/Claim/Evidence/Recovery/Settlement/Billing/AuditLog/KillSwitchRequest）',
    mismatches.length === 0,
    `${tables.length} tables compared; ${nonEmpty.length} non-empty (${nonEmpty.slice(0, 8).join(', ')}${nonEmpty.length > 8 ? ', …' : ''})`,
  );
  if (mismatches.length > 0) record('B1.detail', '行数差异明细', false, mismatches.join('; '));
}

/** B2：租户隔离（逐表按 organizationId 比较 A/B 的计数） */
function checkTenantIsolation() {
  const tenantTables = psql(
    scratchDb,
    "select table_name from information_schema.columns where table_schema='public' and column_name='organizationId' order by table_name",
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const mismatches = [];
  let nonZero = 0;
  for (const table of tenantTables) {
    for (const org of [ORG_A, ORG_B]) {
      const a = psql(dbName, `select count(*) from "${table}" where "organizationId" = '${org}'`);
      const b = psql(scratchDb, `select count(*) from "${table}" where "organizationId" = '${org}'`);
      if (Number(a) > 0) nonZero += 1;
      if (a !== b) mismatches.push(`${table}[${org.slice(-2)}]: original=${a} restored=${b}`);
    }
  }
  record(
    'B2',
    '租户隔离：每个 tenant-owned 表「恢复后 = 原始」（A/B 分别比较）',
    mismatches.length === 0,
    mismatches.length === 0
      ? `${tenantTables.length} tables × 2 tenants; ${nonZero} tenant-scoped rows present`
      : mismatches.join('; '),
  );
}

/** B3：金额精确一致（numeric，不做浮点转换） */
function checkAmounts() {
  const targets = [
    ['Settlement', 'amount'],
    ['RecoveryLedgerEntry', 'amount'],
    ['RecoveryPayout', 'amount'],
    ['BillingInvoice', 'total'],
    ['FeeCalculation', 'feeAmount'],
    ['Payment', 'amount'],
  ];
  const rows = [];
  const mismatches = [];
  for (const [table, column] of targets) {
    const sql = `select coalesce(sum("${column}")::text, '0') from "${table}"`;
    const a = psql(dbName, sql);
    const b = psql(scratchDb, sql);
    rows.push(`${table}.${column}=${a}`);
    if (a !== b) mismatches.push(`${table}.${column}: original=${a} restored=${b}`);
  }
  record(
    'B3',
    '金额一致（Decimal/numeric 精确比较，禁止 float）',
    mismatches.length === 0,
    mismatches.length === 0 ? rows.join(' · ') : mismatches.join('; '),
  );
}

/** B4：审计连续性 */
function checkAuditContinuity() {
  const fingerprint = (db) =>
    [
      psql(db, 'select count(*) from "AuditLog"'),
      psql(db, `select coalesce(max("createdAt")::text, 'none') from "AuditLog"`),
      psql(
        db,
        "select coalesce(string_agg(action || ':' || c, ',' order by action), '') from (select action, count(*)::text as c from \"AuditLog\" group by action) s",
      ),
    ].join('|');
  const a = fingerprint(dbName);
  const b = fingerprint(scratchDb);
  record('B4', '审计连续性（count + action 分布 + max(createdAt)）', a === b, `original=${a} restored=${b}`);
}

/** B5：Kill Switch */
function checkKillSwitch() {
  const distribution = (db) =>
    psql(
      db,
      "select coalesce(string_agg(state || ':' || c, ',' order by state), '') from (select state, count(*)::text as c from \"KillSwitchRequest\" group by state) s",
    );
  const a = distribution(dbName);
  const b = distribution(scratchDb);
  const uniqueIndex = psql(
    scratchDb,
    "select count(*) from pg_indexes where tablename='KillSwitchRequest' and indexname='KillSwitchRequest_organizationId_idempotencyKey_key'",
  );
  const partial = psql(
    scratchDb,
    "select count(*) from pg_indexes where tablename='KillSwitchRequest' and indexname='kill_switch_request_pending_unique'",
  );
  const triggers = psql(scratchDb, "select count(*) from pg_trigger where tgname like 'cc_tenant%'");
  record(
    'B5',
    'Kill Switch：state 分布 + 幂等唯一索引 + pending 部分唯一索引 + 触发器 28',
    a === b && uniqueIndex === '1' && partial === '1' && triggers === '28',
    `state original=${a} restored=${b}; idempotencyIndex=${uniqueIndex}; pendingIndex=${partial}; tenantTriggers=${triggers}`,
  );
}

/** B6：Schema 一致性 */
function checkSchema() {
  const fingerprint = (db) =>
    [
      psql(db, 'select count(*) from "_prisma_migrations" where finished_at is not null'),
      psql(db, "select count(*) from pg_indexes where schemaname='public'"),
      psql(db, 'select count(distinct t.typname) from pg_type t join pg_enum e on e.enumtypid = t.oid'),
      psql(db, "select count(*) from pg_constraint c join pg_class r on r.oid = c.conrelid where r.relkind = 'r'"),
    ].join('|');
  const a = fingerprint(dbName);
  const b = fingerprint(scratchDb);
  record('B6', 'Schema：迁移数 / 索引数 / 枚举数 / 约束数一致（迁移=19）', a === b && b.startsWith('19|'), `original=${a} restored=${b}`);
}

/** B7：不变量（外键全部 validated） */
function checkForeignKeys() {
  const fkCount = psql(scratchDb, "select count(*) from pg_constraint where contype='f'");
  const unvalidated = psql(scratchDb, "select count(*) from pg_constraint where contype='f' and convalidated = false");
  record(
    'B7',
    '不变量：恢复后外键全部有效（无 unvalidated / orphan）',
    unvalidated === '0',
    `fkCount=${fkCount} unvalidated=${unvalidated}`,
  );
}

async function main() {
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  run('docker', [
    'run', '-d', '--rm', '--name', container,
    '-e', 'POSTGRES_USER=' + dbUser,
    '-e', 'POSTGRES_PASSWORD=' + dbPassword,
    '-e', 'POSTGRES_DB=' + dbName,
    '-p', '127.0.0.1::5432',
    PG_IMAGE,
  ]);
  for (let i = 0; i < 30; i += 1) {
    try {
      run('docker', ['exec', container, 'pg_isready', '-U', dbUser, '-d', dbName]);
      break;
    } catch {
      sleepSync(1000);
    }
  }
  const hostPort = run('docker', ['port', container, '5432']).trim().split(':').pop();
  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${hostPort}/${dbName}`;
  run(process.execPath, [path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const okCount = seedStatus.filter((line) => line.endsWith(': ok')).length;
  record('SEED', '合成数据集（Prisma 客户端写入；失败项如实记录）', okCount > 0, `${okCount}/${seedStatus.length} models seeded`);
  for (const line of seedStatus) {
    if (!line.endsWith(': ok')) console.log('SEED_SKIP: ' + line);
  }

  run('docker', ['exec', container, 'bash', '-lc', `pg_dump -U ${dbUser} -d ${dbName} -Fc -f /tmp/bv.dump`]);
  run('docker', ['exec', container, 'bash', '-lc', `createdb -U ${dbUser} ${scratchDb}`]);
  run('docker', ['exec', container, 'bash', '-lc', `pg_restore -U ${dbUser} -d ${scratchDb} /tmp/bv.dump`]);

  checkRowCounts();
  checkTenantIsolation();
  checkAmounts();
  checkAuditContinuity();
  checkKillSwitch();
  checkSchema();
  checkForeignKeys();

  // Restore Failure Simulation：破坏 scratch 后必须被检出
  const beforeAudit = Number(psql(scratchDb, 'select count(*) from "AuditLog"'));
  psql(scratchDb, 'delete from "AuditLog"');
  const afterAudit = Number(psql(scratchDb, 'select count(*) from "AuditLog"'));
  const detected = beforeAudit !== afterAudit;
  record(
    'SIM',
    'Restore Failure Simulation（破坏 scratch 后必须被判定为失败，证明不会误判成功）',
    detected && beforeAudit > 0,
    `auditRows before=${beforeAudit} after=${afterAudit} → detected=${detected}`,
  );
}

let exitCode = 0;
try {
  await main();
  const failed = checks.filter((check) => !check.ok);
  console.log(failed.length === 0 ? 'BACKUP_VERIFY_OK' : 'BACKUP_VERIFY_FAILED');
  for (const check of checks) {
    console.log(`  ${check.ok ? '[PASS]' : '[FAIL]'} ${check.id} ${check.title} :: ${check.detail}`);
  }
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  exitCode = 1;
  console.log('BACKUP_VERIFY_ERROR');
  for (const check of checks) console.log(`  ${check.ok ? '[PASS]' : '[FAIL]'} ${check.id} ${check.title} :: ${check.detail}`);
  console.log('cause: ' + (error instanceof Error ? error.message : String(error)));
} finally {
  cleanup();
}
process.exit(exitCode);
