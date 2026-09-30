#!/usr/bin/env node
/**
 * B2-FIX R1 / MSG-20260930-06 CHANGE E + MSG-20260930-07 ANSWER
 * ------------------------------------------------------------------
 * 真实两段升级验证（不 reset / 不换库 / 不丢数据）：
 *   阶段 1：独立临时库里只应用「B2 之前」的迁移（临时 schema 目录 = 仓库迁移副本去掉 B2），
 *          然后播种关联合成数据（Organization A/B + Case(A) + Claim(A->Case) + SYSTEM RuleSet/Version + RuleEvaluation）。
 *   阶段 2：保留数据，用仓库真实迁移目录执行 migrate deploy（因此只落 B2 迁移），再跑保护行为断言，
 *          确认原数据 / 归属 / 引用关系保持正确。
 *   最后再次 migrate deploy，确认无待应用迁移（幂等）。
 *
 * 安全要求（沿用 deploy-smoke 约定）：
 *   - 只用合成数据与临时数据库；不读取、不打印任何凭据（连接串只在内存中解析）。
 *   - 只使用 throwaway 数据库名 cc_upgrade_<hex>，结束时强制删除。
 *   - 除 CREATE/DROP 临时库外不改任何库；绝不触碰真实数据或真实环境。
 *
 * 用法：
 *   node tools/upgrade-verify/two-stage-upgrade.mjs
 * 环境：
 *   DATABASE_URL        基库连接串（缺省时从 apps/api/.env 读取；始终不打印）
 *   CC_PSQL_CMD         psql 命令前缀（本地可用 "docker exec -i crossclaim-postgres psql -U crossclaim"）
 * 退出码：0 = 全部通过；1 = 失败（打印失败步骤）
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const API_DIR = join(ROOT, 'apps', 'api');
const PRISMA_DIR = join(API_DIR, 'prisma');
const MIGRATIONS_DIR = join(PRISMA_DIR, 'migrations');
const PRISMA_CLI = join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js');
const NODE_BIN = process.execPath;

const B2_MIGRATION = '20260930100000_tenant_ownership_immutability';

const ORG_A = 'b2f00000-0000-4000-8000-00000000000a';
const ORG_B = 'b2f00000-0000-4000-8000-00000000000b';
const RS_SYS = 'b2e10000-0000-4000-8000-000000000001';
const RS_A = 'b2e10000-0000-4000-8000-000000000002';
const RV_SYS = 'b2e20000-0000-4000-8000-000000000001';
const RV_A = 'b2e20000-0000-4000-8000-000000000002';
const CASE_A = 'b2c00000-0000-4000-8000-00000000000a';
const CLAIM_A = 'b2d00000-0000-4000-8000-00000000000a';
const EV_A_SYS = 'b2e30000-0000-4000-8000-000000000001';
const EV_B_SYS = 'b2e30000-0000-4000-8000-000000000002';

const psqlBase = (process.env.CC_PSQL_CMD ?? 'psql').trim().split(/\s+/);
const steps = [];
let tempDb = null;
let tempDir = null;

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function psql(db, sql, { expectFail = false, label = '' } = {}) {
  const args = [...psqlBase, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql];
  if (!expectFail) return run(args[0], args.slice(1)).trim();
  try {
    run(args[0], args.slice(1));
  } catch (error) {
    return String(error?.stderr ?? error?.message ?? '');
  }
  throw new Error('EXPECTED_DB_REJECTION_MISSING: 数据库没有拒绝该语句' + (label ? ' [' + label + ']' : ''));
}

function step(name, fn) {
  try {
    const detail = fn() ?? '';
    steps.push({ name, ok: true, detail });
    return detail;
  } catch (error) {
    steps.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function resolveBaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(API_DIR, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (match) return match[1].replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('DATABASE_URL not found (env or apps/api/.env)');
}

function migrateDeploy(schemaPath, url, { expectPending = false } = {}) {
  const out = run(NODE_BIN, [PRISMA_CLI, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: url },
  });
  if (expectPending) {
    if (!/No pending migrations to apply/.test(out)) throw new Error('expected no pending migrations');
    return 'no pending migrations';
  }
  if (!/All migrations have been successfully applied|No pending migrations to apply/.test(out)) {
    throw new Error('migrate deploy did not report success');
  }
  return out.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'ok';
}

function buildPreB2SchemaDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-preb2-'));
  mkdirSync(join(dir, 'migrations'));
  cpSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
  cpSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== B2_MIGRATION)
    .sort();
  for (const name of entries) {
    cpSync(join(MIGRATIONS_DIR, name), join(dir, 'migrations', name), { recursive: true });
  }
  return { dir, schemaPath: join(dir, 'schema.prisma'), count: entries.length };
}

function main() {
  const baseUrl = resolveBaseUrl();
  const parsed = new URL(baseUrl);
  const baseDb = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  tempDb = 'cc_upgrade_' + Math.abs([...String(Date.now())].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) | 0).toString(16).slice(0, 8);
  const tempUrl = baseUrl.replace(/\/[^/]*$/, '/' + tempDb);

  step(`create throwaway database ${tempDb}`, () => {
    psql(baseDb, `DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`);
    psql(baseDb, `CREATE DATABASE "${tempDb}"`);
    return `db=${tempDb} host=${parsed.host}`;
  });

  const pre = buildPreB2SchemaDir();
  tempDir = pre.dir;

  step(`stage 1: apply pre-B2 migrations (${pre.count} migrations, excluding ${B2_MIGRATION})`, () =>
    migrateDeploy(pre.schemaPath, tempUrl),
  );

  step('stage 1: seed synthetic legacy data', () => {
    psql(
      tempDb,
      `INSERT INTO "Organization" ("id","name","slug","status","plan","locale","timezone","createdAt","updatedAt")
       VALUES ('${ORG_A}','B2 Upgrade A','b2-upgrade-a','ACTIVE','TRIAL','zh-CN','Asia/Shanghai',now(),now()),
              ('${ORG_B}','B2 Upgrade B','b2-upgrade-b','ACTIVE','TRIAL','zh-CN','Asia/Shanghai',now(),now());
       INSERT INTO "Case" ("id","organizationId","caseNo","title","domain","currency","openedAt","updatedAt")
       VALUES ('${CASE_A}','${ORG_A}','B2-UP-CASE-1','B2 upgrade fixture','LOGISTICS','USD',now(),now());
       INSERT INTO "Claim" ("id","organizationId","caseId","round","target","updatedAt")
       VALUES ('${CLAIM_A}','${ORG_A}','${CASE_A}',1,'CARRIER',now());
       INSERT INTO "RuleSet" ("id","name","ownerType","ownerKey","organizationId","domain","channel","scope","createdAt","updatedAt")
       VALUES ('${RS_SYS}','B2 UPGRADE SYSTEM RULESET','SYSTEM','GLOBAL',NULL,'LOGISTICS','UPS','FREIGHT_RATE',now(),now()),
              ('${RS_A}','B2 UPGRADE TENANT A RULESET','TENANT','${ORG_A}','${ORG_A}','LOGISTICS','UPS','FREIGHT_RATE',now(),now());
       INSERT INTO "RuleVersion" ("id","ruleSetId","organizationId","tier","source","version","effectiveFrom","definition","isActive","createdAt")
       VALUES ('${RV_SYS}','${RS_SYS}',NULL,'DEFAULT','B2-UPGRADE','v1',now(),'{}'::jsonb,true,now()),
              ('${RV_A}','${RS_A}','${ORG_A}','DEFAULT','B2-UPGRADE','v1',now(),'{}'::jsonb,true,now());
       INSERT INTO "RuleEvaluation" ("id","organizationId","ruleVersionId","result","computed","evaluatedAt")
       VALUES ('${EV_A_SYS}','${ORG_A}','${RV_SYS}','PASS'::"RuleEvaluationResult",'{}'::jsonb,now()),
              ('${EV_B_SYS}','${ORG_B}','${RV_SYS}','PASS'::"RuleEvaluationResult",'{}'::jsonb,now());`,
    );
    const seeded = psql(
      tempDb,
      `SELECT (SELECT count(*) FROM "Case" WHERE "id"='${CASE_A}')
            || '/' || (SELECT count(*) FROM "Claim" WHERE "id"='${CLAIM_A}')
            || '/' || (SELECT count(*) FROM "RuleEvaluation" WHERE "id" IN ('${EV_A_SYS}','${EV_B_SYS}'))`,
    );
    if (seeded !== '1/1/2') throw new Error('legacy seed incomplete: ' + seeded);
    return 'Case/Claim/RuleEvaluation = 1/1/2';
  });

  step('stage 2: apply B2 migration only, preserving data (repo migrations dir)', () =>
    migrateDeploy(join(PRISMA_DIR, 'schema.prisma'), tempUrl),
  );

  step('stage 2: data and relations preserved (no reset / no data loss)', () => {
    const orgOfCase = psql(tempDb, `SELECT "organizationId" FROM "Case" WHERE "id"='${CASE_A}'`);
    if (orgOfCase !== ORG_A) throw new Error('Case ownership changed: ' + orgOfCase);
    const sameTenantClaim = psql(
      tempDb,
      `SELECT count(*) FROM "Claim" c JOIN "Case" k ON k."id" = c."caseId"
        WHERE c."id"='${CLAIM_A}' AND c."organizationId" = k."organizationId"`,
    );
    if (sameTenantClaim !== '1') throw new Error('Claim->Case relation lost');
    const evalRef = psql(
      tempDb,
      `SELECT count(*) FROM "RuleEvaluation" WHERE "id" IN ('${EV_A_SYS}','${EV_B_SYS}') AND "ruleVersionId"='${RV_SYS}'`,
    );
    if (evalRef !== '2') throw new Error('RuleEvaluation reference changed');
    return 'ownership + relations intact';
  });

  step('stage 2: organizationId-immutability triggers installed per table', () => {
    const installed = psql(
      tempDb,
      `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname LIKE 'cc_tenant_immutable__%' AND tgtype = 19`,
    );
    const expected = psql(
      tempDb,
      `SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'organizationId' AND table_name <> '_prisma_migrations'`,
    );
    if (installed !== expected) throw new Error(`immutable=${installed} expected=${expected}`);
    return `immutable=${installed} (= tables with organizationId)`;
  });

  step('stage 2: checklist SQL passes against upgraded database', () => {
    const sql = run(NODE_BIN, [join(ROOT, 'tools', 'tenant-triggers', 'emit-check-sql.mjs')]);
    psql(tempDb, sql);
    return 'tools/tenant-triggers checklist OK';
  });

  step('stage 2: post-upgrade guards actually reject illegal writes', () => {
    const parent = psql(tempDb, `UPDATE "Case" SET "organizationId"='${ORG_B}' WHERE "id"='${CASE_A}'`, {
      expectFail: true,
      label: 'parent-organizationId',
    });
    if (!/TENANT_REASSIGNMENT_FORBIDDEN/.test(parent)) throw new Error('parent reassignment not blocked: ' + parent);

    const ownership = psql(tempDb, `UPDATE "RuleSet" SET "ownerKey"='${ORG_B}' WHERE "id"='${RS_SYS}'`, {
      expectFail: true,
      label: 'ruleset-ownership',
    });
    if (!/RULESET_OWNERSHIP_IMMUTABLE/.test(ownership)) throw new Error('RuleSet ownership change not blocked: ' + ownership);

    const crossInsert = psql(
      tempDb,
      `INSERT INTO "RuleEvaluation" ("id","organizationId","ruleVersionId","result","computed","evaluatedAt")
       VALUES ('b2e30000-0000-4000-8000-000000000009','${ORG_B}','${RV_A}','PASS'::"RuleEvaluationResult",'{}'::jsonb,now())`,
      { expectFail: true, label: 'cross-tenant-insert' },
    );
    if (!/cross-tenant reference blocked/.test(crossInsert)) {
      throw new Error('cross-tenant insert not blocked: ' + crossInsert);
    }

    const crossUpdate = psql(
      tempDb,
      `UPDATE "RuleEvaluation" SET "ruleVersionId"='${RV_A}' WHERE "id"='${EV_B_SYS}'`,
      { expectFail: true, label: 'cross-tenant-update' },
    );
    if (!/cross-tenant reference blocked/.test(crossUpdate)) {
      throw new Error('cross-tenant update not blocked: ' + crossUpdate);
    }

    const stillSame = psql(
      tempDb,
      `SELECT (SELECT "organizationId" FROM "Case" WHERE "id"='${CASE_A}')
            || '/' || (SELECT "ruleVersionId" FROM "RuleEvaluation" WHERE "id"='${EV_B_SYS}')
            || '/' || (SELECT "ruleVersionId" FROM "RuleEvaluation" WHERE "id"='${EV_A_SYS}')`,
    );
    if (stillSame !== `${ORG_A}/${RV_SYS}/${RV_SYS}`) throw new Error('state changed after rejected writes: ' + stillSame);
    return 'parent / RuleSet ownership / cross-tenant INSERT+UPDATE all rejected; state unchanged';
  });

  step('stage 2: second migrate deploy is a no-op (idempotent)', () =>
    migrateDeploy(join(PRISMA_DIR, 'schema.prisma'), tempUrl, { expectPending: true }),
  );

  return `TWO_STAGE_UPGRADE_OK db=${tempDb} preB2Migrations=${pre.count}`;
}

let exitCode = 0;
try {
  const summary = main();
  console.log(summary);
  for (const item of steps) console.log('  OK ' + item.name + (item.detail ? ' :: ' + item.detail : ''));
} catch (error) {
  exitCode = 1;
  console.log('TWO_STAGE_UPGRADE_FAILED');
  for (const item of steps) console.log('  ' + (item.ok ? 'OK ' : 'FAIL ') + item.name + (item.detail ? ' :: ' + item.detail : ''));
  console.log('cause: ' + (error instanceof Error ? error.message : String(error)));
} finally {
  if (tempDb) {
    try {
      const baseUrl = resolveBaseUrl();
      const baseDb = decodeURIComponent(new URL(baseUrl).pathname.replace(/^\//, ''));
      psql(baseDb, `DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`);
      console.log('cleanup: dropped ' + tempDb);
    } catch {
      console.log('cleanup: could not drop ' + tempDb);
    }
  }
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
process.exit(exitCode);
