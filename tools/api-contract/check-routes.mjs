#!/usr/bin/env node
/**
 * API 契约闸门：`API.md` ↔ 实现路由 双向比对（零依赖，只读）
 * ---------------------------------------------------------------
 * 用法：node tools/api-contract/check-routes.mjs [--root <repo>]
 *
 * 覆盖三类实现位置：
 *   1. services/workflow/http-routes.ts  —— 业务路由（正则常量）
 *   2. services/auth/http-routes.ts      —— 认证路由（path === '/auth/...'）
 *   3. server.ts                         —— 健康检查等顶层路由（url === '/health'）
 *   4. services/auth/data-routes.ts      —— 只读数据路由（正则常量，如 /imports/:id/error-report）
 *
 * 退出码：0 = 一致；1 = 有漂移（未文档化的实现 / 未实现的文档）；2 = 用法或读文件错误。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const ROOT = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

/** 找出一对匹配的圆括号（支持嵌套），返回闭括号下标；找不到返回 -1 */
function matchingParen(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** 在顶层（不在括号内）按 `|` 切分 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * 把含可选组 `(?:…)?` 与选择组 `(a|b)` 的路由展开成具体路径集合。
 * 例：/connections(?:/(:param)/(status|credential-ref))? →
 *     /connections 、 /connections/:param/status 、 /connections/:param/credential-ref
 */
function expandRoute(source, guard = 0) {
  if (guard > 12) return [source];
  const optional = source.indexOf('(?:');
  if (optional >= 0) {
    const close = matchingParen(source, optional);
    if (close > 0 && source[close + 1] === '?') {
      const inner = source.slice(optional + 3, close);
      const head = source.slice(0, optional);
      const tail = source.slice(close + 2);
      return [...expandRoute(head + inner + tail, guard + 1), ...expandRoute(head + tail, guard + 1)];
    }
  }
  const open = source.indexOf('(');
  if (open >= 0) {
    const close = matchingParen(source, open);
    if (close > 0) {
      const inner = source.slice(open + 1, close);
      const head = source.slice(0, open);
      const tail = source.slice(close + 1);
      return splitTopLevel(inner).flatMap((part) => expandRoute(head + part + tail, guard + 1));
    }
  }
  return [source];
}

const normalise = (value) =>
  value
    .replace(/<[^>]+>/g, ':param') // 文档中的 /files/<token>
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');

/** 文档里逐条列出的路由（表格形如 | GET | `/path` | ...） */
function documentedRoutes(apiMd) {
  const found = new Map();
  const row = /^\|\s*(GET|POST|PATCH|PUT|DELETE)\s*\|\s*`(\/[^`]*)`/gm;
  let match;
  while ((match = row.exec(apiMd)) !== null) {
    for (const variant of expandRoute(match[2])) {
      found.set(normalise(variant), `${match[1]} ${match[2]}`);
    }
  }
  return found;
}

/** 业务路由：workflow/http-routes.ts 里的正则常量 */
function workflowRoutes(source) {
  const found = new Map();
  const constant = /const\s+[A-Z_]*_PATH[A-Z_]*\s*=\s*(\/\^[^\n]+\/);/g;
  let match;
  while ((match = constant.exec(source)) !== null) {
    const raw = match[1].slice(1, -1)
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\\\//g, '/')
      .replace(/\\\./g, '.')
      .replace(/\[\^\/\]\+|\[[^\]]+\](\+|\*)/g, ':param')
      .replace(/:param\?/g, ':param');
    for (const variant of expandRoute(raw)) {
      found.set(normalise(variant), raw);
    }
  }
  return found;
}

/** 字面量路由：auth/http-routes.ts 的 path === '/x' 与 server.ts 的 url === '/x' */
function literalRoutes(source, variable) {
  const found = new Map();
  const re = new RegExp(`${variable}\\s*===\\s*'([^']+)'`, 'g');
  let match;
  while ((match = re.exec(source)) !== null) {
    if (!match[1].startsWith('/')) continue;
    found.set(normalise(match[1]), match[1]);
  }
  return found;
}

/**
 * 允许清单：文档中列出、但由通用处理器实现（非字面量路径）的端点。
 * 每一条都必须写明原因，否则不能加入。
 */
const DOCUMENTED_ONLY_ALLOW = new Map([
  ['/files/:param', '签名令牌下载：由存储层按 token 解析，不存在字面量路由常量'],
]);

const IMPLEMENTED_ONLY_ALLOW = new Map();

function main() {
  let apiMd;
  let workflowSource;
  let authSource;
  let serverSource;
  let dataSource;
  try {
    apiMd = read('API.md');
    workflowSource = read('apps/api/src/services/workflow/http-routes.ts');
    authSource = read('apps/api/src/services/auth/http-routes.ts');
    serverSource = read('apps/api/src/server.ts');
    dataSource = read('apps/api/src/services/auth/data-routes.ts');
  } catch (error) {
    console.error(`读取失败：${error instanceof Error ? error.message : 'unknown'}`);
    process.exit(2);
  }

  const documented = documentedRoutes(apiMd);
  const implemented = new Map([
    ...workflowRoutes(workflowSource),
    ...workflowRoutes(dataSource),
    ...literalRoutes(authSource, 'path'),
    ...literalRoutes(serverSource, 'url'),
  ]);

  const undocumented = [];
  for (const [norm, raw] of implemented) {
    const covered =
      documented.has(norm) ||
      IMPLEMENTED_ONLY_ALLOW.has(norm) ||
      [...documented.keys()].some((doc) => doc.startsWith(`${norm}/`) || norm.startsWith(`${doc}/`));
    if (!covered) undocumented.push(`${norm}   (${raw})`);
  }

  const unimplemented = [];
  for (const [norm, raw] of documented) {
    const covered =
      implemented.has(norm) ||
      DOCUMENTED_ONLY_ALLOW.has(norm) ||
      [...implemented.keys()].some((impl) => impl.startsWith(`${norm}/`) || norm.startsWith(`${impl}/`));
    if (!covered) unimplemented.push(`${norm}   (${raw})`);
  }

  console.log(`implemented=${implemented.size} documented=${documented.size}`);

  if (undocumented.length > 0) {
    console.log('\nUNDOCUMENTED IMPLEMENTED ROUTES:');
    for (const item of undocumented.sort()) console.log(`  ${item}`);
  }
  if (unimplemented.length > 0) {
    console.log('\nDOCUMENTED BUT NOT IMPLEMENTED:');
    for (const item of unimplemented.sort()) console.log(`  ${item}`);
  }

  if (undocumented.length === 0 && unimplemented.length === 0) {
    console.log('API_CONTRACT_OK');
    process.exit(0);
  }
  console.log('API_CONTRACT_DRIFT');
  process.exit(1);
}

main();
