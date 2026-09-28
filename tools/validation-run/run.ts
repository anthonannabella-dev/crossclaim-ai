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
const rawText = readFileSync(inputPath, 'utf8');
const parsed = rowsFromCsv(rawText);
const anonymized = anonymizeRows(parsed.rows);
const summary = verifyRows({
  fileName: path.basename(inputPath),
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

console.log(`engineeringStatus   : ${summary.engineeringStatus}`);
console.log(`validationRunStatus : ${summary.validationRunStatus}`);
console.log(`commercialConclusion: ${summary.commercialConclusion}`);
console.log(`inputSha256         : ${summary.inputSha256}`);
console.log(`rows                : ${summary.inputRowCount}`);
console.log(`out                 : ${outDir}`);
