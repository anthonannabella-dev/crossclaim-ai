#!/usr/bin/env node
/**
 * 在**一次性已迁移数据库**上运行指定的 PG 测试文件。
 * 用途：C18 的三张表尚未部署到任何长期库（migration 仍 HOLD），
 * 因此 store / E2E 断言必须在临时库上验证。
 *
 * 用法：node tools/verification/run-db-test-on-ephemeral.mjs <test-file...>
 * 行为：建库 → prisma migrate deploy（全部 migration）→ vitest run <files> → DROP 临时库。
 * 安全：只创建/操作 `crossclaim_ephemeral_test`，结束即删；不触碰 dev / shared / production。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');
const DB = 'crossclaim_ephemeral_test';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/verification/run-db-test-on-ephemeral.mjs <test-file...>');
  process.exit(1);
}

const env = fs.readFileSync(path.join(API, '.env'), 'utf8');
const baseUrl = /^DATABASE_URL=\s*"?([^"\n]+)"?$/m.exec(env)?.[1];
if (!baseUrl) throw new Error('DATABASE_URL_NOT_FOUND');
const url = baseUrl.replace(/\/([^/?]+)(\?|$)/, `/${DB}$2`);

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'crossclaim-postgres', 'psql', '-U', 'crossclaim', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );

psql(`DROP DATABASE IF EXISTS ${DB};`);
psql(`CREATE DATABASE ${DB} OWNER crossclaim;`);
console.log('EPHEMERAL_DB_CREATED ' + DB);

let failed = false;
try {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: API,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  console.log('EPHEMERAL_MIGRATIONS_APPLIED');
} catch (error) {
  console.log('MIGRATE_FAILED');
  console.log((String(error.stdout || '') + String(error.stderr || '')).slice(-600));
  failed = true;
}

if (!failed) {
  try {
    const out = execFileSync('npx', ['vitest', 'run', ...files], {
      cwd: API,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, DATABASE_URL: url },
      maxBuffer: 256 * 1024 * 1024,
    });
    console.log(
      out
        .split('\n')
        .filter((l) => /✓|×|Test Files|Tests  |FAIL/.test(l))
        .join('\n'),
    );
    console.log('EPHEMERAL_VITEST_EXIT=0');
  } catch (error) {
    const out = String(error.stdout || '') + String(error.stderr || '');
    console.log(
      out
        .split('\n')
        .filter((l) => /✓|×|Test Files|Tests  |FAIL|AssertionError|PrismaClient/.test(l))
        .slice(-60)
        .join('\n'),
    );
    console.log('EPHEMERAL_VITEST_EXIT=' + (error.status ?? 'unknown'));
    failed = true;
  }
}

psql(`DROP DATABASE IF EXISTS ${DB};`);
console.log('EPHEMERAL_DB_DROPPED');
process.exitCode = failed ? 1 : 0;
