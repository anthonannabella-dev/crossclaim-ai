/**
 * C-0009.2 VALIDATION-RUN HARNESS（架构方 MSG-20260929-09 / -11 / -15 指定方向 A）
 * ---------------------------------------------------------------
 * 目标：让任何平台（Amazon / Shopify / Walmart / TikTok）的**导出文件**进入同一条统一验证流程：
 *
 *   导出文件 → 适配器（字段映射 + quarantine）→ 规范输入 → 结构校验 → 数据质量分析 → 商业评审骨架
 *
 * 三条硬边界：
 *   1) 只做输入统一化与结构性检查：不做平台连接、不做规则判定、不算可追回金额、不生成索赔、不自动提交。
 *   2) 商业结论恒为 OPEN（`commercialConclusion: 'OPEN'`），只能由人工写进 reports/C-0009.1-validation-runs.md。
 *   3) 平台判定只是**猜测**（`platformConfirmed: false`），必须人工确认后才能写进验证记录。
 */

import {
  adaptUploadedFile,
  renderAdapterReport,
  toCanonicalCsv,
  CANONICAL_COLUMNS,
  type AdapterReport,
} from './adapters';
import { verifyRows, type ValidationSummary } from './verify';

export interface HarnessInput {
  fileName: string;
  bytes: Buffer;
  /** 宿主/运营声明的输入类型（默认 desensitized-real-structure） */
  inputKind?: string;
  /** 明确声明平台时直接采用（不再猜测） */
  platform?: string | null;
  now?: () => Date;
}

export interface DataQualitySummary {
  requiredCoverage: { matched: number; total: number };
  optionalCoverage: { matched: number; total: number };
  originalRowCount: number;
  adaptedRowCount: number;
  quarantinedRowCount: number;
  unknownColumns: string[];
  /** 每个规范列的非空填充率（0–100，一位小数） */
  fillRateByColumn: Record<string, number>;
  hints: Array<{ code: string; detail: string; action: string }>;
}

export interface HarnessReport {
  engineeringStatus: 'PASS' | 'FAIL';
  /** 只有真正跑完结构校验且非模板输入才是 RUN_RECORDED */
  validationRunStatus: 'NOT_RUN' | 'RUN_RECORDED';
  commercialConclusion: 'OPEN';
  inputKind: string;
  inputFileName: string;
  inputSha256: string;
  adapterStatus: AdapterReport['status'];
  adapterReport: AdapterReport;
  /** 平台猜测：需要人工确认，绝不写库、绝不据此做判定 */
  platformGuess: string | null;
  platformConfirmed: boolean;
  platformSignature: string | null;
  verification: ValidationSummary | null;
  dataQuality: DataQualitySummary;
  nextSteps: string[];
  generatedAt: string;
}

/**
 * 平台特征表：只按**表头特征**判定，不按文件名猜。
 * 命中即记为 guess（`platformConfirmed: false`），需要人工确认。
 */
const PLATFORM_SIGNATURES: Array<{ platform: string; columns: string[] }> = [
  { platform: 'SHOPIFY', columns: ['ordername', 'financialstatus', 'trackingnumbers'] },
  { platform: 'AMAZON', columns: ['amazonorderid', 'fnsku', 'shipmentid'] },
  { platform: 'WALMART', columns: ['ponumber', 'walmartitemnumber', 'trackingnumber'] },
  { platform: 'TIKTOK', columns: ['tiktokorderid', 'sellersku', 'packageid'] },
];

const REQUIRED_COLUMNS = ['orderId', 'trackingNo', 'invoiceNo'] as const;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function guessPlatform(header: string[]): { platform: string | null; signature: string | null } {
  const normalized = header.map(normalizeHeader);
  for (const entry of PLATFORM_SIGNATURES) {
    const hit = entry.columns.find((column) => normalized.includes(normalizeHeader(column)));
    if (hit) return { platform: entry.platform, signature: hit };
  }
  return { platform: null, signature: null };
}

function summarizeDataQuality(
  adapter: AdapterReport,
  rows: Array<Record<string, string>>,
): DataQualitySummary {
  const fillRateByColumn: Record<string, number> = {};
  for (const column of CANONICAL_COLUMNS) {
    if (rows.length === 0) {
      fillRateByColumn[column] = 0;
      continue;
    }
    const filled = rows.filter((row) => (row[column] ?? '').trim() !== '').length;
    fillRateByColumn[column] = Math.round((filled / rows.length) * 1000) / 10;
  }

  const hints: DataQualitySummary['hints'] = [];
  for (const column of REQUIRED_COLUMNS) {
    if ((fillRateByColumn[column] ?? 0) === 0) {
      hints.push({
        code: 'REQUIRED_COLUMN_EMPTY',
        detail: '规范输入列 ' + column + ' 全部为空',
        action: 'manual_confirmation_required',
      });
    }
  }
  // 适配器会把空的 claimOutcome 归一为 NOT_STARTED，因此「无结论」= 全为 NOT_STARTED 或空
  const outcomeRecorded = rows.some((row) => {
    const value = (row.claimOutcome ?? '').trim();
    return value !== '' && value !== 'NOT_STARTED';
  });
  if (!outcomeRecorded) {
    hints.push({
      code: 'CLAIM_OUTCOME_UNKNOWN',
      detail: '没有一行带真实 claimOutcome（全部为空或 NOT_STARTED）：无法据此计算任何追回口径',
      action: 'provide_claim_outcome_or_accept_reduced_analysis',
    });
  }
  if (adapter.unknownColumns.length > 0) {
    hints.push({
      code: 'UNKNOWN_COLUMNS_PRESENT',
      detail: adapter.unknownColumns.length + ' 个来源列未被识别（未映射、未猜测）',
      action: 'confirm_whether_needed_then_extend_whitelist',
    });
  }

  return {
    requiredCoverage: {
      matched: adapter.coverage.requiredMatched,
      total: adapter.coverage.requiredTotal,
    },
    optionalCoverage: {
      matched: adapter.coverage.optionalMatched,
      total: adapter.coverage.optionalTotal,
    },
    originalRowCount: adapter.originalRowCount,
    adaptedRowCount: adapter.adaptedRowCount,
    quarantinedRowCount: adapter.originalRowCount - adapter.adaptedRowCount,
    unknownColumns: adapter.unknownColumns,
    fillRateByColumn,
    hints,
  };
}

/** 统一入口：任何平台导出文件走同一条验证流程（纯函数，离线、不写库） */
export function runValidationHarness(input: HarnessInput): HarnessReport {
  const at = (input.now ?? (() => new Date()))();
  const generatedAt = at.toISOString();
  const inputKind = input.inputKind ?? 'desensitized-real-structure';

  const adapted = adaptUploadedFile({
    fileName: input.fileName,
    bytes: input.bytes,
    now: input.now,
  });
  const signature = guessPlatform(adapted.report.unknownColumns.length > 0
    ? [...CANONICAL_COLUMNS, ...adapted.report.unknownColumns]
    : [...CANONICAL_COLUMNS]);
  const platformGuess = input.platform ?? signature.platform;
  const platformConfirmed = input.platform !== undefined && input.platform !== null;

  const canonicalRows = adapted.rows.map((row) => row.row as unknown as Record<string, string>);
  const dataQuality = summarizeDataQuality(adapted.report, canonicalRows);

  const nextSteps: string[] = [];
  let verification: ValidationSummary | null = null;

  if (adapted.report.status !== 'PASS') {
    nextSteps.push('adapter_quarantine_review: 先按适配报告修正来源文件，再重跑');
  } else {
    const canonicalCsv = toCanonicalCsv(adapted.rows);
    verification = verifyRows({
      fileName: input.fileName,
      rawText: canonicalCsv,
      inputKind,
      rows: adapted.rows.map((row) => row.row),
      header: [...CANONICAL_COLUMNS],
      now: input.now,
    });
    if (verification.validationRunStatus === 'NOT_RUN') {
      nextSteps.push('template_input_not_a_validation: 模板文件不产生验证记录');
    } else {
      nextSteps.push('record_validation_run_manually: 由人工把本次运行写入 reports/C-0009.1-validation-runs.md');
    }
  }
  if (!platformConfirmed && platformGuess) {
    nextSteps.push('confirm_platform_guess: 平台为特征猜测，人工确认后才能写进验证记录');
  }
  if (dataQuality.hints.length > 0) {
    nextSteps.push('review_data_quality_hints: 见数据质量提示（不含商业结论）');
  }

  return {
    engineeringStatus: 'PASS',
    validationRunStatus: verification?.validationRunStatus ?? 'NOT_RUN',
    commercialConclusion: 'OPEN',
    inputKind,
    inputFileName: input.fileName,
    inputSha256: adapted.report.sourceSha256,
    adapterStatus: adapted.report.status,
    adapterReport: adapted.report,
    platformGuess,
    platformConfirmed,
    platformSignature: signature.signature,
    verification,
    dataQuality,
    nextSteps,
    generatedAt,
  };
}

/** 数据质量 + 商业评审骨架报告（Markdown，可直接贴进验证记录） */
export function renderHarnessReport(report: HarnessReport): string {
  const lines: string[] = [];
  lines.push('# VALIDATION-RUN HARNESS REPORT');
  lines.push('');
  lines.push('- 工程状态：' + report.engineeringStatus);
  lines.push('- 验证运行状态：' + report.validationRunStatus);
  lines.push('- 商业结论：' + report.commercialConclusion + '（恒为 OPEN：只能由人工裁定）');
  lines.push('- 输入文件：' + report.inputFileName + '（sha256 ' + report.inputSha256.slice(0, 12) + '…）');
  lines.push('- 输入类型：' + report.inputKind);
  lines.push('- 适配状态：' + report.adapterStatus);
  lines.push(
    '- 平台：' + (report.platformGuess ?? '未判定') + (report.platformConfirmed ? '（已声明）' : '（猜测，需人工确认）'),
  );
  lines.push('');
  lines.push('## 数据质量');
  lines.push('');
  lines.push('- 必需列覆盖：' + report.dataQuality.requiredCoverage.matched + '/' + report.dataQuality.requiredCoverage.total);
  lines.push('- 可选列覆盖：' + report.dataQuality.optionalCoverage.matched + '/' + report.dataQuality.optionalCoverage.total);
  lines.push('- 原始行数：' + report.dataQuality.originalRowCount + '；已适配：' + report.dataQuality.adaptedRowCount);
  lines.push('- 未识别来源列：' + (report.dataQuality.unknownColumns.length === 0 ? '无' : report.dataQuality.unknownColumns.join(', ')));
  lines.push('');
  lines.push('| 规范列 | 填充率 % |');
  lines.push('|---|---|');
  for (const [column, rate] of Object.entries(report.dataQuality.fillRateByColumn)) {
    lines.push('| ' + column + ' | ' + rate + ' |');
  }
  if (report.dataQuality.hints.length > 0) {
    lines.push('');
    lines.push('### 提示（不含商业结论）');
    lines.push('');
    for (const hint of report.dataQuality.hints) {
      lines.push('- ' + hint.code + '：' + hint.detail + ' → ACTION：' + hint.action);
    }
  }
  lines.push('');
  lines.push('## 结构校验');
  lines.push('');
  if (report.verification) {
    lines.push('- 校验运行状态：' + report.verification.validationRunStatus);
    lines.push('- 问题数：' + report.verification.issues.length);
    for (const issue of report.verification.issues.slice(0, 20)) {
      lines.push('  - ' + issue.code + (issue.field ? '(' + issue.field + ')' : '') + (issue.row ? ' 行 ' + issue.row : ''));
    }
  } else {
    lines.push('未执行（适配阶段未通过或为模板输入）。');
  }
  lines.push('');
  lines.push('## 商业评审骨架（人工填写）');
  lines.push('');
  lines.push('1. 这批数据能否支撑一次商业验证？可行/不可行 + 理由');
  lines.push('2. 人工成本：处理一条需要多少分钟（实测，不估）');
  lines.push('3. Agent 替代比例：哪一步完全由系统完成');
  lines.push('4. 付费信号：客户是否表达付费意愿（原话）');
  lines.push('5. 结论：本场景是否值得进入 C-0015 单场景选择');
  lines.push('');
  lines.push('## 下一步（系统建议，非商业结论）');
  lines.push('');
  for (const step of report.nextSteps) lines.push('- ' + step);
  lines.push('');
  return lines.join('\n');
}

export { renderAdapterReport };
