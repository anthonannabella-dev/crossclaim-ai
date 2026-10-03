#!/usr/bin/env node
/**
 * i18n 校验器（HOST DIRECTIVE 2026-10-04 §三/§四/§二十）。
 *  1) dictionary 键一致（parity）；
 *  2) 空值文案（半成品翻译）；
 *  3) 状态码本地化覆盖（CUSTOMER_STATUS_CODES ⊆ 各语言 status.*，且必须有 status.UNKNOWN 兜底）；
 *  4) Business Language Layer 函数存在性与 provider fail-safe；
 *  5) Customer UI 硬编码 guard（allowlist 之外的 CJK 文案不得出现在 customer 页面）。
 * 用法：node tools/i18n/check-i18n.mjs [--root .]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const ROOT = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const DICT_DIR = path.join(ROOT, 'apps/web/i18n/dictionaries');
const LOCALES = ['zh-CN', 'en-US', 'de', 'ja', 'es'];
const FAILURES = [];

/** 轻量缩进解析：提取字典叶子键路径。 */
function leafKeys(source) {
  const stack = [];
  const leaves = [];
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const open = /^(\s+)([A-Za-z0-9_]+):\s*\{\s*$/.exec(line);
    const close = /^\s*\},?\s*$/.test(line);
    // 叶子键：`key: <非 { 起始值>`（值可能跨多行书写，因此不要求引号在同一行）
    // 注意：必须先判「块开始」，否则正则回溯会把 `key: {` 误判为叶子（已实测踩坑）。
    const leaf = /^(\s+)([A-Za-z0-9_]+):\s*(?!\s*\{).*$/.exec(line);
    if (open) {
      const indent = open[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, key: open[2] });
      continue;
    }
    if (leaf) {
      const indent = leaf[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      leaves.push([...stack.map((entry) => entry.key), leaf[2]].join('.'));
      continue;
    }
    if (close) {
      const indent = line.search(/\S/);
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    }
  }
  return leaves;
}

const dictionaries = {};
for (const locale of LOCALES) {
  const source = fs.readFileSync(path.join(DICT_DIR, locale + '.ts'), 'utf8');
  dictionaries[locale] = { source, keys: leafKeys(source) };
}

// 1) parity
const base = dictionaries['zh-CN'].keys;
for (const locale of LOCALES) {
  const keys = dictionaries[locale].keys;
  if (keys.join('|') !== base.join('|')) {
    const missing = base.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !base.includes(key));
    FAILURES.push('KEY_PARITY ' + locale + ' missing=[' + missing.slice(0, 5).join(',') + '] extra=[' + extra.slice(0, 5).join(',') + ']');
  }
}

// 2) blank translations
for (const locale of LOCALES) {
  const blanks = [...dictionaries[locale].source.matchAll(/^\s+[A-Za-z0-9_]+:\s*(['"`])\s*\1,?\s*$/gm)];
  if (blanks.length > 0) FAILURES.push('BLANK_TRANSLATION ' + locale + ' count=' + blanks.length);
}

// 3) status localization coverage
const businessLanguage = fs.readFileSync(path.join(ROOT, 'apps/web/i18n/business-language.ts'), 'utf8');
const codesBlock = /CUSTOMER_STATUS_CODES = \[([\s\S]*?)\] as const;/.exec(businessLanguage);
if (!codesBlock) FAILURES.push('STATUS_CODES_BLOCK_MISSING');
const statusCodes = (codesBlock ? codesBlock[1].match(/'([A-Z_]+)'/g) ?? [] : []).map((token) => token.replace(/'/g, ''));
for (const locale of LOCALES) {
  const missing = statusCodes.filter((code) => !dictionaries[locale].keys.includes('status.' + code));
  if (missing.length > 0) FAILURES.push('STATUS_LOCALIZATION_MISSING ' + locale + ': ' + missing.join(','));
  if (!dictionaries[locale].keys.includes('status.UNKNOWN')) FAILURES.push('STATUS_FALLBACK_MISSING ' + locale);
}

// 4) business language layer presence
const requiredFunctions = [
  'resolveUiLocale',
  'resolveReportLocale',
  'resolveClaimLocale',
  'resolveProviderLocale',
  'resolveFrozenLocale',
  'formatMoney',
  'formatDate',
  'formatDateTime',
  'formatNumber',
  'formatPercent',
  'statusLabel',
];
for (const fn of requiredFunctions) {
  if (!businessLanguage.includes('export function ' + fn)) FAILURES.push('BUSINESS_LANGUAGE_FN_MISSING ' + fn);
}
if (!businessLanguage.includes('failSafe: true')) FAILURES.push('PROVIDER_FAIL_SAFE_MISSING');
if (!businessLanguage.includes("businessLocaleInheritsUi: false")) FAILURES.push('UI_BUSINESS_SEPARATION_FLAG_MISSING');

// 5) customer UI hardcode guard（allowlist 见 tools/i18n/hardcode-allowlist.json）
const ALLOWLIST_FILE = path.join(ROOT, 'tools/i18n/hardcode-allowlist.json');
const allowlist = fs.existsSync(ALLOWLIST_FILE) ? JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8')) : { files: [] };
const CUSTOMER_ROOTS = [
  'apps/web/app/page.tsx',
  'apps/web/app/signup',
  'apps/web/app/login',
  'apps/web/app/accounts',
  'apps/web/app/opportunities',
  'apps/web/app/connections',
  'apps/web/app/money',
  'apps/web/app/billing',
  'apps/web/app/plan',
  'apps/web/app/cases',
  'apps/web/app/upload',
];
function walk(target, out = []) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return out;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    if (/\.(tsx|ts)$/.test(full)) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    walk(path.join(target, entry.name).replace(/\\/g, '/'), out);
  }
  return out;
}
const CUSTOMER_FILES = CUSTOMER_ROOTS.flatMap((root) => walk(root));
const CJK = /[\u4e00-\u9fff]/;
let hardcodeCount = 0;
const hardcodeFiles = [];
for (const file of CUSTOMER_FILES) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
  let fileHits = 0;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')) return;
    if (!CJK.test(line)) return;
    if (allowlist.files.includes(file)) return;
    fileHits += 1;
  });
  if (fileHits > 0) {
    hardcodeCount += fileHits;
    hardcodeFiles.push(file + '(' + fileHits + ')');
  }
}
console.log('HARDCODED_CUSTOMER_STRINGS=' + hardcodeCount + (hardcodeFiles.length ? ' :: ' + hardcodeFiles.slice(0, 12).join(' ') : ''));

// 棘轮（ratchet）：硬编码不得增加；迁移后请下调 baseline。
const BASELINE_FILE = path.join(ROOT, 'tools/i18n/hardcode-baseline.json');
const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : { customerHardcodedStrings: hardcodeCount };
if (hardcodeCount > baseline.customerHardcodedStrings) {
  FAILURES.push(
    'HARDCODE_REGRESSION current=' + hardcodeCount + ' baseline=' + baseline.customerHardcodedStrings + ' files=' + hardcodeFiles.slice(0, 8).join(' '),
  );
}

if (FAILURES.length > 0) {
  console.log('I18N_CHECK=FAIL count=' + FAILURES.length);
  for (const failure of FAILURES) console.log(' - ' + failure);
  process.exit(1);
}
console.log(
  'I18N_CHECK=OK locales=' + LOCALES.length + ' keys=' + base.length + ' statusCodes=' + statusCodes.length + ' customerHardcodes=' + hardcodeCount,
);
