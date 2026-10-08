#!/usr/bin/env node
/**
 * PHASE 2 / CHANGE 4A（审计 MSG-20261008-20）—— SI-RSI 套件重复运行取证器
 * ---------------------------------------------------------------
 * 复审要求：
 *   · 保存**完整测试日志**（含失败用例名、堆栈与**测试数据库标记**）；
 *   · 在固定环境下**连续 ≥5 轮**相关完整套件全部通过后再提交记录。
 *
 * 本脚本的性质（重要）：
 *   · **一次性**工具 —— 没有定时器、没有守护进程、没有服务端；跑完 N 轮即退出并返回退出码；
 *   · **不是**产品 Runtime / Scheduler，也不写产品数据库（只跑测试并落日志文件）；
 *   · 每轮失败时**不会自动重试或掩盖**：如实记录并让退出码非 0。
 *
 * 用法：
 *   node tools/dev/run-si-rsi-suite.mjs --rounds 5 --label change4a-5x
 *   node tools/dev/run-si-rsi-suite.mjs --rounds 5 --label change4a-perfile-5x --per-file
 *
 * 参数：
 *   --root <dir>     仓库根（默认 = 本脚本上两级）
 *   --rounds <n>     轮数（默认 5）
 *   --label <name>   本次取证的标签（默认 si-rsi）
 *   --per-file       每个测试文件单独进程运行（强隔离模式，用于定位偶发失败）
 *   --files a,b,c    显式指定测试文件（相对 apps/api），默认自动发现 src/__tests__/si-rsi-*.test.ts
 *   --all            递归发现**全部**测试文件（src/**\/*.test.ts）—— 用于「全量 API 回归」取证
 *
 * 产物（`tools/dev/logs/` 已在 .gitignore 中，属运行时产物）：
 *   tools/dev/logs/si-rsi-suite/<label>-round<N>.log        每轮完整原始日志
 *   tools/dev/logs/si-rsi-suite/<label>-summary.json        汇总（轮次 / 失败用例名 / 逻辑路径）
 */

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const parseArgs = (argv) => {
  const args = { rounds: 5, label: 'si-rsi', perFile: false, all: false, files: null, root: path.resolve(SCRIPT_DIR, '../..') };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--rounds') args.rounds = Number(argv[++i]);
    else if (token === '--label') args.label = String(argv[++i]);
    else if (token === '--root') args.root = path.resolve(String(argv[++i]));
    else if (token === '--files') args.files = String(argv[++i]).split(',').map((s) => s.trim()).filter((s) => s !== '');
    else if (token === '--per-file') args.perFile = true;
    else if (token === '--all') args.all = true;
    else if (token === '--help' || token === '-h') {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'));
      process.exit(0);
    }
  }
  if (!Number.isInteger(args.rounds) || args.rounds < 1) throw new Error('--rounds 必须是正整数');
  return args;
};

const stripAnsi = (text) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');

/** 只回「主机:端口/库名」——绝不回显用户名或口令 */
const databaseMarkerFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port === '' ? '5432' : parsed.port}${parsed.pathname}`;
  } catch {
    return 'DB_MARKER_UNPARSEABLE';
  }
};

/** 与 apps/api/src/test-setup.ts 一致的极简 .env 解析（不打印任何取值） */
const readDatabaseUrl = (root, env) => {
  if (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim() !== '') return env.DATABASE_URL;
  const envPath = path.join(root, 'apps/api/.env');
  if (!existsSync(envPath)) return null;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    if (line.slice(0, separator).trim() !== 'DATABASE_URL') continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
};

const git = (root, args) => {
  const result = spawnSync('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], { encoding: 'utf8' });
  return result.status === 0 ? stripAnsi(String(result.stdout)).trim() : null;
};

const discoverFiles = (apiDir) => {
  const dir = path.join(apiDir, 'src/__tests__');
  return readdirSync(dir)
    .filter((name) => name.startsWith('si-rsi-') && name.endsWith('.test.ts'))
    .sort()
    .map((name) => `src/__tests__/${name}`);
};

/** `--all`：递归发现全部测试文件（用于「全量 API 回归」取证） */
const discoverAllFiles = (apiDir) => {
  const rootDir = path.join(apiDir, 'src');
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) found.push(path.relative(apiDir, full).replace(/\\/g, '/'));
    }
  };
  walk(rootDir);
  return found.sort();
};

/** 从原始日志中提取「失败用例名 + 堆栈片段」（完整日志另有落盘） */
const extractFailures = (log) => {
  const failedTestNames = [];
  const stackLines = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*×\s/.test(line)) failedTestNames.push(line.replace(/^\s*×\s*/, '').trim());
    const m = /→\s*(.+)$/.exec(line);
    if (m !== null && /expected|AssertionError|Error/i.test(line)) stackLines.push(m[1].trim());
  }
  const failedIndex = lines.findIndex((line) => /Failed Tests \d+/.test(line));
  const excerpt = failedIndex >= 0 ? lines.slice(failedIndex, failedIndex + 120).join('\n') : '';
  return { failedTestNames, stackLines, failureExcerpt: excerpt };
};

const summaryLines = (log) => {
  const pick = (pattern) => {
    const match = log.match(pattern);
    return match === null ? null : match[0].trim();
  };
  return {
    testFilesLine: pick(/Test Files\s+[^\n]+/),
    testsLine: pick(/Tests\s+[^\n]+/),
    durationLine: pick(/Duration\s+[^\n]+/),
  };
};

const runVitest = (apiDir, files, logPath) => {
  const vitestBin = path.join(apiDir, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitestBin)) throw new Error(`vitest 未安装: ${vitestBin}`);
  const startedAt = new Date();
  /**
   * 日志**直接写文件描述符**（而不是等进程结束后再落盘）：
   * 长跑（如全量 480 文件回归）期间可以 tail 日志观察进度，避免「跑了几十分钟不知卡在哪」。
   */
  const fd = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [vitestBin, 'run', ...files], {
      cwd: apiDir,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
  } finally {
    closeSync(fd);
  }
  const durationMs = Date.now() - startedAt.getTime();
  const raw = stripAnsi(readFileSync(logPath, 'utf8'));
  writeFileSync(logPath, raw, 'utf8');
  return { exitCode: result.status ?? 1, durationMs, log: raw, startedAt };
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root;
  const apiDir = path.join(root, 'apps/api');
  if (!existsSync(apiDir)) throw new Error(`apps/api 不存在: ${apiDir}`);

  const files = args.files ?? (args.all ? discoverAllFiles(apiDir) : discoverFiles(apiDir));
  const logsDir = path.join(root, 'tools/dev/logs/si-rsi-suite');
  mkdirSync(logsDir, { recursive: true });

  const dbUrl = readDatabaseUrl(root, process.env);
  const databaseMarker = dbUrl === null ? 'DB_MARKER_UNAVAILABLE' : databaseMarkerFromUrl(dbUrl);
  const vitestVersion = (() => {
    try {
      return JSON.parse(readFileSync(path.join(apiDir, 'node_modules/vitest/package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  })();
  const headSha = git(root, ['rev-parse', 'HEAD']);
  const dirty = (git(root, ['status', '--porcelain']) ?? '') !== '';

  const rounds = [];
  process.stdout.write(
    `[si-rsi-suite] label=${args.label} mode=${args.perFile ? 'per-file' : 'suite'} rounds=${args.rounds} files=${files.length} db=${databaseMarker} head=${String(headSha).slice(0, 8)} dirty=${dirty}\n`,
  );

  for (let round = 1; round <= args.rounds; round += 1) {
    const logPath = path.join(logsDir, `${args.label}-round${round}.log`);
    const run = args.perFile
      ? (() => {
          const startedAt = new Date();
          let exitCode = 0;
          let durationMs = 0;
          const parts = [];
          const fileResults = [];
          for (const file of files) {
            const perFileLog = path.join(logsDir, `${args.label}-round${round}-${path.basename(file)}.log`);
            const one = runVitest(apiDir, [file], perFileLog);
            fileResults.push({
              file,
              exitCode: one.exitCode,
              testsLine: summaryLines(one.log).testsLine,
              failedTestNames: extractFailures(one.log).failedTestNames,
            });
            process.stdout.write(
              `[si-rsi-suite]   file=${file} exit=${one.exitCode} ${summaryLines(one.log).testsLine ?? ''}\n`,
            );
            exitCode = exitCode === 0 && one.exitCode !== 0 ? one.exitCode : exitCode;
            durationMs += one.durationMs;
            parts.push(`#### FILE ${file} exit=${one.exitCode}\n${one.log}`);
          }
          const raw = parts.join('\n');
          writeFileSync(logPath, raw, 'utf8');
          return { exitCode, durationMs, log: raw, startedAt, fileResults };
        })()
      : runVitest(apiDir, files, logPath);

    const failures = extractFailures(run.log);
    const lines = summaryLines(run.log);
    const roundRecord = {
      round,
      startedAt: run.startedAt.toISOString(),
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      ...lines,
      failedTestNames: failures.failedTestNames,
      stackLines: failures.stackLines.slice(0, 20),
      failureExcerpt: failures.failureExcerpt,
      ...(run.fileResults === undefined ? {} : { fileResults: run.fileResults }),
      logPath: path.relative(root, logPath).replace(/\\/g, '/'),
    };
    rounds.push(roundRecord);
    process.stdout.write(
      `[si-rsi-suite] round=${round} exit=${run.exitCode} ${lines.testsLine ?? ''} | ${lines.durationLine ?? ''} | failed=${failures.failedTestNames.length}\n`,
    );
  }

  const failedRounds = rounds.filter((r) => r.exitCode !== 0).length;
  const summary = {
    label: args.label,
    generatedAt: new Date().toISOString(),
    mode: args.perFile ? 'per-file' : 'suite',
    rounds: args.rounds,
    files,
    headSha,
    gitDirty: dirty,
    nodeVersion: process.version,
    vitestVersion,
    databaseMarker,
    failedRounds,
    result: failedRounds === 0 ? 'ALL_GREEN' : 'FAILED',
    detail: rounds,
  };
  const summaryPath = path.join(logsDir, `${args.label}-summary.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  process.stdout.write(`[si-rsi-suite] RESULT=${summary.result} failedRounds=${failedRounds} summary=${path.relative(root, summaryPath).replace(/\\/g, '/')}\n`);
  process.exit(failedRounds === 0 ? 0 : 1);
};

main();
