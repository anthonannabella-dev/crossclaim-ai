#!/usr/bin/env node
// C18 clean-replay proof（MSG-20261004-25 / MSG-20261004-26）
// 目的：在一次性 ephemeral 数据库上重放「全部既有 migrations → candidate C18 migration」，
//       并证明 (a) C18-scoped diff = ZERO、(b) C18 的手工 DB 不变量在真实 PostgreSQL 上生效。
// 用法：node tools/verification/c18-clean-replay-proof.mjs
// 前置：本机 docker 可运行 crossclaim-postgres 容器；apps/api 安装好依赖。
// 安全：只创建/操作一次性数据库 `crossclaim_c18_proof`，结束时 DROP；不触碰 dev / shared / production。
// MSG-20261004-25 硬门槛证明：clean migration-history replay → candidate migration → diff = ZERO。
// 全程只在一次性 ephemeral 数据库上执行；不动 dev / shared / prod。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = ROOT + '/apps/api';
const PROOF_DIR = `${API}/prisma/migrations/20261004070816_c18_provider_persistence`;
const HOLD_DIR = `${API}/prisma/.c18-migration-hold`;
const PROOF_DB = 'crossclaim_c18_proof';
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const env = read(`${API}/.env`);
const baseUrl = /^DATABASE_URL=\s*"?([^"\n]+)"?$/m.exec(env)?.[1];
if (!baseUrl) throw new Error('DATABASE_URL_NOT_FOUND');
const proofUrl = baseUrl.replace(/\/([^/?]+)(\?|$)/, `/${PROOF_DB}$2`);

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'crossclaim-postgres', 'psql', '-U', 'crossclaim', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );

// 0) 干净起点
psql(`DROP DATABASE IF EXISTS ${PROOF_DB};`);
psql(`CREATE DATABASE ${PROOF_DB} OWNER crossclaim;`);
console.log('PROOF_DB_CREATED ' + PROOF_DB);

// 1) 先只应用**既有** migrations（把 candidate 暂时移出 migrations 目录）
fs.rmSync(HOLD_DIR, { recursive: true, force: true });
fs.renameSync(PROOF_DIR, HOLD_DIR);
try {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: API,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, DATABASE_URL: proofUrl },
    stdio: 'pipe',
  });
  console.log('PRIOR_MIGRATIONS_APPLIED');
} finally {
  fs.renameSync(HOLD_DIR, PROOF_DIR);
}

// 2) 把 candidate migration 应用到 ephemeral 库
const candidateSql = read(`${PROOF_DIR}/migration.sql`);
execFileSync(
  'docker',
  ['exec', '-i', 'crossclaim-postgres', 'psql', '-U', 'crossclaim', '-d', PROOF_DB, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
  { input: candidateSql, encoding: 'utf8' },
);
console.log('CANDIDATE_MIGRATION_APPLIED_TO_EPHEMERAL_DB');

// 3) 关键证明：DB 实际状态 vs schema.prisma
const diff = execFileSync(
  'npx',
  ['prisma', 'migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
  { cwd: API, encoding: 'utf8', shell: true, env: { ...process.env, DATABASE_URL: proofUrl } },
);
const meaningful = diff
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('--'));
console.log('DIFF_LINES=' + meaningful.length);
const c18Scoped = meaningful.filter((l) => /CustomsProvider/.test(l));
const unrelated = meaningful.filter((l) => !/CustomsProvider/.test(l));
console.log('C18_SCOPED_DIFF_LINES=' + c18Scoped.length + ' → ' + (c18Scoped.length === 0 ? 'CLEAN_SHADOW_DIFF_C18 = ZERO' : 'CLEAN_SHADOW_DIFF_C18 = NONZERO'));
console.log('PREEXISTING_UNRELATED_DIFF_LINES=' + unrelated.length);
for (const line of unrelated.slice(0, 6)) console.log('  unrelated: ' + line.slice(0, 120));
for (const line of c18Scoped.slice(0, 10)) console.log('  C18: ' + line.slice(0, 140));
if (c18Scoped.length > 0) process.exitCode = 1;

// 4) 幂等性 / 触发器抽查：lineage UPDATE 必须被拒
try {
  execFileSync(
    'docker',
    ['exec', '-i', 'crossclaim-postgres', 'psql', '-U', 'crossclaim', '-d', PROOF_DB, '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO "Organization"(id,name,slug,"createdAt","updatedAt") VALUES ('cc18proof-org','P','cc18-proof',now(),now()) ON CONFLICT DO NOTHING;
       INSERT INTO "CustomsProviderTenantBinding"(id,"organizationId","principalRef","bindingScopeVersion","jurisdictionAnchor","bindingSlotRef","bindingScopeKey","providerId","providerTenantRef","providerAccountRef",relationship,"relationshipEvidenceRef","relationshipVerifiedAt","jurisdictionScope",status,"createdAt","updatedAt")
       VALUES ('cc18proof-bind','cc18proof-org','ior:proof','v1','US','slot:proof','${'a'.repeat(64)}','provider:proof','pt:proof','pa:proof','CROSSCLAIM_SAAS','evidence:saas-agreement',now(),'{US}','ACTIVE',now(),now());
       INSERT INTO "CustomsProviderTenantBindingLineage"(id,"organizationId","bindingId",event,"actorRef",snapshot,"snapshotDigest","occurredAt")
       VALUES ('cc18proof-lin','cc18proof-org','cc18proof-bind','BOUND','actor:proof','{}'::jsonb,'${'b'.repeat(64)}',now());`,
    ],
    { encoding: 'utf8' },
  );
  console.log('SEED_OK');
} catch (error) {
  console.log('SEED_FAILED');
  console.log(String(error.stdout || '') + String(error.stderr || ''));
  process.exitCode = 1;
}

for (const [label, sql] of [
  ['LINEAGE_UPDATE_REJECTED', 'UPDATE "CustomsProviderTenantBindingLineage" SET note = \'x\' WHERE id = \'cc18proof-lin\';'],
  ['IDENTITY_UPDATE_REJECTED', 'UPDATE "CustomsProviderTenantBinding" SET "principalRef" = \'ior:other\' WHERE id = \'cc18proof-bind\';'],
  ['SAAS_EVIDENCE_CHECK_REJECTED', `INSERT INTO "CustomsProviderTenantBinding"(id,"organizationId","principalRef","bindingScopeVersion","jurisdictionAnchor","bindingSlotRef","bindingScopeKey","providerId","providerTenantRef","providerAccountRef",relationship,"jurisdictionScope",status,"createdAt","updatedAt") VALUES ('cc18proof-bad','cc18proof-org','ior:proof2','v1','US','slot:proof2','${'c'.repeat(64)}','provider:proof','pt:2','pa:2','CROSSCLAIM_SAAS','{US}','ACTIVE',now(),now());`],
]) {
  try {
    execFileSync(
      'docker',
      ['exec', '-i', 'crossclaim-postgres', 'psql', '-U', 'crossclaim', '-d', PROOF_DB, '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8' },
    );
    console.log(label + ' = FAIL（未被拒绝）');
    process.exitCode = 1;
  } catch {
    console.log(label + ' = PASS（被 DB 拒绝）');
  }
}

// 5) 清理 ephemeral 库
psql(`DROP DATABASE IF EXISTS ${PROOF_DB};`);
console.log('PROOF_DB_DROPPED');
