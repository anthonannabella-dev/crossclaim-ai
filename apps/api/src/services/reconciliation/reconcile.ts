/**
 * Cross-source reconciliation (C-0005 / Gate 3).
 * ---------------------------------------------------------------
 * The same business fact can arrive twice: once from a FILE_UPLOAD connection
 * and once from an API connection. Both raw sources are kept (provenance is
 * never destroyed), but recovery must never be counted twice, and conflicting
 * values must fail closed instead of silently picking a winner.
 *
 * This module is pure: it takes canonical SourceTransaction projections and
 * returns canonical facts plus conflicts. It never writes and never computes
 * recovery; callers must `assertNoSourceConflict()` before any money math.
 */

import type { SourceConnectionKind } from '@prisma/client';

/** Minimal, storage-agnostic projection of a SourceTransaction row. */
export interface FactSourceTransaction {
  id: string;
  connectionId: string | null;
  connectionKind: SourceConnectionKind | null;
  /**
   * TRACK C2 M4：account scope。null 表示 legacy（迁移窗口内的历史行）。
   * account 只作为**结构化维度**参与分组/唯一性，绝不拼进 factKey。
   */
  accountId?: string | null;
  referenceType: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  /** Decimal(18,4) as string; null when the source had no amount. */
  amount: string | null;
  currency: string;
}

export type FactMode = 'FILE_UPLOAD' | 'API' | 'OTHER';

export interface CanonicalFact {
  /** `REFERENCETYPE:EXTERNALID` (upper-cased) or `UNKEYED:<transactionId>`. */
  factKey: string;
  /** TRACK C2 M4：account scope（null = legacy 行）。 */
  accountId: string | null;
  referenceType: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  amount: string | null;
  currency: string;
  /** Every raw row that belongs to this fact; downstream counts the fact once. */
  transactionIds: string[];
  modes: Record<FactMode, number>;
  /** true when both an API and a FILE_UPLOAD source confirmed the same values. */
  confirmedAcrossModes: boolean;
  /** Duplicate rows inside one mode (never double counted). */
  modeDuplicates: number;
  /** true when at least one source had no occurredAt while another had one. */
  dateGap: boolean;
}

export type SourceConflictReason = 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'DATE_MISMATCH';

export interface SourceConflictEntry {
  transactionId: string;
  mode: FactMode;
  amount: string | null;
  currency: string;
  occurredAt: string | null;
}

export interface SourceConflict {
  factKey: string;
  accountId: string | null;
  referenceType: string | null;
  externalId: string | null;
  reason: SourceConflictReason;
  entries: SourceConflictEntry[];
}

export interface ReconcileResult {
  status: 'OK' | 'CONFLICT';
  /** Canonical facts safe to use for money math (conflicting facts are absent). */
  facts: CanonicalFact[];
  conflicts: SourceConflict[];
  /** Facts that had to be dropped because their sources disagree. */
  droppedFacts: number;
  transactions: number;
}

export class SourceConflictError extends Error {
  readonly code = 'SOURCE_CONFLICT';
  readonly conflicts: SourceConflict[];

  constructor(conflicts: SourceConflict[]) {
    super(
      `SOURCE_CONFLICT：${conflicts.length} 组的来源数据不一致（${conflicts
        .map((conflict) => `${conflict.factKey}:${conflict.reason}`)
        .join(', ')}）；在完成人工对账前拒绝继续`,
    );
    this.name = 'SourceConflictError';
    this.conflicts = conflicts;
  }
}

export function modeOf(kind: SourceConnectionKind | null): FactMode {
  if (kind === 'FILE_UPLOAD') return 'FILE_UPLOAD';
  if (kind === 'API') return 'API';
  return 'OTHER';
}

/**
 * TRACK C2 M4：分组 / 冲突检测必须在 account 作用域内进行。
 * 两个不同 account 里的同一 externalId 是**两条事实**，既不合并也不互判冲突。
 */
export function accountScopedKeyOf(transaction: FactSourceTransaction, factKey: string): string {
  return `${transaction.accountId ?? ''}\u0000${factKey}`;
}

/** External references are matched case-insensitively; blank ids stay unkeyed. */
export function factKeyOf(transaction: FactSourceTransaction): string | null {
  const externalId = transaction.externalId?.trim();
  const referenceType = transaction.referenceType?.trim();
  if (!externalId) return null;
  const type = referenceType ? referenceType.toUpperCase() : 'UNKNOWN';
  return `${type}:${externalId.toUpperCase()}`;
}

/** `152.7500` and `152.75` are the same money value; never compare raw strings. */
export function normalizeDecimal(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const negative = trimmed.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const padded = (fracPart + '0000').slice(0, 4).replace(/0+$/, '');
  const normalizedInt = intPart.replace(/^0+(?=\d)/, '');
  const body = padded ? `${normalizedInt}.${padded}` : normalizedInt;
  return negative && body !== '0' ? `-${body}` : body;
}

function dayOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function entryOf(transaction: FactSourceTransaction): SourceConflictEntry {
  return {
    transactionId: transaction.id,
    mode: modeOf(transaction.connectionKind),
    amount: transaction.amount,
    currency: transaction.currency,
    occurredAt: transaction.occurredAt ? transaction.occurredAt.toISOString() : null,
  };
}

function conflictFor(
  group: readonly FactSourceTransaction[],
  reason: SourceConflictReason,
): SourceConflict {
  const first = group[0];
  return {
    factKey: factKeyOf(first) ?? `UNKEYED:${first.id}`,
    accountId: first.accountId ?? null,
    referenceType: first.referenceType,
    externalId: first.externalId,
    reason,
    entries: group.map(entryOf),
  };
}

function groupConflict(group: readonly FactSourceTransaction[]): SourceConflict | null {
  const currencies = new Set(group.map((row) => row.currency.trim().toUpperCase()));
  if (currencies.size > 1) return conflictFor(group, 'CURRENCY_MISMATCH');

  const amounts = new Set(group.map((row) => normalizeDecimal(row.amount)));
  if (amounts.size > 1) return conflictFor(group, 'AMOUNT_MISMATCH');

  const days = new Set(group.map((row) => dayOf(row.occurredAt)).filter((day): day is string => day !== null));
  if (days.size > 1) return conflictFor(group, 'DATE_MISMATCH');

  return null;
}

export function reconcileSourceFacts(rows: readonly FactSourceTransaction[]): ReconcileResult {
  const groups = new Map<string, FactSourceTransaction[]>();
  const unkeyed: FactSourceTransaction[] = [];

  const accountByScopedKey = new Map<string, string | null>();
  for (const row of rows) {
    const key = factKeyOf(row);
    if (key === null) {
      unkeyed.push(row);
      continue;
    }
    const scoped = accountScopedKeyOf(row, key);
    const group = groups.get(scoped);
    if (group) group.push(row);
    else {
      groups.set(scoped, [row]);
      accountByScopedKey.set(scoped, row.accountId ?? null);
    }
  }

  const facts: CanonicalFact[] = [];
  const conflicts: SourceConflict[] = [];

  for (const [scopedKey, group] of groups) {
    const conflict = groupConflict(group);
    if (conflict) {
      conflicts.push(conflict);
      continue;
    }
    const factKey = factKeyOf(group[0]) ?? `UNKEYED:${group[0].id}`;
    const first = group[0];
    const modes: Record<FactMode, number> = { FILE_UPLOAD: 0, API: 0, OTHER: 0 };
    for (const row of group) modes[modeOf(row.connectionKind)] += 1;

    const dated = group.filter((row) => row.occurredAt !== null);
    facts.push({
      factKey,
      accountId: accountByScopedKey.get(scopedKey) ?? first.accountId ?? null,
      referenceType: first.referenceType,
      externalId: first.externalId,
      occurredAt: dated.length > 0 ? dated[0].occurredAt : null,
      amount: normalizeDecimal(first.amount),
      currency: first.currency.trim().toUpperCase(),
      transactionIds: group.map((row) => row.id),
      modes,
      confirmedAcrossModes: modes.API > 0 && modes.FILE_UPLOAD > 0,
      modeDuplicates: group.length - 1,
      dateGap: dated.length > 0 && dated.length < group.length,
    });
  }

  // Rows without an external reference cannot be matched across sources: each
  // one stays its own fact so it can never silently absorb another row.
  for (const row of unkeyed) {
    const modes: Record<FactMode, number> = { FILE_UPLOAD: 0, API: 0, OTHER: 0 };
    modes[modeOf(row.connectionKind)] += 1;
    facts.push({
      factKey: `UNKEYED:${row.id}`,
      accountId: row.accountId ?? null,
      referenceType: row.referenceType,
      externalId: null,
      occurredAt: row.occurredAt,
      amount: normalizeDecimal(row.amount),
      currency: row.currency.trim().toUpperCase(),
      transactionIds: [row.id],
      modes,
      confirmedAcrossModes: false,
      modeDuplicates: 0,
      dateGap: false,
    });
  }

  return {
    status: conflicts.length > 0 ? 'CONFLICT' : 'OK',
    facts,
    conflicts,
    droppedFacts: conflicts.length,
    transactions: rows.length,
  };
}

/** Fail closed before any money math runs on this tenant slice. */
export function assertNoSourceConflict(result: ReconcileResult): void {
  if (result.conflicts.length > 0) throw new SourceConflictError(result.conflicts);
}
