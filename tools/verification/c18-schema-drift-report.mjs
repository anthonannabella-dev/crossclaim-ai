#!/usr/bin/env node
// C18 / P0 — schema-history drift 诊断（只读）
// 目的：精确列出 schema.prisma 的 enum 取值 与「已提交 migrations 产生的取值」之间的差异，
//       供 NON_C18_SCHEMA_HISTORY_DRIFT 的**向前修复**使用（不重写历史、不从 PG enum 删除已入历史的值）。
// 用法：node tools/verification/c18-schema-drift-report.mjs
// 前置：本地已能运行 prisma（apps/api 安装依赖）。不连接数据库、不执行 migration。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');
const schemaPath = path.join(API, 'prisma/schema.prisma');
const migrationsDir = path.join(API, 'prisma/migrations');

const schema = fs.readFileSync(schemaPath, 'utf8');

function schemaEnumValues(name) {
  const match = new RegExp('enum ' + name + ' \\{([^}]*)\\}').exec(schema);
  if (!match) return null;
  return match[1]
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== '' && !token.startsWith('//') && !token.startsWith('@@'));
}

/**
 * 按 migration 目录顺序（Prisma 的权威顺序）重放 enum 变更，覆盖三种历史写法：
 *   1) CREATE TYPE "X" AS ENUM (...)
 *   2) ALTER TYPE "X" ADD VALUE 'V'
 *   3) enum-recreate：CREATE TYPE "X_new" AS ENUM (...) + ALTER TYPE "X" RENAME TO "X_old" + ALTER TYPE "X_new" RENAME TO "X"
 *      （架构方在历史里识别出的模式；上一版扫描器漏掉了它）
 */
function replayEnumHistory() {
  const state = new Map(); // enumName -> string[]
  const dirs = fs.readdirSync(migrationsDir).filter((d) => !d.startsWith('.')).sort();
  for (const dir of dirs) {
    const file = path.join(migrationsDir, dir, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    const parseValues = (raw) =>
      raw
        .split(',')
        .map((v) => v.trim().replace(/^'/, '').replace(/'$/, ''))
        .filter((v) => v !== '');

    for (const m of sql.matchAll(/CREATE TYPE "([A-Za-z_]+)" AS ENUM \(([^)]*)\)/g)) {
      state.set(m[1], parseValues(m[2]));
    }
    for (const m of sql.matchAll(/ALTER TYPE "([A-Za-z_]+)" ADD VALUE (?:IF NOT EXISTS )?'([A-Z_]+)'/g)) {
      const current = state.get(m[1]) ?? [];
      if (!current.includes(m[2])) state.set(m[1], [...current, m[2]]);
    }
    // enum-recreate：把 "<base>_new" 的值提升为 "<base>"，并丢弃 "_old"
    for (const m of sql.matchAll(/ALTER TYPE "([A-Za-z_]+)_new" RENAME TO "([A-Za-z_]+)"/g)) {
      const from = state.get(m[1] + '_new');
      if (from) state.set(m[2], from);
    }
    for (const m of sql.matchAll(/DROP TYPE "([A-Za-z_]+)_old"/g)) {
      state.delete(m[1] + '_old');
      state.delete(m[1] + '_new');
    }
  }
  return state;
}

const history = replayEnumHistory();
const created = history;
const added = new Map();
const targets = ['Channel', 'RouteTarget'];
let drift = false;

for (const name of targets) {
  const inSchema = schemaEnumValues(name);
  const base = created.get(name) ?? [];
  const extra = [...(added.get(name) ?? [])];
  const historyValues = [...new Set([...base, ...extra])];
  console.log('=== ' + name + ' ===');
  console.log('  schema.prisma  : ' + (inSchema ? inSchema.join(', ') : 'NOT_FOUND'));
  console.log('  migrations 产生: ' + (historyValues.length ? historyValues.join(', ') : 'NOT_FOUND'));
  const missingFromSchema = historyValues.filter((v) => inSchema && !inSchema.includes(v));
  const onlyInSchema = inSchema ? inSchema.filter((v) => !historyValues.includes(v)) : [];
  console.log('  历史有但 schema 缺（向前修复需补回）: ' + (missingFromSchema.length ? missingFromSchema.join(', ') : '(none)'));
  console.log('  schema 有但历史没有（需新 migration 添加）: ' + (onlyInSchema.length ? onlyInSchema.join(', ') : '(none)'));
  if (missingFromSchema.length || onlyInSchema.length) drift = true;
}

console.log('');
console.log('DRIFT_PRESENT=' + (drift ? 'YES' : 'NO'));
console.log('提示：本脚本只读；修复策略见 docs/releases/C18-SCHEMA-DRIFT-FINDING.md（向前修复）。');
