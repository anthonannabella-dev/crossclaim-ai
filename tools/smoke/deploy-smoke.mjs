#!/usr/bin/env node
/**
 * P2-1 Deployment Smoke（MSG-20260929-70 D4）
 * ---------------------------------------------------------------
 * S-1 fresh install：空数据库 -> migrate deploy -> 启动 API -> /health 200 -> /readyz 200
 * S-2 migration upgrade：同一库再次 migrate deploy（幂等）-> 迁移计数一致 -> 触发器 28
 *
 * 安全要求：
 *   - 只用**测试 secret**（脚本内生成随机值），不使用任何生产凭据
 *   - 使用随机容器名 / 随机端口 / 随机数据库名
 *   - 生命周期结束销毁容器（--rm + 显式 cleanup）
 *   - 不写入任何 dump / 备份产物
 *
 * 用法：node tools/smoke/deploy-smoke.mjs
 * 退出码：0 = 全部通过；1 = 失败（打印失败步骤）
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = process.cwd();
const API_DIR = ROOT + '/apps/api';
const PG_IMAGE = process.env.SMOKE_PG_IMAGE ?? 'postgres:16-alpine';
const NODE_BIN = process.execPath;
const PRISMA_CLI = API_DIR + '/node_modules/prisma/build/index.js';
const TSX_CLI = API_DIR + '/node_modules/tsx/dist/cli.mjs';

/** 同步等待（避免在同步流程里引入额外子进程） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const container = 'crossclaim-smoke-' + randomUUID().slice(0, 8);
const dbName = 'smoke_' + randomUUID().slice(0, 8).replace(/-/g, '');
const dbUser = 'smoke';
const dbPassword = randomUUID().replace(/-/g, '');
const apiPort = 31000 + Math.floor(Math.random() * 2000);
const steps = [];

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

async function step(name, fn) {
  try {
    const detail = await fn();
    const entry = { name, ok: true, detail: detail ?? '' };
    steps.push(entry);
    return entry;
  } catch (error) {
    const entry = {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
    steps.push(entry);
    throw error;
  }
}

function cleanup() {
  try {
    run('docker', ['rm', '-f', container]);
  } catch {
    /* 已销毁或从未创建 */
  }
}

async function main() {
  await step('docker available', () => {
    run('docker', ['version', '--format', '{{.Server.Version}}']);
    return 'docker server reachable';
  });

  await step('start postgres (S-1: empty database)', () => {
    run('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-e',
      'POSTGRES_USER=' + dbUser,
      '-e',
      'POSTGRES_PASSWORD=' + dbPassword,
      '-e',
      'POSTGRES_DB=' + dbName,
      '-p',
      '127.0.0.1::5432',
      PG_IMAGE,
    ]);
    return 'container ' + container;
  });

  let hostPort = '';
  await step('wait for postgres ready', () => {
    for (let i = 0; i < 30; i += 1) {
      try {
        const mapping = run('docker', ['port', container, '5432']).trim();
        hostPort = mapping.split(':').pop() ?? '';
        if (hostPort) {
          run('docker', ['exec', container, 'pg_isready', '-U', dbUser, '-d', dbName]);
          return 'host port ' + hostPort;
        }
      } catch {
        /* retry */
      }
      sleepSync(1000);
    }
    throw new Error('postgres did not become ready');
  });

  const databaseUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${hostPort}/${dbName}`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    STORAGE_DRIVER: 'local',
    STORAGE_URL_SECRET: randomUUID().replace(/-/g, ''),
    AUDIT_IP_SALT: randomUUID().replace(/-/g, ''),
    METRICS_ENABLED: 'false',
    NODE_ENV: 'test',
    PORT: String(apiPort),
  };

  await step('S-1 migrate deploy (fresh database)', () => {
    const out = run(NODE_BIN, [PRISMA_CLI, 'migrate', 'deploy'], { cwd: API_DIR, env });
    if (!/All migrations have been successfully applied/.test(out)) throw new Error('migrate deploy did not report success');
    return out.trim().split('\n').slice(-1)[0] ?? 'applied';
  });

  const migrationsOnDisk = await step('count migrations on disk', () =>
    String(
      run('node', [
        '-e',
        `const fs=require('fs');process.stdout.write(String(fs.readdirSync(process.argv[1],{withFileTypes:true}).filter((e)=>e.isDirectory()).length));`,
        API_DIR + '/prisma/migrations',
      ]),
    ),
  );
  const expectedMigrations = migrationsOnDisk.detail;

  await step('S-2 migrate deploy (upgrade path, idempotent)', () => {
    const out = run(NODE_BIN, [PRISMA_CLI, 'migrate', 'deploy'], { cwd: API_DIR, env });
    // 升级路径：既可能重新应用，也可能提示无待应用迁移（幂等）
    if (!/All migrations have been successfully applied|No pending migrations to apply/.test(out)) {
      throw new Error('second migrate deploy failed');
    }
    return 'second deploy ok';
  });

  await step('applied migrations == expected', () => {
    const count = run('docker', [
      'exec',
      container,
      'psql',
      '-U',
      dbUser,
      '-d',
      dbName,
      '-t',
      '-c',
      'select count(*) from "_prisma_migrations" where finished_at is not null',
    ]).trim();
    if (count !== expectedMigrations) throw new Error('applied=' + count + ' expected=' + expectedMigrations);
    return count + ' migrations';
  });

  await step('tenant triggers = 28', () => {
    const count = run('docker', [
      'exec',
      container,
      'psql',
      '-U',
      dbUser,
      '-d',
      dbName,
      '-t',
      '-c',
      "select count(*) from pg_trigger where tgname like 'cc_tenant%'",
    ]).trim();
    if (count !== '28') throw new Error('trigger count=' + count);
    return '28 triggers';
  });

  let api = null;
  try {
    await step('boot API', () => {
      api = spawn(NODE_BIN, [TSX_CLI, 'src/server.ts'], {
        cwd: API_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return 'pid ' + (api.pid ?? 'unknown');
    });

    await delay(6000);

    await step('GET /health = 200 (liveness)', async () => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
      if (res.status !== 200) throw new Error('/health status ' + res.status);
      const body = await res.json();
      if (body.killSwitchResolver?.status !== 'ok') throw new Error('killSwitchResolver not ok');
      return 'liveness ok';
    });

    await step('GET /readyz = 200 (readiness)', async () => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/readyz`);
      const body = await res.json();
      if (res.status !== 200 || body.ready !== true) {
        throw new Error('/readyz status ' + res.status + ' reasons=' + JSON.stringify(body.reasons));
      }
      return 'readiness ok';
    });

    await step('/readyz does not leak internal details', async () => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/readyz`);
      const text = await res.text();
      for (const forbidden of ['postgresql://', dbPassword, 'stack', 'ECONNREFUSED', 'prisma']) {
        if (text.includes(forbidden)) throw new Error('leaked: ' + forbidden);
      }
      return 'no leakage';
    });
  } finally {
    if (api) {
      api.kill();
      await delay(500);
    }
  }

  return steps;
}

let exitCode = 0;
try {
  const result = await main();
  console.log('DEPLOY_SMOKE_OK');
  for (const item of result) console.log('  ✓ ' + item.name + (item.detail ? ' :: ' + item.detail : ''));
} catch (error) {
  exitCode = 1;
  console.log('DEPLOY_SMOKE_FAILED');
  for (const item of steps) console.log('  ' + (item.ok ? '✓' : '✗') + ' ' + item.name + (item.detail ? ' :: ' + item.detail : ''));
  console.log('cause: ' + (error instanceof Error ? error.message : String(error)));
} finally {
  cleanup();
}
process.exit(exitCode);
