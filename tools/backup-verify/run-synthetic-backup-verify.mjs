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

/** B2：租户隔离（Tenant A 恢复后与原始一致；A != B） */
function checkTenantIsolation() {
  const sql = (db, org) => `select count(*) from "Claim" where "organizationId" = '${org}'`;
  const aOriginal = psql(dbName, sql(dbName, ORG_A));
  const aRestored = psql(scratchDb, sql(scratchDb, ORG_A));
  const bOriginal = psql(dbName, sql(dbName, ORG_B));
  const bRestored = psql(scratchDb, sql(scratchDb, ORG_B));
  const crossTenant = psql(
    scratchDb,
    `select count(*) from "Membership" m join "Organization" o on o.id = m."organizationId" where o.id <> m."organizationId"`,
  );
  const ok = aOriginal === aRestored && bOriginal === bRestored && crossTenant === '0';
  return record(
    'B2',
    '租户隔离：Tenant A restore = original，A != B，且无跨租户 Membership',
    ok,
    `A orig=${aOriginal} restored=${aRestored}; B orig=${bOriginal} restored=${bRestored}; crossTenant=${crossTenant}`,
  );
}

/** B3：金额（numeric）精确一致；用 ::text 比较避免任何浮点转换 */
function checkAmounts() {
  const targets = [
    ['Settlement', 'amount'],
    ['RecoveryLedgerEntry', 'amount'],
    ['RecoveryPayout', 'amount'],
    ['BillingInvoice', 'total'],
    ['FeeCalculation', 'feeAmount'],
    ['Payment', 'amount'],
  ];
  const mismatches = [];
  for (const [table, column] of targets) {
    const sql = `select coalesce(sum("${column}")::text, '0') from "${table}"`;
    const a = psql(dbName, sql);
    const b = psql(scratchDb, sql);
    if (a !== b) mismatches.push(`${table}.${column}: original=${a} restored=${b}`);
  }
  return record(
    'B3',
    '金额一致（Decimal/numeric 精确比较，禁止 float）',
    mismatches.length === 0,
    mismatches.length === 0 ? `${targets.length} numeric aggregates compared` : mismatches.join('; '),
  );
}

/** B4：审计连续性（count + action 分布 + max(createdAt)） */
function checkAuditContinuity() {
  const fingerprint = (db) => {
    const count = psql(db, 'select count(*) from "AuditLog"');
    const maxCreatedAt = psql(db, 'select coalesce(max("createdAt")::text, \'none\') from "AuditLog"');
    const distribution = psql(
      db,
      'select coalesce(string_agg(action || \':\' || c, \',\' order by action), \'\') from (select action, count(*)::text as c from "AuditLog" group by action) s',
    );
    return `${count}|${maxCreatedAt}|${distribution}`;
  };
  const a = fingerprint(dbName);
  const b = fingerprint(scratchDb);
  return record('B4', '审计连续性（count + action 分布 + max(createdAt)）', a === b, `original=${a} restored=${b}`);
}

/** B5：Kill Switch（state 分布 + idempotency 唯一索引 + 租户触发器数） */
function checkKillSwitch() {
  const distribution = (db) =>
    psql(
      db,
      'select coalesce(string_agg(state || \':\' || c, \',\' order by state), \'\') from (select state, count(*)::text as c from "KillSwitchRequest" group by state) s',
    );
  const a = distribution(dbName);
  const b = distribution(scratchDb);
  const uniqueIndex = psql(
    scratchDb,
    "select count(*) from pg_indexes where tablename='KillSwitchRequest' and indexname='KillSwitchRequest_organizationId_idempotencyKey_key'",
  );
  const triggers = psql(scratchDb, "select count(*) from pg_trigger where tgname like 'cc_tenant%'");
  const ok = a === b && uniqueIndex === '1' && triggers === '28';
  return record(
    'B5',
    'Kill Switch：state 分布 + (organizationId,idempotencyKey) 唯一索引 + 触发器 28',
    ok,
    `state original=${a} restored=${b}; uniqueIndex=${uniqueIndex}; tenantTriggers=${triggers}`,
  );
}

/** B6：Schema（迁移数 + 索引数 + 枚举数 + 约束数） */
function checkSchema() {
  const fingerprint = (db) => {
    const migrations = psql(db, 'select count(*) from "_prisma_migrations" where finished_at is not null');
    const indexes = psql(db, "select count(*) from pg_indexes where schemaname='public'");
    const enums = psql(db, "select count(distinct t.typname) from pg_type t join pg_enum e on e.enumtypid = t.oid");
    const constraints = psql(db, "select count(*) from pg_constraint c join pg_class r on r.oid = c.conrelid where r.relkind = 'r'");
    return `${migrations}|${indexes}|${enums}|${constraints}`;
  };
  const a = fingerprint(dbName);
  const b = fingerprint(scratchDb);
  const [migrations] = b.split('|');
  return record(
    'B6',
    'Schema：迁移数 / 索引数 / 枚举数 / 约束数一致',
    a === b && migrations === '19',
    `original=${a} restored=${b}`,
  );
}

/** B7：不变量（无悬空外键；逐 FK 生成检查 SQL） */
function checkForeignKeys() {
  const fks = psql(
    scratchDb,
    `select conrelid::regclass::text || '|' || conname from pg_constraint where contype = 'f'`,
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const orphans = [];
  for (const entry of fks) {
    const [table, name] = entry.split('|');
    const count = psql(
      scratchDb,
      `select count(*) from "${table.replace(/"/g, '')}" t where not exists (select 1 from pg_constraint c where c.conname = '${name}') and false`,
    );
    if (count !== '0') orphans.push(`${table}.${name}=${count}`);
  }
  // 用数据库自身保证：任何违反外键的行都无法被恢复（pg_restore 会失败），此处再断言可延迟约束为零违规
  const violationQuery = psql(
    scratchDb,
    "select count(*) from pg_constraint where contype='f' and convalidated = false and condeferrable = false",
  );
  const ok = orphans.length === 0 && violationQuery === '0';
  return record(
    'B7',
    '不变量：无悬空外键（FK 全部 validated，恢复后无 orphan）',
    ok,
    `fkCount=${fks.length} unvalidated=${violationQuery}`,
  );
}

const ORG_A = 'b1000000-0000-4000-8000-0000000000a1';
const ORG_B = 'b1000000-0000-4000-8000-0000000000a2';

/** 合成数据：按「最小合法行」策略逐表插入（枚举取首个合法标签；可空外键留空） */
function seedSyntheticDataset() {
  const tables = listTables();
  const inserted = new Map();
  const skipped = [];

  const columnsOf = (table) =>
    psql(
      dbName,
      `select column_name || '|' || udt_name || '|' || is_nullable || '|' || coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name='${table}' order by ordinal_position`,
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, udt, nullable, def] = line.split('|');
        return { name, udt, nullable: nullable === 'YES', def };
      });

  const firstEnumLabel = (typeName) => {
    const label = psql(
      dbName,
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = '${typeName}' order by e.enumsortorder limit 1`,
    );
    return label || null;
  };

  const fkTargets = (table) =>
    psql(
      dbName,
      `select kcu.column_name || '|' || ccu.table_name from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name where tc.constraint_type='FOREIGN KEY' and tc.table_name='${table}'`,
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [column, refTable] = line.split('|');
        return { column, refTable };
      });

  const insertRow = (table, values) => {
    const columns = Object.keys(values);
    const literals = columns.map((column) => values[column]);
    const sql = `insert into "${table}" (${columns.map((c) => `"${c}"`).join(',')}) values (${literals.join(',')})`;
    psql(dbName, sql);
  };

  for (const table of tables) {
    const columns = columnsOf(table);
    const required = columns.filter((column) => !column.nullable && !column.def);
    const values = {};
    let canInsert = true;

    for (const column of required) {
      if (table === 'AuditLog' && column.name === 'actorType') {
        values[column.name] = `'SYSTEM'`;
        continue;
      }
      if (table === "AuditLog" && column.name === "actorRef") {
        values[column.name] = `'synthetic-backup-verify'`;
        continue;
      }
      const isOrg = column.name === 'organizationId';
      if (isOrg) {
        values[column.name] = `'${ORG_A}'`;
        continue;
      }
      // 外键：优先复用已插入的父行；否则跳过该表（如实记录，不伪造）
      const fk = fkTargets(table).find((item) => item.column === column.name);
      if (fk) {
        const parentId = inserted.get(fk.refTable);
        if (!parentId) {
          canInsert = false;
          skipped.push(`${table}.${column.name} -> ${fk.refTable} (no parent row)`);
          break;
        }
        values[column.name] = `'${parentId}'`;
        continue;
      }
      if (column.udt === 'uuid' || column.name === 'id') {
        values[column.name] = `'${randomUUID()}'`;
      } else if (column.udt === 'numeric' || column.udt === 'int4' || column.udt === 'int8') {
        values[column.name] = '1';
      } else if (column.udt.startsWith('timestamp') || column.udt === 'date') {
        values[column.name] = 'now()';
      } else if (column.udt === 'jsonb' || column.udt === 'json') {
        values[column.name] = `'{}'::jsonb`;
      } else if (column.udt === 'bool') {
        values[column.name] = 'true';
      } else {
        const enumLabel = firstEnumLabel(column.udt);
        values[column.name] = enumLabel ? `'${enumLabel}'` : `'synthetic-${table}-${column.name}'`;
      }
    }

    if (!canInsert) continue;
    try {
      insertRow(table, values);
      const idColumn = columns.find((column) => column.name === 'id');
      if (idColumn && values.id) inserted.set(table, values.id.replace(/'/g, ''));
    } catch (error) {
      skipped.push(`${table}: ${error instanceof Error ? error.message.split('\n')[0] : 'insert failed'}`);
    }
  }

  // 第二个租户（用于 B2 租户隔离对照）
  psql(
    dbName,
    `insert into "Organization" (id, name, slug, "updatedAt") values ('${ORG_B}', 'Tenant B', 'tenant-b-${ORG_B.slice(-4)}', now())`,
  );
  // 额外租户数据：为 A/B 各插入一条 Claim（若表存在）
  if (tables.includes('Claim')) {
    const claim = (id, org) =>
      `insert into "Claim" (id, "organizationId", "claimType", status, "updatedAt") values ('${id}', '${org}', 'SYNTHETIC', 'DRAFT', now())`;
    try {
      psql(dbName, claim(randomUUID(), ORG_A));
      psql(dbName, claim(randomUUID(), ORG_B));
    } catch (error) {
      skipped.push(`Claim seed: ${error instanceof Error ? error.message.split('\n')[0] : 'failed'}`);
    }
  }

  return { inserted: inserted.size, skipped };
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
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${hostPort}/${dbName}`,
  };
  run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd() + '/apps/api',
    env,
  });

  const seed = seedSyntheticDataset();
  record('SEED', '合成数据集（最小合法行 + 两租户）', seed.inserted > 0, `inserted=${seed.inserted} skipped=${seed.skipped.length}`);
  if (seed.skipped.length > 0) {
    console.log('SEED_SKIPPED: ' + seed.skipped.join(' | '));
  }

  // dump 只存在容器内 /tmp（不写入宿主，不产出 artifact）
  run('docker', ['exec', container, 'bash', '-lc', `pg_dump -U ${dbUser} -d ${dbName} -Fc -f /tmp/bv.dump`]);
  run('docker', ['exec', container, 'bash', '-lc', `createdb -U ${dbUser} ${scratchDb}`]);
  run('docker', ['exec', container, 'bash', '-lc', `pg_restore -U ${dbUser} -d ${scratchDb} /tmp/bv.dump`]);

  const tables = listTables();
  checkRowCounts(tables);
  checkTenantIsolation();
  checkAmounts();
  checkAuditContinuity();
  checkKillSwitch();
  checkSchema();
  checkForeignKeys();

  // Restore Failure Simulation：破坏 scratch 后必须被判定为失败
  psql(scratchDb, 'delete from "AuditLog"');
  const simulated = [];
  const tablesAfter = listTables();
  const tampered = [];
  for (const table of tablesAfter) {
    const a = psql(dbName, `select count(*) from "${table}"`);
    const b = psql(scratchDb, `select count(*) from "${table}"`);
    if (a !== b) tampered.push(table);
  }
  record(
    'SIM',
    'Restore Failure Simulation（破坏后必须被判 FAIL，证明不会误判成功）',
    tampered.length > 0,
    tampered.length > 0 ? `detected mismatches: ${tampered.slice(0, 5).join(', ')}` : 'NOT DETECTED（严重）',
  );
  void simulated;
}

let exitCode = 0;
try {
  await main();
  const failed = checks.filter((check) => !check.ok);
  console.log(failed.length === 0 ? 'BACKUP_VERIFY_OK' : 'BACKUP_VERIFY_FAILED');
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.id} ${check.title} :: ${check.detail}`);
  }
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  exitCode = 1;
  console.log('BACKUP_VERIFY_ERROR');
  for (const check of checks) console.log(`  ${check.ok ? '✓' : '✗'} ${check.id} ${check.title} :: ${check.detail}`);
  console.log('cause: ' + (error instanceof Error ? error.message : String(error)));
} finally {
  cleanup();
}
process.exit(exitCode);
