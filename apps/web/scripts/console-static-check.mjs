#!/usr/bin/env node
/**
 * E3 前端代码静态扫描（架构方 MSG-20260929-50）
 * 检查 Operations Console 范围内：无写请求、无 download/export 控件、无任意模块扫描。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.argv[2] ?? 'apps/web');
const TARGETS = ['app/operations', 'app/admin', 'app/lib/console.ts'];

function collect(target) {
  const full = path.join(ROOT, target);
  try {
    const stat = statSync(full);
    if (stat.isFile()) return [full];
    return readdirSync(full).flatMap((entry) => collect(path.join(target, entry)));
  } catch {
    return [];
  }
}

const files = TARGETS.flatMap(collect);
if (files.length === 0) {
  console.log('NO_CONSOLE_FILES');
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);
  for (const pattern of [
    /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i,
    /axios\.(post|put|patch|delete)/i,
    /fetch\([^)]*\{\s*method:\s*['"](POST|PUT|PATCH|DELETE)/i,
    /<form[^>]*action=/i,
    /\bdownload=/i,
    /\bexport\s*=/i,
    /\.csv\b.*download/i,
  ]) {
    if (pattern.test(source)) violations.push(`${relative}: ${pattern}`);
  }
}

if (violations.length > 0) {
  console.log('CONSOLE_STATIC_VIOLATIONS:');
  for (const item of violations) console.log('  ' + item);
  process.exit(1);
}
console.log(`CONSOLE_STATIC_OK files=${files.length}`);
