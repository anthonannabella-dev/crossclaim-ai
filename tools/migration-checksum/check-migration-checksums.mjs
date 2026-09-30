#!/usr/bin/env node
// B2-FIX R1 / MSG-20260930-06 CHANGE F
// 校验「同名重纳」的迁移文件与最初合入版本**字节一致**（sha256 + 字节数）。
// 迁移语义一致不足；任何字节改动都必须另建后续迁移。
// 用法：node tools/migration-checksum/check-migration-checksums.mjs [--root .]
// 退出码：0 = 全部一致；1 = 不一致或缺失。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] : join(here, '..', '..'));

const pinned = JSON.parse(readFileSync(join(here, 'pinned-checksums.json'), 'utf8'));

const failures = [];
const checked = [];

for (const entry of pinned.entries) {
  const fullPath = join(root, entry.file);
  if (!existsSync(fullPath)) {
    failures.push(`${entry.migration}: file missing (${entry.file})`);
    continue;
  }
  const buffer = readFileSync(fullPath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== entry.sha256) {
    failures.push(`${entry.migration}: sha256 ${sha256} != pinned ${entry.sha256}`);
    continue;
  }
  if (buffer.length !== entry.bytes) {
    failures.push(`${entry.migration}: bytes ${buffer.length} != pinned ${entry.bytes}`);
    continue;
  }
  checked.push(`${entry.migration} (${entry.bytes}B, sha256=${sha256.slice(0, 12)}…)`);
}

if (failures.length > 0) {
  console.error('MIGRATION_CHECKSUM_MISMATCH');
  for (const failure of failures) console.error('  - ' + failure);
  console.error('提示：不得修改已应用迁移；语义或内容变更必须新建后续迁移。');
  process.exit(1);
}

console.log('MIGRATION_CHECKSUMS_OK');
for (const line of checked) console.log('  - ' + line);
