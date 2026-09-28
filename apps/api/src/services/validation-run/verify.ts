/**
 * C-0009.1 Validation Run Toolkit — 结构校验与报告（**不产生商业结论**）
 * ---------------------------------------------------------------
 * 依据 MSG-20260928-108 / -110：
 *   · 脚手架只回答「工程上能不能跑通、输入结构是否合规」
 *   · 三层状态必须分别输出（REVISE-2）：
 *       engineeringStatus   : PASS | FAIL
 *       validationRunStatus : NOT_RUN | RUN_RECORDED
 *       commercialConclusion: 恒为 OPEN（禁止自动 GO / SUCCESS / VIABLE / PROFITABLE）
 *   · TEMPLATE 输入一律 NOT_RUN（不给机会数、不给金额）
 */

import { createHash } from 'node:crypto';

import { CLAIM_OUTCOMES, FINGERPRINT_LENGTH, VALIDATION_COLUMNS, type ValidationRow } from './anonymize';

export const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD'] as const;
export const ALLOWED_CHANNELS = [
  'UPS',
  'FEDEX',
  'DHL',
  'USPS',
  'FREIGHT_FORWARDER',
  'AMAZON_FBA',
  'WALMART_WFS',
  'TIKTOK_FBT',
  'OTHER',
] as const;

export type EngineeringStatus = 'PASS' | 'FAIL';
export type ValidationRunStatus = 'NOT_RUN' | 'RUN_RECORDED';
/** 恒为 OPEN：商业结论只能由人工写进 reports/C-0009.1-validation-runs.md */
export type CommercialConclusion = 'OPEN';

export interface VerificationIssue {
  code: string;
  row?: number;
  field?: string;
  detail?: string;
}

export interface ValidationSummary {
  engineeringStatus: EngineeringStatus;
  validationRunStatus: ValidationRunStatus;
  commercialConclusion: CommercialConclusion;
  inputKind: string;
  inputFileName: string;
  inputSha256: string;
  inputRowCount: number;
  templateDetected: boolean;
  rowCountsByChannel: Record<string, number>;
  rowCountsByClaimOutcome: Record<string, number>;
  issues: VerificationIssue[];
  generatedAt: string;
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** TEMPLATE 识别：文件名或首两个非空行含 TEMPLATE，即视为模板（不产生验证记录）。 */
export function isTemplateSource(fileName: string, text: string): boolean {
  if (/template/i.test(fileName)) return true;
  const head = text.split(/\r?\n/).slice(0, 3).join('\n');
  return /TEMPLATE/.test(head);
}

/** 极简 CSV 解析（支持引号与转义引号；不引入依赖）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

export function rowsFromCsv(text: string): { header: string[]; rows: ValidationRow[] } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { header: [], rows: [] };
  const columns = header.map((cell) => cell.trim());
  return {
    header: columns,
    rows: body.map((cells) => {
      const row: ValidationRow = {};
      columns.forEach((column, index) => {
        row[column] = (cells[index] ?? '').trim();
      });
      return row;
    }),
  };
}

const DECIMAL_RE = /^\d+(\.\d{1,4})?$/;

function isParsableDate(value: string): boolean {
  if (!value) return true; // 允许空（发现阶段可能还没有妥投时间）
  return !Number.isNaN(Date.parse(value));
}

/**
 * 校验一批（已脱敏的）输入行。只产出工程结论与差异清单：
 * 不做商业判断、不计算 ARR、不创建 Case / Settlement / Billing。
 */
export function verifyRows(input: {
  fileName: string;
  rawText: string;
  inputKind: string;
  rows: ValidationRow[];
  header?: string[];
  now?: () => Date;
}): ValidationSummary {
  const issues: VerificationIssue[] = [];
  const templateDetected = isTemplateSource(input.fileName, input.rawText);
  const header = input.header ?? [...VALIDATION_COLUMNS];
  const generatedAtIso = (input.now ?? (() => new Date()))().toISOString();

  // 模板输入：直接 NOT_RUN，不做任何结构校验、不产出行数分布（防止被当成验证记录）
  if (templateDetected) {
    return {
      engineeringStatus: 'PASS',
      validationRunStatus: 'NOT_RUN',
      commercialConclusion: 'OPEN',
      inputKind: input.inputKind,
      inputFileName: input.fileName,
      inputSha256: sha256Of(input.rawText),
      inputRowCount: input.rows.length,
      templateDetected: true,
      rowCountsByChannel: {},
      rowCountsByClaimOutcome: {},
      issues: [],
      generatedAt: generatedAtIso,
    };
  }

  for (const column of VALIDATION_COLUMNS) {
    if (!header.includes(column)) {
      issues.push({ code: 'MISSING_COLUMN', field: column });
    }
  }

  const seen = new Set<string>();
  const rowCountsByChannel: Record<string, number> = {};
  const rowCountsByClaimOutcome: Record<string, number> = {};

  input.rows.forEach((row, index) => {
    const rowNo = index + 2; // 1-based + 表头
    if (!row.orderId) issues.push({ code: 'MISSING_FIELD', row: rowNo, field: 'orderId' });
    if (!row.trackingNo) issues.push({ code: 'MISSING_FIELD', row: rowNo, field: 'trackingNo' });
    if (!row.invoiceNo) issues.push({ code: 'MISSING_FIELD', row: rowNo, field: 'invoiceNo' });

    if (row.channel && !(ALLOWED_CHANNELS as readonly string[]).includes(row.channel)) {
      issues.push({ code: 'CHANNEL_NOT_ALLOWED', row: rowNo, field: 'channel', detail: row.channel });
    }
    if (!row.billedCurrency || !(ALLOWED_CURRENCIES as readonly string[]).includes(row.billedCurrency)) {
      issues.push({ code: 'CURRENCY_NOT_ALLOWED', row: rowNo, field: 'billedCurrency', detail: row.billedCurrency });
    }
    if (row.invoiceCurrency && !(ALLOWED_CURRENCIES as readonly string[]).includes(row.invoiceCurrency)) {
      issues.push({ code: 'CURRENCY_NOT_ALLOWED', row: rowNo, field: 'invoiceCurrency', detail: row.invoiceCurrency });
    }
    if (row.billedAmount && !DECIMAL_RE.test(row.billedAmount)) {
      issues.push({ code: 'AMOUNT_FORMAT', row: rowNo, field: 'billedAmount', detail: row.billedAmount });
    }
    if (row.invoiceAmount && !DECIMAL_RE.test(row.invoiceAmount)) {
      issues.push({ code: 'AMOUNT_FORMAT', row: rowNo, field: 'invoiceAmount', detail: row.invoiceAmount });
    }
    if (!isParsableDate(row.promisedDeliveredAt)) {
      issues.push({ code: 'DATE_UNPARSABLE', row: rowNo, field: 'promisedDeliveredAt' });
    }
    if (!isParsableDate(row.actualDeliveredAt)) {
      issues.push({ code: 'DATE_UNPARSABLE', row: rowNo, field: 'actualDeliveredAt' });
    }
    if (row.promisedDeliveredAt && row.actualDeliveredAt) {
      const promised = Date.parse(row.promisedDeliveredAt);
      const actual = Date.parse(row.actualDeliveredAt);
      if (!Number.isNaN(promised) && !Number.isNaN(actual) && actual < promised) {
        issues.push({ code: 'DELIVERY_BEFORE_PROMISE', row: rowNo });
      }
    }

    const outcome = row.claimOutcome || 'NOT_STARTED';
    if (!(CLAIM_OUTCOMES as readonly string[]).includes(outcome)) {
      issues.push({ code: 'CLAIM_OUTCOME_NOT_ALLOWED', row: rowNo, field: 'claimOutcome', detail: outcome });
    } else {
      rowCountsByClaimOutcome[outcome] = (rowCountsByClaimOutcome[outcome] ?? 0) + 1;
    }
    if (row.channel) rowCountsByChannel[row.channel] = (rowCountsByChannel[row.channel] ?? 0) + 1;

    const key = `${row.trackingNo}::${row.invoiceNo}`;
    if (seen.has(key)) issues.push({ code: 'DUPLICATE_ROW', row: rowNo, detail: key });
    seen.add(key);
  });

  const engineeringStatus: EngineeringStatus = issues.length === 0 ? 'PASS' : 'FAIL';
  const validationRunStatus: ValidationRunStatus = 'RUN_RECORDED';
  const generatedAt = generatedAtIso;

  return {
    engineeringStatus,
    validationRunStatus,
    commercialConclusion: 'OPEN',
    inputKind: input.inputKind,
    inputFileName: input.fileName,
    inputSha256: sha256Of(input.rawText),
    inputRowCount: input.rows.length,
    templateDetected,
    rowCountsByChannel,
    rowCountsByClaimOutcome,
    issues,
    generatedAt,
  };
}

/** 人读报告（登记进 reports/C-0009.1-validation-runs.md 的字段在这里逐项给出）。 */
export function renderReport(summary: ValidationSummary): string {
  const lines = [
    '# Validation Run Report（工程脚手架产出，**不含商业结论**）',
    '',
    '```text',
    `engineeringStatus   : ${summary.engineeringStatus}`,
    `validationRunStatus : ${summary.validationRunStatus}${summary.templateDetected ? '  (TEMPLATE 输入，不计入商业验证)' : ''}`,
    `commercialConclusion: ${summary.commercialConclusion}   ← 只能由人工在 reports/C-0009.1-validation-runs.md 里写`,
    '```',
    '',
    '## 输入指纹',
    '',
    `- 文件：\`${summary.inputFileName}\``,
    `- inputKind：\`${summary.inputKind}\``,
    `- sha256：\`${summary.inputSha256}\`（前 ${FINGERPRINT_LENGTH} 位登记用：\`${summary.inputSha256.slice(0, FINGERPRINT_LENGTH)}\`）`,
    `- 行数：${summary.inputRowCount}`,
    `- 生成时间：${summary.generatedAt}`,
    '',
    '## 行数分布',
    '',
    `- 渠道：${Object.entries(summary.rowCountsByChannel).map(([k, v]) => `${k}=${v}`).join(' · ') || '（无）'}`,
    `- claimOutcome：${Object.entries(summary.rowCountsByClaimOutcome).map(([k, v]) => `${k}=${v}`).join(' · ') || '（无）'}`,
    '',
    '## 结构问题',
    '',
  ];
  if (summary.issues.length === 0) {
    lines.push('- 无');
  } else {
    for (const issue of summary.issues.slice(0, 200)) {
      lines.push(`- \`${issue.code}\`${issue.row ? ` 行 ${issue.row}` : ''}${issue.field ? ` 字段 ${issue.field}` : ''}${issue.detail ? ` — ${issue.detail}` : ''}`);
    }
  }
  lines.push(
    '',
    '> 本报告只说明「输入结构是否合规、工程链路是否跑通」；是否值得做、客户是否付费，',
    '> 一律由人工判断并写入 `reports/C-0009.1-validation-runs.md` 与 `C-0009.1-commercial-feedback.md`。',
    '',
  );
  return lines.join('\n');
}
