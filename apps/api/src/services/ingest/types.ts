/**
 * 导入层契约（C-0003 / Gate 1 · Checkpoint 2 第 1 项 Import foundation）
 * ---------------------------------------------------------------
 * 导入层的职责边界（架构方在 Checkpoint 1 PASS 中明确）：
 *   File / API input → parse → normalize → validate → ImportBatch → SourceTransaction
 *
 * 因此这里**只做**：
 *   - 把输入解析成行（不解释业务含义）
 *   - 按列映射把外部字段归一化为内部字段
 *   - 校验并逐行记录问题（行级失败，不整体中断）
 *   - 产出 ImportBatch 统计与 SourceTransaction 草稿（保留 raw）
 *
 * 这里**不做**：金额结论、规则评估、机会生成、账本写入（那是 Rule Engine / Domain / Money 层）。
 */

import type { Channel, RecoveryDomain } from '@prisma/client';

/** 内部字段（SourceTransaction 上真正存在的列） */
export const INTERNAL_FIELDS = [
  'externalId',
  'referenceType',
  'occurredAt',
  'amount',
  'currency',
] as const;

export type InternalField = (typeof INTERNAL_FIELDS)[number];

/** 外部列名 → 内部字段（每批次留快照，便于事后复现） */
export type ColumnMapping = Partial<Record<InternalField, string>>;

export type RawRow = Record<string, string>;

export interface RowIssue {
  /** 1-based 数据行号（不含表头） */
  row: number;
  field?: InternalField | 'row';
  code: 'MISSING_REQUIRED' | 'INVALID_AMOUNT' | 'INVALID_DATE' | 'INVALID_CURRENCY' | 'EMPTY_ROW';
  message: string;
}

export interface NormalizedTransaction {
  /** 1-based 数据行号 */
  row: number;
  externalId: string | null;
  referenceType: string | null;
  occurredAt: Date | null;
  amount: string | null;
  currency: string;
  /** 原始行：Normalize 层不得丢原始数据 */
  raw: RawRow;
  dedupeKey: string;
}

export interface ParseResult {
  header: string[];
  rows: string[][];
}

export interface ImportContext {
  organizationId: string;
  domain: RecoveryDomain;
  channel: Channel;
  connectionId?: string;
  createdBy?: string;
}

export interface ImportResult {
  batchId: string;
  status: 'IMPORTED' | 'PARTIAL' | 'FAILED';
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  duplicates: number;
  issues: RowIssue[];
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}
