/**
 * 测试环境引导（本地 / CI 共用）
 * ---------------------------------------------------------------
 * 背景：Prisma Client 不会自动读取 .env（只有 Prisma CLI 会）。
 * CI 通过 workflow 的 env: 注入 DATABASE_URL，所以 CI 一直正常；
 * 但本地直接跑 npm test 会因为没有 DATABASE_URL 而整批数据库用例失败。
 *
 * 规则（保守，不改变 CI 行为）：
 *   - 进程里已有的环境变量一律不覆盖（CI 永远走自己的 env）
 *   - 仅当 DATABASE_URL 缺失时，尝试读取 apps/api/.env（.gitignore 已忽略）
 *   - 不打印任何取值，只做缺失补齐
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function parseEnvFile(contents: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    pairs.push([key, value]);
  }
  return pairs;
}

/** 补齐缺失的环境变量：只补，不覆盖。返回是否真的补了值。 */
export function loadEnvFileIfMissing(envFilePath: string, env = process.env): boolean {
  if (env.DATABASE_URL) return false;
  if (!existsSync(envFilePath)) return false;

  let loaded = false;
  for (const [key, value] of parseEnvFile(readFileSync(envFilePath, 'utf8'))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded = true;
  }
  return loaded;
}

loadEnvFileIfMissing(path.resolve(process.cwd(), '.env'));
