import type { RecoveryChannel } from '@prisma/client';

/**
 * 归一化后的一行 —— 与具体渠道无关的中间形态。
 * 导入链路：文件 → 二维表 → NormalizedRow[] → LossSignal
 */
export interface NormalizedRow {
  /** 追踪号 / 单据号 / 结算单号，用于追溯 */
  sourceRef?: string;
  /** 业务发生时间（不是导入时间） */
  occurredAt?: Date;
  /** 本该收 / 本该不收 */
  amountExpected?: number;
  /** 实际发生 */
  amountActual?: number;
  currency: string;
  /** 漏损类型，如 FREIGHT_CHARGE_MISBILL */
  signalType: string;
  /** 原始行，保留追溯（存进 LossSignal.rawPayload） */
  raw: Record<string, unknown>;
}

/**
 * 列映射：目标字段 → 该渠道可能出现的列名（任一命中即可）。
 * 注意：客户导出的表头千奇百怪，所以映射是【配置】不是【代码】。
 * 第一版给三类渠道的默认映射，客户实际表头不符时用 mapping 覆盖。
 */
export interface ColumnMapping {
  sourceRef?: string[];
  occurredAt?: string[];
  amountExpected?: string[];
  amountActual?: string[];
  currency?: string[];
  signalType?: string[];
}

export interface SkippedRow {
  /** 原文件中的行号（从 1 开始，便于人工核对） */
  line: number;
  reason: string;
}

export interface AdapterResult {
  rows: NormalizedRow[];
  skipped: SkippedRow[];
  /** 命中的表头→列下标，便于排查"客户表头变了" */
  resolvedColumns: Record<string, number>;
}

export interface ImportFileInput {
  tenantId: string;
  channel: RecoveryChannel;
  fileName: string;
  buffer: Buffer;
  createdBy?: string;
  /** 覆盖默认列映射 */
  mapping?: ColumnMapping;
}

