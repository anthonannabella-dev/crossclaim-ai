/**
 * C-0009.1 Validation Run Toolkit — CLI（薄封装）
 * ---------------------------------------------------------------
 * 用法（**在 apps/api 目录下运行**，那里已经装了 tsx，零新增依赖）：
 *   cd apps/api
 *   npx tsx ../../tools/validation-run/run.ts --in <csv> \
 *     [--input-kind desensitized-real-structure] [--out <dir>]
 *
 * 它只做三件事：脱敏 → 结构校验 → 产出报告（anonymized.csv / summary.json / report.md）。
 * 它**不写库、不调 API、不创建 Case/Settlement/Billing，也不产出任何商业结论**。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { VALIDATION_COLUMNS, anonymizeRows, type ValidationRow } from '../../apps/api/src/services/validation-run/anonymize';
import { renderReport, rowsFromCsv, verifyRows } from '../../apps/api/src/services/validation-run/verify';
import {
  adaptUploadedFile,
  renderAdapterReport,
  toCanonicalCsv,
} from '../../apps/api/src/services/validation-run/adapters';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function renderCsv(rows: ValidationRow[], header: readonly string[]): string {
  const escape = (cell: string) => `"${String(cell).replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((column) => escape(row[column] ?? '')).join(','));
  return lines.join('\n');
}

const inputPath = arg('--in');
if (!inputPath) {
  console.error('usage: npx tsx tools/validation-run/run.ts --in <csv> [--input-kind <kind>] [--out <dir>]');
  process.exit(2);
}

const inputKind = arg('--input-kind', 'desensitized-real-structure') as string;
const bytes = readFileSync(inputPath);
const rawText = bytes.toString('utf8');
const fileName = path.basename(inputPath);

// C-0009.1-A：先过平台导出适配器（CSV / JSON / XLSX；PDF 与未知结构直接 QUARANTINE）
const adapted = adaptUploadedFile({ fileName, bytes });

// 模板输入仍然一律 NOT_RUN（防止把工程样例当成验证）
const templateInput = /template/i.test(fileName) || rawText.split(/\r?\n/).slice(0, 3).join('\n').includes('TEMPLATE');
if (!templateInput && adapted.report.status !== 'PASS') {
  const dir = arg('--out', path.join('out', `adapter-quarantine-${adapted.report.sourceSha256.slice(0, 8)}`)) as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'VALIDATION-INPUT-ADAPTER-REPORT.json'), JSON.stringify(adapted.report, null, 2), 'utf8');
  writeFileSync(path.join(dir, 'VALIDATION-INPUT-ADAPTER-REPORT.md'), renderAdapterReport(adapted.report), 'utf8');
  console.error(`ADAPTER_QUARANTINE: ${adapted.report.quarantineReason ?? adapted.report.status}`);
  console.error(`see ${path.join(dir, 'VALIDATION-INPUT-ADAPTER-REPORT.md')} —— 请按报告里的 ACTION 人工确认后再跑`);
  process.exit(2);
}

const parsed = templateInput ? rowsFromCsv(rawText) : { header: [...VALIDATION_COLUMNS], rows: adapted.rows.map((item) => item.row) };
const anonymized = anonymizeRows(parsed.rows as ValidationRow[]);
const summary = verifyRows({
  fileName,
  rawText,
  inputKind,
  rows: anonymized,
  header: parsed.header.length > 0 ? parsed.header : [...VALIDATION_COLUMNS],
});

const outDir = arg('--out', path.join('out', `validation-run-${summary.inputSha256.slice(0, 8)}`)) as string;
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'anonymized.csv'), renderCsv(anonymized, VALIDATION_COLUMNS), 'utf8');
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
writeFileSync(path.join(outDir, 'report.md'), renderReport(summary), 'utf8');
writeFileSync(path.join(outDir, 'VALIDATION-INPUT-ADAPTER-REPORT.json'), JSON.stringify(adapted.report, null, 2), 'utf8');
writeFileSync(path.join(outDir, 'VALIDATION-INPUT-ADAPTER-REPORT.md'), renderAdapterReport(adapted.report), 'utf8');
writeFileSync(path.join(outDir, 'canonical-input.csv'), toCanonicalCsv(adapted.rows), 'utf8');

console.log(`adapterFormat       : ${adapted.report.format}（${adapted.report.status}）`);
console.log(`mappedColumns       : required ${adapted.report.coverage.requiredMatched}/${adapted.report.coverage.requiredTotal} · optional ${adapted.report.coverage.optionalMatched}/${adapted.report.coverage.optionalTotal}`);
console.log(`engineeringStatus   : ${summary.engineeringStatus}`);
console.log(`validationRunStatus : ${summary.validationRunStatus}`);
console.log(`commercialConclusion: ${summary.commercialConclusion}`);
console.log(`inputSha256         : ${summary.inputSha256}`);
console.log(`rows                : ${summary.inputRowCount}`);
console.log(`out                 : ${outDir}`);
