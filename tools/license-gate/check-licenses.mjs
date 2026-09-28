#!/usr/bin/env node
/**
 * CrossClaim AI · License Gate
 * ---------------------------------------------------------------
 * 扫每个工作区 package.json 的直接依赖，读 node_modules 里对应包的
 * license 字段，按 allowlist.json 的 allow / review / deny 三档判定。
 *
 * 用法:
 *   node ops/license-gate/check-licenses.mjs            # 在仓库根目录跑
 *   node ops/license-gate/check-licenses.mjs --json out.json
 *
 * 退出码:
 *   0 = 全绿（可能有 SKIP，未安装的包不算失败）
 *   1 = 命中 deny / 未登记的 review / 双许可未登记 / UNKNOWN
 *
 * 注意: 本脚本只查【库的代码许可证】。模型权重许可证另见 MODEL_LICENSES.md。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const ALLOWLIST_PATH = path.join(SCRIPT_DIR, 'allowlist.json');

/**
 * CrossClaim 正式工程的包位置（旧项目遗留名已移除）。
 * 缺失的工作区会被 SKIP，但已存在的工作区必须真实通过。
 */
const WORKSPACES = ['apps/api', 'apps/web'];

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', gray: '\x1b[90m', bold: '\x1b[1m',
};

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * 按 SPDX 语义解析表达式，区分 AND 与 OR：
 *   "(MIT OR GPL-3.0-or-later)"  -> [["mit","gpl-3.0-or-later"]]   （选一个即可）
 *   "MIT AND GPL-3.0"            -> [["mit"],["gpl-3.0"]]          （两者都必须满足）
 */
function parseExpression(expr) {
  return String(expr ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+and\s+/i)
    .map((conjunct) =>
      conjunct
        .split(/\s+or\s+/i)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((alt) => alt.length);
}

function readLicense(pkgJsonPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length) return types.join(' OR ');
  }
  return null;
}

function main() {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    console.error(`✗ 找不到 allowlist: ${ALLOWLIST_PATH}`);
    process.exit(1);
  }
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  const allow = new Set((allowlist.policy?.allow ?? []).map(norm));
  const review = new Set((allowlist.policy?.review ?? []).map(norm));
  const deny = new Set((allowlist.policy?.deny ?? []).map(norm));

  const exceptions = new Set((allowlist.approvedExceptions ?? []).map((e) => norm(e.package)));
  const dualResolved = new Set((allowlist.resolvedDualLicenses ?? []).map((e) => norm(e.package)));

  const failures = [];
  const warnings = [];
  const report = [];
  let checked = 0, skipped = 0;

  console.log(`${C.bold}CrossClaim License Gate${C.reset}  root=${ROOT}\n`);

  for (const ws of WORKSPACES) {
    const wsDir = path.join(ROOT, ws);
    const pkgPath = path.join(wsDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const names = Object.keys(deps).sort();
    if (!names.length) continue;

    console.log(`${C.bold}[${ws}]${C.reset} ${names.length} 个直接依赖`);

    for (const name of names) {
      const depPkgPath = path.join(wsDir, 'node_modules', ...name.split('/'), 'package.json');
      if (!fs.existsSync(depPkgPath)) {
        skipped++;
        report.push({ ws, name, license: '(未安装)', verdict: 'SKIP' });
        continue;
      }

      let license;
      try {
        license = readLicense(depPkgPath);
      } catch (err) {
        failures.push(`${ws}/${name}: 读取 package.json 失败 — ${err.message}`);
        continue;
      }
      checked++;

      if (!license) {
        failures.push(`${ws}/${name}: 缺少 license 字段（UNKNOWN）`);
        report.push({ ws, name, license: '(none)', verdict: 'FAIL' });
        continue;
      }

      if (/^see license in/i.test(license)) {
        failures.push(`${ws}/${name}: "${license}" —— 需要人工查看该文件后再登记进 allowlist`);
        report.push({ ws, name, license, verdict: 'FAIL' });
        continue;
      }

      const conjuncts = parseExpression(license);

      // 逐个子句判定：AND 的每一组都必须能被某个「允许」分支满足
      let verdict = 'PASS';
      let detail = license;
      let dualUsed = false;
      let needsException = false;
      const problems = [];

      for (const alternatives of conjuncts) {
        const allowed = alternatives.filter((a) => allow.has(norm(a)));
        if (allowed.length) {
          if (alternatives.length > 1) dualUsed = true;
          if (alternatives.length > 1) detail = `${license} → ${allowed[0]}`;
          continue;
        }

        const denied = alternatives.filter((a) => deny.has(norm(a)));
        const reviewable = alternatives.filter((a) => review.has(norm(a)));
        const unknown = alternatives.filter(
          (a) => !deny.has(norm(a)) && !review.has(norm(a)) && !allow.has(norm(a)),
        );

        if (unknown.length) {
          verdict = 'FAIL';
          problems.push(`未知许可证 "${unknown.join(', ')}"`);
        } else if (reviewable.length) {
          verdict = 'FAIL';
          needsException = true;
          problems.push(`需人工审查 "${reviewable.join(', ')}"`);
        } else {
          verdict = 'FAIL';
          problems.push(`命中禁止档 "${denied.join(', ')}"`);
        }
        break;
      }

      // 双许可：只要选了允许分支，就必须登记，否则视为未锁定
      if (verdict === 'PASS' && dualUsed && !dualResolved.has(norm(name)) && !exceptions.has(norm(name))) {
        failures.push(
          `${ws}/${name}: 双许可 "${license}" 未登记 —— 请在 allowlist.json 的 ` +
          `resolvedDualLicenses 里锁定到允许分支`,
        );
        report.push({ ws, name, license, verdict: 'FAIL' });
        continue;
      }

      if (verdict === 'FAIL') {
        const message = `${ws}/${name}: ${problems.join('；')}`;
        if (exceptions.has(norm(name))) {
          warnings.push(`${message} —— 已在例外表中，放行`);
          report.push({ ws, name, license, verdict: 'PASS(exception)' });
        } else if (needsException) {
          const hint = problems.join('；');
          failures.push(`${ws}/${name}: 许可证 ${hint}，请登记进 approvedExceptions`);
          report.push({ ws, name, license, verdict: 'FAIL' });
        } else {
          failures.push(message);
          report.push({ ws, name, license, verdict: 'FAIL' });
        }
        continue;
      }

      report.push({ ws, name, license: detail, verdict: dualUsed ? 'PASS(dual)' : 'PASS' });
    }
    console.log(`${C.gray}  已检查 ${names.length} 个${C.reset}\n`);
  }

  // ---- 输出结果 ----
  for (const f of failures) console.log(`${C.red}✗ ${f}${C.reset}`);
  for (const w of warnings) console.log(`${C.yellow}! ${w}${C.reset}`);

  console.log('');
  console.log(`  已检查 ${checked} 个已安装依赖，跳过 ${skipped} 个未安装`);

  const jsonFlag = process.argv.indexOf('--json');
  if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
    const outPath = path.resolve(process.argv[jsonFlag + 1]);
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
    console.log(`  报告已写入 ${outPath}`);
  }

  if (failures.length) {
    console.log(`\n${C.red}${C.bold}✗ License Gate 未通过:${C.reset} ${failures.length} 个问题`);
    process.exit(1);
  }
  console.log(`\n${C.green}${C.bold}✓ License Gate 通过${C.reset}`);
  process.exit(0);
}

main();
