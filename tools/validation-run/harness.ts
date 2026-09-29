/**
 * C-0009.2 VALIDATION-RUN HARNESS — CLI（薄封装）
 * ---------------------------------------------------------------
 * 在 apps/api 目录下运行（那里已装 tsx，零新增依赖）：
 *   cd apps/api
 *   npx tsx ../../tools/validation-run/harness.ts --in <file> [--platform SHOPIFY] [--out <dir>]
 *
 * 只读输入文件，写出 HARNESS-REPORT.md 与 harness-summary.json；不写库、不调 API、无网络。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { renderHarnessReport, runValidationHarness } from '../../apps/api/src/services/validation-run/harness';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputPath = arg('--in');
if (!inputPath) {
  console.error('usage: npx tsx tools/validation-run/harness.ts --in <file> [--platform <name>] [--out <dir>]');
  process.exit(2);
}

const platform = arg('--platform', '');
const fileName = path.basename(inputPath);
const report = runValidationHarness({
  fileName,
  bytes: readFileSync(inputPath),
  ...(platform ? { platform } : {}),
});

const dir = arg('--out', path.join('out', 'harness-' + report.inputSha256.slice(0, 8))) as string;
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'HARNESS-REPORT.md'), renderHarnessReport(report), 'utf8');
writeFileSync(path.join(dir, 'harness-summary.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('HARNESS_REPORT=' + path.join(dir, 'HARNESS-REPORT.md'));
console.log('ADAPTER_STATUS=' + report.adapterStatus);
console.log('VALIDATION_RUN_STATUS=' + report.validationRunStatus);
console.log('COMMERCIAL_CONCLUSION=' + report.commercialConclusion);
