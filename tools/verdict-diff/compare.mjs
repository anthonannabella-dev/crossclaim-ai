#!/usr/bin/env node
/**
 * 裁决归档逐行比对工具（CrossClaim AI）
 * ---------------------------------------------------------------
 * 用途：拿一个「独立来源的原文」（例如宿主从右侧对话整条复制出来的文本）
 *       与 AI-ARCHITECT-INBOX.md 里的某一条归档做逐行差异比对，
 *       用客观数字回答「到底有没有全部复制」。
 *
 * 用法：
 *   node tools/verdict-diff/compare.mjs <原文文件> [MSG-编号或标题片段]
 *
 * 行为：
 *   - 两侧都做同样的规范化（去 CRLF、去每行首尾空白、丢弃空行）
 *   - 输出两侧行数、缺失行数、多出行数；有差异时打印前若干行样本
 *   - 退出码：0 = 完全一致；2 = 有差异；1 = 参数/文件错误
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const FENCE = '```';
const DEFAULT_ARCHIVE = 'D:/crossclaim-ai/AI-ARCHITECT-INBOX.md';

const sourcePath = process.argv[2];
const selector = process.argv[3];

if (!sourcePath) {
  console.error('用法: node tools/verdict-diff/compare.mjs <原文文件> [MSG-编号或标题片段]');
  process.exit(1);
}

const normalize = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

function readArchiveBody(archivePath, selector) {
  const lines = fs.readFileSync(archivePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => /^#{2,3} \[/.test(item.line));
  const target = selector
    ? headings.filter((item) => item.line.includes(selector)).pop()
    : headings
        .filter((item) => /MSG-/.test(item.line))
        .pop();
  if (!target) throw new Error(`归档里找不到匹配段落: ${selector ?? '(最后一条 MSG)'}`);
  const next = headings.find((item) => item.index > target.index);
  const seg = lines.slice(target.index, next ? next.index : lines.length);
  const textIdx = seg.findIndex((line) => line.trim() === `${FENCE}text`);
  if (textIdx < 0) throw new Error('该段落没有 ```text 代码块，无法比对');
  let body = seg.slice(textIdx + 1);
  const closeIdx = body.findIndex((line) => line.trim() === FENCE);
  if (closeIdx >= 0) body = body.slice(0, closeIdx);
  return { heading: target.line.trim(), lines: normalize(body.join('\n')) };
}

const archivePath = process.env.CROSSCLAIM_ARCHIVE ?? DEFAULT_ARCHIVE;
if (!fs.existsSync(sourcePath)) {
  console.error(`原文文件不存在: ${sourcePath}`);
  process.exit(1);
}
if (!fs.existsSync(archivePath)) {
  console.error(`归档文件不存在: ${archivePath}`);
  process.exit(1);

const source = normalize(fs.readFileSync(sourcePath, 'utf8'));
const archived = readArchiveBody(archivePath, selector);

const tally = (arr) => arr.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
const srcCount = tally(source);
const arcCount = tally(archived.lines);

const missing = [];
for (const [line, n] of srcCount) {
  for (let k = arcCount.get(line) ?? 0; k < n; k += 1) missing.push(line);
}
const extra = [];
for (const [line, n] of arcCount) {
  for (let k = srcCount.get(line) ?? 0; k < n; k += 1) extra.push(line);
}

console.log(`归档段落 : ${archived.heading}`);
console.log(`原文行数 : ${source.length}`);
console.log(`归档行数 : ${archived.lines.length}`);
console.log(`缺失行数 : ${missing.length}`);
console.log(`多出行数 : ${extra.length}`);

if (missing.length) {
  console.log('--- 归档缺失（前 25 行）---');
  missing.slice(0, 25).forEach((line) => console.log(`MISS: ${line.slice(0, 100)}`));
}
if (extra.length) {
  console.log('--- 归档多出（前 15 行）---');
  extra.slice(0, 15).forEach((line) => console.log(`EXTRA: ${line.slice(0, 100)}`));
}

if (missing.length === 0 && extra.length === 0) {
  console.log('RESULT: FULL_COPY_OK（逐行一致，未发现遗漏或多出）');
  process.exit(0);
}
console.log('RESULT: DIFF_FOUND');
process.exit(2);
