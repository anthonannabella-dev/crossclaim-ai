#!/usr/bin/env node
/**
 * P2-2 Backup / Restore Verification（合成数据，MSG-20260929-71 Q2）
 * ---------------------------------------------------------------
 * 链路：synthetic dataset → PostgreSQL → pg_dump → pg_restore scratch → compare
 *
 * 不变量（架构方 B1–B7，逐项输出证据）：
 *   B1 行数一致（含 Organization / User / Membership / Claim / Evidence / Recovery /
 *      Settlement / Billing / AuditLog / KillSwitchRequest 等所有既有表）
 *   B2 租户隔离（Tenant A 恢复后与原始一致；Tenant A != Tenant B）
 *   B3 金额一致（numeric 精确比较，**不使用 float**）
 *   B4 审计连续性（count + action 分布 + max(createdAt)）
 *   B5 Kill Switch（state 分布 + idempotency 唯一索引 + 租户触发器数）
 *   B6 Schema（迁移数 + 索引数 + 枚举数 + 约束数）
 *   B7 不变量（恢复后无悬空外键）
 *
 * 边界（架构方补充要求）：
 *   - CI 允许 **temporary dump**（本脚本的 dump 只存在于容器内 /tmp，随容器销毁）
 *   - 禁止 upload artifact / persist dump / commit dump（脚本不写任何宿主文件）
 *   - 真实备份测试 = HOST APPROVAL REQUIRED（本脚本只用合成数据与临时容器）
 *   - Restore Failure Simulation：故意破坏 scratch 后必须被判定为 FAIL（证明不会误判成功）
 *
 * 用法：node tools/backup-verify/run-synthetic-backup-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PG_IMAGE = process.env.BACKUP_VERIFY_PG_IMAGE ?? 'postgres:16-alpine';
const container = 'crossclaim-backup-verify-' + randomUUID().slice(0, 8);
const dbName = 'bv_' + randomUUID().slice(0, 8).replace(/-/g, '');
const scratchDb = dbName + '_restore';
const dbUser = 'bv';
const dbPassword = randomUUID().replace(/-/g, '');
const checks = [];

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function sh(script) {
  return run('bash', ['-lc', script]);
}

function psql(db, sql) {
  return run('docker', ['exec', container, 'psql', '-U', dbUser, '-d', db, '-t', '-A', '-c', sql]).trim();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function record(id, title, ok, detail) {
  checks.push({ id, title, ok, detail });
  return ok;
}

function cleanup() {
  try {
    run('docker', ['rm', '-f', container]);
  } catch {
    /* 已销毁 */
  }
}

/** 所有既有表（排除 Prisma 迁移表；迁移表单独在 B6 校验） */
function listTables() {
  return psql(
    dbName,
    "select tablename from pg_tables where schemaname='public' and tablename <> '_prisma_migrations' order by tablename",
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** B1：逐表行数一致 */
function checkRowCounts(tables) {
  const mismatches = [];
  for (const table of tables) {
    const a = psql(dbName, `select count(*) from "${table}"`);
    const b = psql(scratchDb, `select count(*) from "${table}"`);
    if (a !== b) mismatches.push(`${table}: original=${a} restored=${b}`);
  }
  return record(
    'B1',
    '每表行数一致（含 Organization/User/Membership/Claim/Evidence/Recovery/Settlement/Billing/AuditLog/KillSwitchRequest）',
    mismatches.length === 0,
    mismatches.length === 0 ? `${tables.length} tables compared` : mismatches.join('; '),
  );
}

/** B2：租户隔离（对所有带 organizationId 的表比较 A/B 的计数；A 恢复后必须与原始一致） */
function checkTenantIsolation() {
  const tenantTables = psql(
    scratchDb,
    "select table_name from information_schema.columns where table_schema='public' and column_name='organizationId' order by table_name",
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const mismatches = [];
  let compared = 0;
  for (const table of tenantTables) {
    for (const org of [ORG_A, ORG_B]) {
      const sql = (db) => `select count(*) from "${table}" where "organizationId" = '${org}'`;
      const a = psql(dbName, sql(dbName));
      const b = psql(scratchDb, sql(scratchDb));
      if (a !== b) mismatches.push(`${table}[${org.slice(-2)}]: original=${a} restored=${b}`);
    }
    compared += 1;
  }
  return record(
    'B2',
    '租户隔离：每个带 organizationId 的表在 A/B 上「恢复后 = 原始」',
    mismatches.length === 0,
    mismatches.length === 0 ? `${compared} tenant-owned tables compared` : mismatches.join('; '),
  );
}

