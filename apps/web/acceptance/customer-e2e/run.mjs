/**
 * CUSTOMER-UX-SANDBOX-E2E — 运行器（dev/test-only）。
 * ---------------------------------------------------------------
 * 1) 启动 sandbox API（apps/api/acceptance/sandbox-server.ts，端口 3100，注册开启 + 文件邮件出口）
 * 2) 启动 web（next dev，端口 3011，CROSSCLAIM_API_URL=http://127.0.0.1:3100）
 * 3) 用真实 Edge 跑客户旅程（desktop + mobile），输出截图与 journey-summary.json
 *
 * 用法：node apps/web/acceptance/customer-e2e/run.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runJourney } from './journey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
const API_ROOT = path.join(REPO_ROOT, 'apps', 'api');

const API_PORT = Number(process.env.ACCEPTANCE_API_PORT ?? 3100);
const WEB_PORT = Number(process.env.ACCEPTANCE_WEB_PORT ?? 3011);
const API_BASE = 'http://127.0.0.1:' + API_PORT;
const WEB_BASE = 'http://127.0.0.1:' + WEB_PORT;
const OUTBOX = path.join(REPO_ROOT, 'reports', 'acceptance', 'email-outbox.jsonl');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(REPO_ROOT, 'reports', 'acceptance', RUN_ID);

const children = [];
const logs = {};

function spawnNode(args, cwd, env, name) {
  const logFile = path.join(OUT_DIR, name + '.log');
  mkdirSync(OUT_DIR, { recursive: true });
  const out = existsSync(logFile) ? 'a' : 'w';
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(String(d)));
  child.stderr.on('data', (d) => chunks.push(String(d)));
  children.push({ child, name, chunks, logFile });
  return child;
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('timeout waiting for ' + label + ' at ' + url);
}

function readVerificationToken(email) {
  if (!existsSync(OUTBOX)) return null;
  const lines = readFileSync(OUTBOX, 'utf8').split('\n').filter((l) => l.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.to === email && typeof parsed.token === 'string') return parsed.token;
    } catch {
      /* ignore malformed line */
    }
  }
  return null;
}

function shutdown() {
  for (const { child, name, chunks, logFile } of children) {
    try {
      writeFileSync(logFile, chunks.join(''), 'utf8');
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    logs[name] = chunks.join('').slice(-2000);
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(OUTBOX)) rmSync(OUTBOX, { force: true });
  const tasksFile = path.join(REPO_ROOT, 'reports', 'acceptance', 'rsi-tasks.json');
  if (existsSync(tasksFile)) rmSync(tasksFile, { force: true });

  const tsxCli = path.join(API_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const nextCli = path.join(WEB_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');

  spawnNode(
    [tsxCli, 'acceptance/sandbox-server.ts'],
    API_ROOT,
    { ACCEPTANCE_API_PORT: String(API_PORT), ACCEPTANCE_OUTBOX: OUTBOX, LOG_LEVEL: 'warn' },
    'sandbox-api',
  );
  await waitFor(API_BASE + '/health', 60000, 'sandbox API');

  spawnNode(
    [nextCli, 'dev', '-p', String(WEB_PORT)],
    WEB_ROOT,
    { CROSSCLAIM_API_URL: API_BASE, PUBLIC_SIGNUP_ENABLED: 'true' },
    'web',
  );
  await waitFor(WEB_BASE + '/', 180000, 'web dev server');

  const stamp = Date.now();
  const email = 'acceptance.customer+' + stamp + '@example.com';
  const summary = await runJourney({
    webBase: WEB_BASE,
    apiBase: API_BASE,
    outDir: OUT_DIR,
    email,
    password: 'Sandbox-Acceptance-2026!',
    organizationName: 'Acceptance Sandbox Co ' + stamp,
    displayName: 'Sandbox Customer',
    readVerificationToken,
  });

  const full = {
    ...summary,
    runId: RUN_ID,
    email,
    outDir: OUT_DIR,
    apiBase: API_BASE,
    webBase: WEB_BASE,
  };
  writeFileSync(path.join(OUT_DIR, 'run-summary.json'), JSON.stringify(full, null, 2), 'utf8');
  console.log('---');
  console.log('ACCEPTANCE_RUN_DIR=' + OUT_DIR);
  console.log('CHECKS_PASSED=' + summary.passed + ' CHECKS_FAILED=' + summary.failed);
  return summary.failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    shutdown();
    process.exit(code);
  })
  .catch((error) => {
    console.error('ACCEPTANCE_HARNESS_ERROR ' + String(error));
    shutdown();
    for (const [name, log] of Object.entries(logs)) console.error('--- ' + name + ' ---\n' + log);
    process.exit(2);
  });
