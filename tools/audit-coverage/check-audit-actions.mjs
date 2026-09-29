#!/usr/bin/env node
/**
 * 审计动作覆盖闸门（零依赖，只读）
 * ---------------------------------------------------------------
 * 比对两处：
 *   1. 代码中实际写入的审计动作（`action: '<value>'`）
 *   2. `OPERATIONS.md` 运维文档里列出的动作清单
 *
 * 判定：
 *   - 文档中承诺、代码里找不到 → 报错（运维会照着不存在的动作去查）
 *   - 代码里有、文档没写 → 报告为提示（可能是内部/细粒度动作）
 *
 * 用法：node tools/audit-coverage/check-audit-actions.mjs [--root <repo>]
 * 退出码：0 = 文档动作全部存在于代码；1 = 有缺失；2 = 读文件失败。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const ROOT = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();

/**
 * 审计动作在代码里有两种出现形式：
 *   1. 直接调用：`action: 'file.uploaded'`
 *   2. 动作常量表：`{ created: 'claim.item_created' }` / `export const X = 'identity.duplicate_resolved'`
 * 两者都要采集，否则会误报「文档有、代码没有」。
 */
const ACTION_RE = /\b[a-zA-Z][a-zA-Z0-9_]*:\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;
const CONST_ACTION_RE = /=\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function codeActions() {
  const found = new Map();
  for (const file of walk(path.join(ROOT, 'apps/api/src'))) {
    const text = readFileSync(file, 'utf8');
    let match;
    ACTION_RE.lastIndex = 0;
    while ((match = ACTION_RE.exec(text)) !== null) {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/');
      found.set(match[1], relative);
    }
    // `action:` 后接三元/拼接等表达式时，取该行内所有点分动作字面量
    for (const line of text.split('\n')) {
      if (!line.includes('action:')) continue;
      for (const literal of line.match(/'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/g) ?? []) {
        const value = literal.slice(1, -1);
        if (!found.has(value)) {
          found.set(value, path.relative(ROOT, file).replace(/\\/g, '/'));
        }
      }
    }
    CONST_ACTION_RE.lastIndex = 0;
    while ((match = CONST_ACTION_RE.exec(text)) !== null) {
      const relative = path.relative(ROOT, file).replace(/\\/g, '/');
      if (!found.has(match[1])) found.set(match[1], relative);
    }
  }
  return found;
}

function documentedActions() {
  const text = readFileSync(path.join(ROOT, 'OPERATIONS.md'), 'utf8');
  const block = /```text\n([\s\S]*?)```/.exec(text);
  if (!block) throw new Error('OPERATIONS.md 未找到 text 代码块');
  const found = new Set();
  for (const token of block[1].match(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+/g) ?? []) {
    found.add(token);
  }
  return found;
}

function main() {
  let code;
  let docs;
  try {
    code = codeActions();
    docs = documentedActions();
  } catch (error) {
    console.error(`读取失败：${error instanceof Error ? error.message : 'unknown'}`);
    process.exit(2);
  }

  const missingInCode = [...docs].filter((action) => !code.has(action)).sort();
  const undocumented = [...code.keys()].filter((action) => !docs.has(action)).sort();

  console.log(`code_actions=${code.size} documented_actions=${docs.size}`);

  if (missingInCode.length > 0) {
    console.log('\nDOCUMENTED BUT NOT FOUND IN CODE:');
    for (const action of missingInCode) console.log(`  ${action}`);
  }
  if (undocumented.length > 0) {
    console.log('\nIN CODE BUT NOT IN OPERATIONS.md (info):');
    for (const action of undocumented) console.log(`  ${action}  (${code.get(action)})`);
  }

  if (missingInCode.length === 0) {
    console.log('AUDIT_COVERAGE_OK');
    process.exit(0);
  }
  console.log('AUDIT_COVERAGE_DRIFT');
  process.exit(1);
}

main();
