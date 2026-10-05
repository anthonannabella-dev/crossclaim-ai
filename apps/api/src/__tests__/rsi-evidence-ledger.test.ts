/** RSI-P1-05 验收：append-only 证据账本、supersedes 链、输入不可变、结构校验 */

import { describe, expect, it } from 'vitest';

import {
  RSI_EVIDENCE_LEDGER_BOUNDARY,
  appendRsiEvidence,
  chainOf,
  headOf,
  headsOf,
  verifyEvidenceLedger,
  type RsiEvidenceRecord,
} from '../services/autonomy/rsi-evidence-ledger';

const record = (over: Partial<RsiEvidenceRecord> = {}): RsiEvidenceRecord => ({
  evidenceId: 'ev-1',
  kind: 'METRIC_RESULT',
  subjectRef: 'cand-1',
  digest: 'digest-aaaaaaaaaaaa',
  recordedAt: '2026-10-05T01:30:00.000Z',
  producedBy: 'judge-runner',
  supersedesId: null,
  ...over,
});

const appended = (existing: readonly RsiEvidenceRecord[], next: RsiEvidenceRecord): readonly RsiEvidenceRecord[] => {
  const result = appendRsiEvidence(existing, next);
  if (!result.ok) throw new Error('expected ok: ' + result.reason);
  return result.records;
};

describe('RSI evidence ledger', () => {
  it('RSI_EVIDENCE_APPEND_ONLY：追加返回新数组，绝不修改传入账本', () => {
    const existing = [record()];
    const frozen = [...existing];
    const next = record({ evidenceId: 'ev-2', digest: 'digest-bbbbbbbbbbbb', supersedesId: 'ev-1' });
    const result = appendRsiEvidence(existing, next);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.records).toHaveLength(2);
    expect(result.head.evidenceId).toBe('ev-2');
    expect(existing).toEqual(frozen); // 入参未被改写
    expect(result.records[0]).toEqual(frozen[0]);
  });

  it('RSI_EVIDENCE_IMMUTABLE：同 evidenceId 只能写入一次', () => {
    const result = appendRsiEvidence([record()], record({ digest: 'digest-cccccccccccc' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('EVIDENCE_IMMUTABLE');
  });

  it('RSI_EVIDENCE_SUPERSEDES_CHAIN：新记录 + supersedes 指向旧记录，链与 head 正确', () => {
    const first = appended([], record());
    const second = appended(
      first,
      record({ evidenceId: 'ev-2', digest: 'digest-bbbbbbbbbbbb', supersedesId: 'ev-1' }),
    );
    const third = appended(
      second,
      record({ evidenceId: 'ev-3', digest: 'digest-cccccccccccc', supersedesId: 'ev-2' }),
    );
    expect(chainOf(third, 'cand-1').map((entry) => entry.evidenceId)).toEqual(['ev-1', 'ev-2', 'ev-3']);
    expect(headOf(third, 'cand-1')?.evidenceId).toBe('ev-3');
    expect(verifyEvidenceLedger(third).ok).toBe(true);
  });

  it('RSI_EVIDENCE_SUPERSEDES_NOT_FOUND：指向不存在的记录被拒绝', () => {
    const result = appendRsiEvidence([record()], record({ evidenceId: 'ev-2', supersedesId: 'ev-missing' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('SUPERSEDES_NOT_FOUND');
  });

  it('RSI_EVIDENCE_SELF_SUPERSEDES_FORBIDDEN：禁止自取代', () => {
    const result = appendRsiEvidence([], record({ supersedesId: 'ev-1' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('SELF_SUPERSEDES_FORBIDDEN');
  });

  it('RSI_EVIDENCE_ALREADY_SUPERSEDED：一条记录只能被取代一次（禁止分叉）', () => {
    const first = appended([], record());
    const second = appended(first, record({ evidenceId: 'ev-2', digest: 'digest-bbbbbbbbbbbb', supersedesId: 'ev-1' }));
    const fork = appendRsiEvidence(second, record({ evidenceId: 'ev-3', digest: 'digest-cccccccccccc', supersedesId: 'ev-1' }));
    expect(fork.ok).toBe(false);
    if (fork.ok) throw new Error('expected rejection');
    expect(fork.reason).toBe('ALREADY_SUPERSEDED');
  });

  it('RSI_EVIDENCE_SUBJECT_MISMATCH：跨 subject 取代被拒绝', () => {
    const result = appendRsiEvidence(
      [record()],
      record({ evidenceId: 'ev-2', subjectRef: 'cand-2', digest: 'digest-bbbbbbbbbbbb', supersedesId: 'ev-1' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('SUBJECT_MISMATCH');
  });

  it('RSI_EVIDENCE_NO_OP_SUPERSEDE：digest 相同的“取代”没有实质变化 → 拒绝', () => {
    const result = appendRsiEvidence([record()], record({ evidenceId: 'ev-2', supersedesId: 'ev-1' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('NO_OP_SUPERSEDE');
  });

  it('RSI_EVIDENCE_HEADS_FAIL_CLOSED：同一 subject 出现多条未被取代记录 → head 为 null（分叉不猜）', () => {
    const ledger = [record(), record({ evidenceId: 'ev-9', digest: 'digest-dddddddddddd' })];
    expect(headsOf(ledger, 'cand-1')).toHaveLength(2);
    expect(headOf(ledger, 'cand-1')).toBeNull();
    expect(verifyEvidenceLedger(ledger).ok).toBe(true); // 多条独立证据本身合法，只是 head 不唯一
  });

  it('RSI_EVIDENCE_VERIFY_DETECTS_CORRUPTION：手工构造的坏账本会被检出（重复 id / 悬空 / 分叉 / 环）', () => {
    const corrupt: RsiEvidenceRecord[] = [
      record({ evidenceId: 'a' }),
      record({ evidenceId: 'a' }),
      record({ evidenceId: 'b', digest: 'digest-bbbbbbbbbbbb', supersedesId: 'missing' }),
      record({ evidenceId: 'c', digest: 'digest-cccccccccccc', supersedesId: 'd' }),
      record({ evidenceId: 'd', digest: 'digest-dddddddddddd', supersedesId: 'c' }),
    ];
    const verification = verifyEvidenceLedger(corrupt);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('DUPLICATE_ID:a');
    expect(verification.problems).toContain('SUPERSEDES_NOT_FOUND:missing');
    expect(verification.problems).toContain('CYCLE:c');
  });

  it('RSI_EVIDENCE_LEDGER_BOUNDARY：只追加、不改写、不删除、不落库、不发网络', () => {
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.appendOnly).toBe(true);
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.mutatesExistingRecords).toBe(false);
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.deletesRecords).toBe(false);
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_EVIDENCE_LEDGER_BOUNDARY.storesRawOutput).toBe(false);
  });
});
