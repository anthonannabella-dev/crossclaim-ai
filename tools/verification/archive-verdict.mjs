#!/usr/bin/env node
/**
 * 通用裁决归档器（CrossClaim AI）
 * ---------------------------------------------------------------
 * 把「已抽取的裁决原文」按契约追加进 AI-ARCHITECT-INBOX.md，并立刻跑逐行比对。
 *
 * 用法：
 *   node tools/verification/archive-verdict.mjs <原文文件> <MSG-ID> <标题文件>
 *
 * 行为：
 *   1) 校验原文文件存在、非空；校验 MSG-ID 形如 MSG-YYYYMMDD-NN；
 *   2) 若归档中已存在该 MSG-ID → 直接跳过追加（幂等）；
 *   3) 以 ```text 围栏追加；标题取标题文件内容（一行），保持审计可读性；
 *   4) 运行 tools/verdict-diff/compare.mjs，输出必须为 FULL_COPY_OK，否则以非零退出码结束。
 *
 * 设计取舍：**不做联网/浏览器操作**——原文必须由调用方先抽取成文件（这一步需要人工/代理确认抽取正确性），
 * 本脚本只负责「追加 + 校验」，把最容易出错的机械部分固定下来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 与 tools/verdict-diff/compare.mjs 保持一致：允许用 CROSSCLAIM_ARCHIVE 指向替换归档文件，
// 这样归档器本身可以在临时文件上做端到端冒烟测试，而不污染真实审计链。
const INBOX = process.env.CROSSCLAIM_ARCHIVE ?? path.join(ROOT, 'AI-ARCHITECT-INBOX.md');
const COMPARE = path.join(ROOT, 'tools/verdict-diff/compare.mjs');

const [sourcePath, msgId, headingPath] = process.argv.slice(2);
if (!sourcePath || !msgId || !headingPath) {
  console.error('用法: node tools/verification/archive-verdict.mjs <原文文件> <MSG-ID> <标题文件>');
  process.exit(1);
}
if (!/^MSG-\d{8}-\d{2,3}$/.test(msgId)) {
  console.error('MSG-ID 形状不正确（应为 MSG-YYYYMMDD-NN）: ' + msgId);
  process.exit(1);
}
for (const p of [sourcePath, headingPath]) {
  if (!fs.existsSync(p)) {
    console.error('文件不存在: ' + p);
    process.exit(1);
  }
}

const verdict = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
if (verdict.trim() === '') {
  console.error('原文为空，拒绝归档');
  process.exit(1);
}

// 关键顺序：先校验原文哈希，再动归档文件。
// （早先的实现在追加之后才校验，导致哈希不匹配时归档已被污染 —— 冒烟测试用错误哈希暴露了这一点。）
const fnv1aChecksum = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const expectedFnvEarly = process.argv[5];
if (expectedFnvEarly && fnv1aChecksum(verdict) !== expectedFnvEarly) {
  console.error(
    '原文哈希不匹配：期望 ' + expectedFnvEarly + '，实际 ' + fnv1aChecksum(verdict) +
      '（len=' + verdict.length + '）→ 拒绝归档，且未触碰归档文件',
  );
  process.exit(3);
}
const heading = fs.readFileSync(headingPath, 'utf8').split('\n')[0].trim();
if (!heading.startsWith('### [' + msgId + ']')) {
  console.error('标题文件首行必须以 "### [' + msgId + '] " 开头');
  process.exit(1);
}

let inbox = fs.readFileSync(INBOX, 'utf8').replace(/\r\n/g, '\n');
if (!inbox.endsWith('\n')) inbox += '\n';

if (inbox.includes(msgId)) {
  console.log('ARCHIVE_ALREADY_PRESENT ' + msgId + '（跳过追加，仍将运行比对）');
} else {
  // 外层围栏必须长于正文内最长的反引号串，否则 markdown 原文里的 ``` 会提前闭合围栏。
  const longestRun = (verdict.match(/`+/g) ?? ['']).reduce((m, s) => Math.max(m, s.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  inbox = inbox.replace(/\n+$/, '\n') + `\n${heading}\n\n${fence}text\n${verdict}\n${fence}\n`;
  fs.writeFileSync(INBOX, inbox, 'utf8');
  console.log('ARCHIVED ' + msgId + '（' + verdict.split('\n').length + ' 行）');
}

// 可选：第 4 个参数为浏览器抽取时算出的 FNV-1a。compare.mjs 只能证明「归档 = 原文文件」，
// 不能证明「原文文件 = 浏览器原文」；这一步补上缺失的一环，转写少一个字符即失败。
const expectedFnv = process.argv[5];
if (expectedFnv) {
  const fnv1a = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  const actual = fnv1a(verdict);
  if (actual !== expectedFnv) {
    console.error('原文哈希不匹配：期望 ' + expectedFnv + '，实际 ' + actual + '（len=' + verdict.length + '）→ 拒绝归档');
    process.exit(3);
  }
  console.log('FNV1A_MATCH ' + actual + '（原文文件与浏览器抽取一致）');
}

const out = execFileSync(process.execPath, [COMPARE, sourcePath, msgId], { cwd: ROOT, encoding: 'utf8' });
const tail = out.trim().split('\n').slice(-6).join('\n');
console.log(tail);
if (!out.includes('FULL_COPY_OK')) {
  console.error('比对未通过 FULL_COPY_OK —— 归档不可信，请检查原文抽取');
  process.exit(2);
}
