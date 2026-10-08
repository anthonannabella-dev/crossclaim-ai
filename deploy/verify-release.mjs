#!/usr/bin/env node
/**
 * CrossClaim 发布门禁（部署前**强制**校验）
 * ---------------------------------------------------------------
 * 依据：HOST 指令「部署来源统一与防混乱治理」第 3 / 6 条。
 *
 * 校验项（任一失败 → 退出码 1，必须停止部署）：
 *   1. deploy/release-manifest.json 可读且 releaseCommit 已锁定（非占位符）
 *   2. git HEAD 与 manifest.releaseCommit 一致；或为「仅封装提交」的合法后代
 *      （后代判定：HEAD 是 releaseCommit 的后代，且两者差异文件全部落在 sealingCommitPolicy.allowedPaths）
 *   3. 工作树 clean（含未跟踪文件）
 *   4. 当前分支不在 forbiddenDeploymentBranches 中（禁止自行选 main / 旧 release / 开发分支）
 *   5. 产物入口存在且 API 构建 + 类型检查通过
 *   6. 部署合同 / 恢复类定向测试通过（--skip-tests 可跳过，--full 跑全量）
 *
 * 用法：
 *   node deploy/verify-release.mjs [--root <repo>] [--skip-tests] [--full] [--json]
 * 退出码：0 = 全部通过；1 = 存在阻断项
 *
 * 安全：本脚本只读仓库与执行构建/测试，**不连接任何服务器、不执行部署、不写生产数据**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const ROOT = path.resolve(argValue('--root', process.cwd()));
const SKIP_TESTS = args.includes('--skip-tests');
const FULL_TESTS = args.includes('--full');
const AS_JSON = args.includes('--json');

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
};

/** git 包装：自动加 safe.directory，避免 Windows 归属告警；只读命令 */
const git = (gitArgs) =>
  execFileSync('git', ['-c', `safe.directory=${ROOT}`, '-C', ROOT, ...gitArgs], {
    encoding: 'utf8',
  }).trim();

const manifestPath = path.join(ROOT, 'deploy', 'release-manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  record('manifest.readable', true, manifestPath);
} catch (error) {
  record('manifest.readable', false, String(error && error.message ? error.message : error));
}

if (manifest !== null) {
  const placeholder = typeof manifest.releaseCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(manifest.releaseCommit);
  record(
    'manifest.releaseCommit.locked',
    !placeholder,
    placeholder ? `releaseCommit 未锁定（当前值：${String(manifest.releaseCommit)}）` : manifest.releaseCommit,
  );
}

let head = null;
try {
  head = git(['rev-parse', 'HEAD']);
  record('git.head.readable', true, head);
} catch (error) {
  record('git.head.readable', false, String(error && error.message ? error.message : error));
}

let branch = null;
try {
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  record('git.branch.readable', true, branch);
} catch (error) {
  record('git.branch.readable', false, String(error && error.message ? error.message : error));
}

/** 分支通配匹配：支持 main / release/x / gate/* 形式 */
const matchBranch = (pattern, name) => {
  if (pattern.endsWith('/*')) return name.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
};

if (manifest !== null && branch !== null) {
  const forbidden = (manifest.forbiddenDeploymentBranches ?? []).filter((p) => matchBranch(p, branch));
  record(
    'git.branch.allowed',
    forbidden.length === 0,
    forbidden.length === 0
      ? `${branch} 不在禁用清单中`
      : `分支 ${branch} 命中禁用项：${forbidden.join(', ')}（禁止部署）`,
  );
}

if (head !== null) {
  const dirty = git(['status', '--porcelain', '--untracked-files=all']);
  record('git.worktree.clean', dirty === '', dirty === '' ? 'clean' : `工作树不干净：\n${dirty}`);
}

const commitMatches = (() => {
  if (manifest === null || head === null) return { ok: false, detail: '缺少 manifest 或 HEAD' };
  const release = manifest.releaseCommit;
  if (!/^[0-9a-f]{7,40}$/.test(String(release))) return { ok: false, detail: 'releaseCommit 未锁定' };

  const resolve = (rev) => {
    try {
      return git(['rev-parse', `${rev}^{commit}`]);
    } catch {
      return null;
    }
  };
  const releaseFull = resolve(release);
  if (releaseFull === null) return { ok: false, detail: `releaseCommit ${release} 在本地不可解析（需 fetch 该 commit）` };
  if (releaseFull === head) return { ok: true, detail: `HEAD == releaseCommit（${releaseFull}）` };

  const policy = manifest.sealingCommitPolicy ?? {};
  if (policy.mode !== 'DOCS_ONLY_DESCENDANT') {
    return { ok: false, detail: `HEAD(${head}) != releaseCommit(${releaseFull})，且未启用封装提交策略` };
  }
  let isAncestor = false;
  try {
    git(['merge-base', '--is-ancestor', releaseFull, head]);
    isAncestor = true;
  } catch {
    isAncestor = false;
  }
  if (!isAncestor) {
    return { ok: false, detail: `HEAD(${head}) 不是 releaseCommit(${releaseFull}) 的后代（禁止部署分叉或更旧版本）` };
  }
  const changed = git(['diff', '--name-only', `${releaseFull}..${head}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const allowed = policy.allowedPaths ?? [];
  const matchPath = (pattern, file) => {
    if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2) + '/');
    if (pattern.startsWith('*.')) return file.endsWith(pattern.slice(1));
    return pattern === file;
  };
  const offending = changed.filter((file) => !allowed.some((pattern) => matchPath(pattern, file)));
  if (offending.length > 0) {
    return {
      ok: false,
      detail: `HEAD 与 releaseCommit 之间的差异超出允许范围（仅允许 ${allowed.join(', ')}）：\n  ${offending.join('\n  ')}`,
    };
  }
  return {
    ok: true,
    detail: `HEAD = releaseCommit + 仅封装提交（差异 ${changed.length} 个文件，均在允许范围内）`,
  };
})();
record('release.commit.locked', commitMatches.ok, commitMatches.detail);

if (manifest !== null) {
  const missing = [];
  for (const service of manifest.services ?? []) {
    const unitPath = path.join(ROOT, service.unit);
    if (!existsSync(unitPath)) missing.push(service.unit);
    const execTarget = String(service.execStart).split(' ').pop();
    if (execTarget && execTarget.startsWith('/opt/crossclaim/')) {
      const rel = execTarget.replace('/opt/crossclaim/', '');
      if (!rel.startsWith('apps/web/node_modules/') && !existsSync(path.join(ROOT, rel))) {
        missing.push(`${service.name} ExecStart 目标缺失：${rel}（需先构建）`);
      }
    }
  }
  record(
    'artifacts.present',
    missing.length === 0,
    missing.length === 0 ? 'unit 与构建产物入口均存在' : missing.join('\n'),
  );
}

const run = (command, commandArgs, cwd) => {
  try {
    execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, detail: 'ok' };
  } catch (error) {
    const out = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    return { ok: false, detail: out.slice(-1500) || String(error && error.message ? error.message : error) };
  }
};

if (!SKIP_TESTS) {
  const apiDir = path.join(ROOT, 'apps', 'api');
  const build = run(process.execPath, [path.join(apiDir, 'node_modules', 'typescript', 'bin', 'tsc')], apiDir);
  record('gate.api.build', build.ok, build.detail);

  const required = manifest?.gates?.requiredTestFiles ?? [];
  const missingTests = required.filter((rel) => !existsSync(path.join(apiDir, rel)));
  if (missingTests.length > 0) {
    record('gate.tests.present', false, missingTests.join('\n'));
  } else {
    const vitest = path.join(apiDir, 'node_modules', 'vitest', 'vitest.mjs');
    const testArgs = FULL_TESTS
      ? [vitest, 'run']
      : [vitest, 'run', ...required];
    const tests = run(process.execPath, testArgs, apiDir);
    record('gate.tests.pass', tests.ok, tests.ok ? `${required.length} 个必需测试文件通过` : tests.detail);
  }
} else {
  record('gate.api.build', true, 'SKIPPED（--skip-tests）');
  record('gate.tests.pass', true, 'SKIPPED（--skip-tests）');
}

const failed = results.filter((r) => !r.ok);
if (AS_JSON) {
  process.stdout.write(
    JSON.stringify({ releaseCommit: manifest?.releaseCommit ?? null, head, branch, passed: failed.length === 0, results }, null, 2) + '\n',
  );
} else {
  console.log('=== CrossClaim release gate ===');
  console.log(`root   : ${ROOT}`);
  console.log(`branch : ${branch ?? '(unknown)'}`);
  console.log(`head   : ${head ?? '(unknown)'}`);
  console.log(`anchor : ${manifest?.releaseCommit ?? '(unknown)'}`);
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
    if (!r.ok || process.env.VERIFY_RELEASE_VERBOSE === '1') {
      for (const line of String(r.detail).split('\n')) console.log(`        ${line}`);
    }
  }
  console.log('');
}

if (failed.length > 0) {
  if (!AS_JSON) {
    console.error(`RELEASE_GATE=FAIL（${failed.length} 项阻断）→ 必须停止部署`);
  }
  process.exit(1);
}
if (!AS_JSON) {
  console.log('RELEASE_GATE=PASS');
}
