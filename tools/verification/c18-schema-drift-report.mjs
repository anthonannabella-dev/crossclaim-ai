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

function migrationEnumValues() {
  const created = new Map();
  const added = new Map();
  for (const dir of fs.readdirSync(migrationsDir)) {
    const file = path.join(migrationsDir, dir, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    for (const m of sql.matchAll(/CREATE TYPE "([A-Za-z]+)" AS ENUM \(([^)]*)\)/g)) {
      const values = m[2]
        .split(',')
        .map((v) => v.trim().replace(/^'/, '').replace(/'$/, ''))
        .filter((v) => v !== '');
      created.set(m[1], values);
    }
    for (const m of sql.matchAll(/ALTER TYPE "([A-Za-z]+)" ADD VALUE '([A-Z_]+)'/g)) {
      if (!added.has(m[1])) added.set(m[1], new Set());
      added.get(m[1]).add(m[2]);
    }
  }
  return { created, added };
}

const { created, added } = migrationEnumValues();
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
