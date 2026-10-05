/**
 * RSI-P1-05 —— 不可变证据账本（append-only + supersedes，纯函数）
 * ---------------------------------------------------------------
 * 裁定依据：MSG-20261005-02 —— MetricResult / PromotionDecision / RollbackRecord 必须 **append-only**，
 * 变更只能「写新记录 + supersedes 指向旧记录」，禁止原地改写或删除。
 *
 * 契约：
 *   · 同 `evidenceId` 只能写入一次 → 重复即 `EVIDENCE_IMMUTABLE`；
 *   · `supersedesId` 必须指向**同 subject** 的、尚未被取代的记录（线性链，一条只能被取代一次）；
 *   · 禁止自取代；digest 完全相同的取代视为无实质变化 → `NO_OP_SUPERSEDE`；
 *   · 本模块**不修改传入数组**，永远返回新数组（调用方不可能通过本 API 原地改历史）；
 *   · 纯函数：零 IO、不落库、不发网络、不读凭据、不碰客户数据。
 */

export const RSI_EVIDENCE_KINDS = [
  'EVALUATION_RUN',
  'METRIC_RESULT',
  'PROMOTION_DECISION',
  'ROLLBACK_RECORD',
] as const;
export type RsiEvidenceKind = (typeof RSI_EVIDENCE_KINDS)[number];

export interface RsiEvidenceRecord {
  evidenceId: string;
  kind: RsiEvidenceKind;
  /** 这条证据证明的对象（candidate / task / incident 的 opaque ref） */
  subjectRef: string;
  /** 内容摘要（不存原始输出） */
  digest: string;
  recordedAt: string;
  /** 谁产出的（用于 Builder/Judge 独立性判定） */
  producedBy: string;
  /** null = 首条；否则必须指向同 subject 的旧记录 */
  supersedesId: string | null;
}

export type RsiEvidenceRejection =
  | 'EVIDENCE_IMMUTABLE'
  | 'SUPERSEDES_NOT_FOUND'
  | 'ALREADY_SUPERSEDED'
  | 'SELF_SUPERSEDES_FORBIDDEN'
  | 'SUBJECT_MISMATCH'
  | 'NO_OP_SUPERSEDE';

export type RsiEvidenceAppendResult =
  | { ok: true; records: readonly RsiEvidenceRecord[]; head: RsiEvidenceRecord }
  | { ok: false; reason: RsiEvidenceRejection };

/** 追加一条证据；返回**新数组**，绝不修改 existing */
export function appendRsiEvidence(
  existing: readonly RsiEvidenceRecord[],
  next: RsiEvidenceRecord,
): RsiEvidenceAppendResult {
  if (existing.some((record) => record.evidenceId === next.evidenceId)) {
    return { ok: false, reason: 'EVIDENCE_IMMUTABLE' };
  }

  if (next.supersedesId !== null) {
    if (next.supersedesId === next.evidenceId) return { ok: false, reason: 'SELF_SUPERSEDES_FORBIDDEN' };
    const target = existing.find((record) => record.evidenceId === next.supersedesId);
    if (target === undefined) return { ok: false, reason: 'SUPERSEDES_NOT_FOUND' };
    if (target.subjectRef !== next.subjectRef) return { ok: false, reason: 'SUBJECT_MISMATCH' };
    if (existing.some((record) => record.supersedesId === target.evidenceId)) {
      return { ok: false, reason: 'ALREADY_SUPERSEDED' };
    }
    if (target.digest === next.digest) return { ok: false, reason: 'NO_OP_SUPERSEDE' };
  }

  const records = [...existing, next];
  return { ok: true, records, head: next };
}

/** 该 subject 的全部记录（按 supersedes 链从最早到最新；游离记录按记录顺序追加在后面） */
export function chainOf(
  records: readonly RsiEvidenceRecord[],
  subjectRef: string,
): readonly RsiEvidenceRecord[] {
  const scoped = records.filter((record) => record.subjectRef === subjectRef);
  const superseded = new Set(scoped.map((record) => record.supersedesId).filter((id): id is string => id !== null));
  const roots = scoped.filter((record) => record.supersedesId === null);
  const chain: RsiEvidenceRecord[] = [];
  const visited = new Set<string>();
  const byId = new Map(scoped.map((record) => [record.evidenceId, record]));
  const childOf = (parentId: string): RsiEvidenceRecord | undefined => {
    const child = scoped.find((record) => record.supersedesId === parentId);
    return child === undefined ? undefined : byId.get(child.evidenceId);
  };
  for (const root of roots) {
    let current: RsiEvidenceRecord | undefined = root;
    while (current !== undefined && !visited.has(current.evidenceId)) {
      chain.push(current);
      visited.add(current.evidenceId);
      current = childOf(current.evidenceId);
    }
  }
  for (const record of scoped) {
    if (!visited.has(record.evidenceId) && !superseded.has(record.evidenceId)) chain.push(record);
  }
  return chain;
}

/** 该 subject 的未被取代记录（正常应为 1 条；多于 1 条说明存在分叉，调用方必须 fail-closed） */
export function headsOf(
  records: readonly RsiEvidenceRecord[],
  subjectRef: string,
): readonly RsiEvidenceRecord[] {
  const scoped = records.filter((record) => record.subjectRef === subjectRef);
  const superseded = new Set(scoped.map((record) => record.supersedesId).filter((id): id is string => id !== null));
  return scoped.filter((record) => !superseded.has(record.evidenceId));
}

/** 唯一 head；分叉（>1）或为空时返回 null —— fail-closed，不猜 */
export function headOf(
  records: readonly RsiEvidenceRecord[],
  subjectRef: string,
): RsiEvidenceRecord | null {
  const heads = headsOf(records, subjectRef);
  return heads.length === 1 ? heads[0]! : null;
}

export interface RsiEvidenceLedgerVerification {
  ok: boolean;
  problems: readonly string[];
}

/** 校验账本结构完整性（重复 id / 悬空 supersedes / 跨 subject / 自取代 / 一条被取代两次 / 环） */
export function verifyEvidenceLedger(
  records: readonly RsiEvidenceRecord[],
): RsiEvidenceLedgerVerification {
  const problems: string[] = [];
  const byId = new Map<string, RsiEvidenceRecord>();
  for (const record of records) {
    if (byId.has(record.evidenceId)) problems.push(`DUPLICATE_ID:${record.evidenceId}`);
    byId.set(record.evidenceId, record);
  }
  const supersededBy = new Map<string, string[]>();
  for (const record of records) {
    if (record.supersedesId === null) continue;
    if (record.supersedesId === record.evidenceId) problems.push(`SELF_SUPERSEDES:${record.evidenceId}`);
    const target = byId.get(record.supersedesId);
    if (target === undefined) {
      problems.push(`SUPERSEDES_NOT_FOUND:${record.supersedesId}`);
      continue;
    }
    if (target.subjectRef !== record.subjectRef) problems.push(`SUBJECT_MISMATCH:${record.evidenceId}`);
    const bucket = supersededBy.get(record.supersedesId);
    if (bucket === undefined) supersededBy.set(record.supersedesId, [record.evidenceId]);
    else bucket.push(record.evidenceId);
  }
  for (const [targetId, children] of supersededBy) {
    if (children.length > 1) problems.push(`ALREADY_SUPERSEDED:${targetId}`);
  }
  for (const record of records) {
    const seen = new Set<string>([record.evidenceId]);
    let current = record.supersedesId;
    while (current !== null) {
      if (seen.has(current)) {
        problems.push(`CYCLE:${record.evidenceId}`);
        break;
      }
      seen.add(current);
      current = byId.get(current)?.supersedesId ?? null;
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)].sort() };
}

export const RSI_EVIDENCE_LEDGER_BOUNDARY = {
  appendOnly: true,
  mutatesExistingRecords: false,
  deletesRecords: false,
  writesDatabase: false,
  performsNetworkCalls: false,
  readsCredentials: false,
  storesRawOutput: false,
} as const;
