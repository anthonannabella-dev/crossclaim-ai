#!/usr/bin/env node
/**
 * C18 exact-order replay 证明（MSG-20261004-27 要求的最后一道执行层门槛）
 * ---------------------------------------------------------------
 * 与 c18-clean-replay-proof.mjs 的区别：**不移出任何 migration、不手工 psql**。
 * 这里模拟生产真实执行顺序：目录里所有 migration 原样，一次 `prisma migrate deploy`。
 *
 * 通过条件（任一不满足即失败退出非零）：
 *   1) `prisma migrate deploy` 成功；
 *   2) `prisma migrate diff`（DB → schema.prisma）**有意义的差异行数 = 0**（不只看 CustomsProvider*）；
 *   3) `prisma migrate status` 显示数据库与 migration 历史一致（fully applied）；
 * 最后 DROP 一次性数据库。全程不触碰 dev / shared / production。
 *
 * 用法：node tools/verification/c18-exact-order-replay.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');
const PROOF_DB = 'crossclaim_c18_exact_order';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const baseUrl = /^DATABASE_URL=\s*"?([^"\n]+)"?$/m.exec(read(path.join(API, '.env')))?.[1];
if (!baseUrl) throw new Error('DATABASE_URL_NOT_FOUND');
const proofUrl = baseUrl.replace(/\/([^/?]+)(\?|$)/, `/${PROOF_DB}$2`);

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'crossclaim-postgres', 'psql', '-U', 'crossclaim', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );
const prisma = (args) =>
  execFileSync('npx', ['prisma', ...args], {
    cwd: API,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, DATABASE_URL: proofUrl },
  });

psql(`DROP DATABASE IF EXISTS ${PROOF_DB};`);
psql(`CREATE DATABASE ${PROOF_DB} OWNER crossclaim;`);
console.log('PROOF_DB_CREATED ' + PROOF_DB);

let failed = false;
try {
  const deploy = prisma(['migrate', 'deploy']);
  const applied = (deploy.match(/migrations have been applied/g) ?? []).length;
  console.log('MIGRATE_DEPLOY_OK（all migrations in place, no manual psql）');
  void applied;
} catch (error) {
  console.log('MIGRATE_DEPLOY_FAILED');
  console.log((String(error.stdout || '') + String(error.stderr || '')).slice(-800));
  failed = true;
}

if (!failed) {
  const diff = prisma([
    'migrate',
    'diff',
    '--from-schema-datasource',
    'prisma/schema.prisma',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ]);
  const meaningful = diff
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('--'));
  console.log('EXACT_ORDER_DIFF_LINES=' + meaningful.length);
  if (meaningful.length === 0) {
    console.log('EXACT_ORDER_WHOLE_SCHEMA_DIFF = ZERO');
  } else {
    console.log('EXACT_ORDER_WHOLE_SCHEMA_DIFF = NONZERO（按裁决直接判失败）');
    for (const line of meaningful.slice(0, 10)) console.log('  ' + line.slice(0, 140));
    failed = true;
  }
}

if (!failed) {
  try {
    const status = prisma(['migrate', 'status']);
    const upToDate = /Database schema is up to date/i.test(status);
    console.log('MIGRATE_STATUS_UP_TO_DATE=' + upToDate);
    if (!upToDate) failed = true;
  } catch (error) {
    console.log('MIGRATE_STATUS_FAILED');
    console.log((String(error.stdout || '') + String(error.stderr || '')).slice(-400));
    failed = true;
  }
}

psql(`DROP DATABASE IF EXISTS ${PROOF_DB};`);
console.log('PROOF_DB_DROPPED');
console.log(failed ? 'EXACT_ORDER_REPLAY = FAIL' : 'EXACT_ORDER_REPLAY = PASS');
process.exitCode = failed ? 1 : 0;
