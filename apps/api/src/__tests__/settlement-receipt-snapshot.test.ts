/**
 * R46 S2 —— Canonical Receipt Snapshot digest（MSG-20261002-55 CHANGE B 硬验收）
 * 纯函数测试：不连接数据库、不创建 Settlement、不触碰资金域。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertReceiptSnapshotDigest,
  buildReceiptSnapshot,
  canonicalAmount,
  canonicalCurrency,
  canonicalReceivedAt,
  computeReceiptSnapshotDigest,
  ReceiptSnapshotError,
  receiptSnapshotBusinessFields,
  RECEIPT_SNAPSHOT_VERSION,
  type ReceiptSnapshotInput,
} from '../services/settlement/receipt-snapshot';
import { canonicalJson } from '../services/platform-write/snapshot';

const EVIDENCE_A = { evidenceArtifactId: 'ev-a', digest: 'a'.repeat(64), kind: 'BANK_STATEMENT' };
const EVIDENCE_B = { evidenceArtifactId: 'ev-b', digest: 'b'.repeat(64), kind: 'PSP_SETTLEMENT_REPORT' };

const base = (overrides: Partial<ReceiptSnapshotInput> = {}): ReceiptSnapshotInput => ({
  organizationId: 'org-1',
  claimItemId: 'claim-item-1',
  caseId: 'case-1',
  linkageBasisKind: 'CLAIM_ITEM_DIRECT',
  externalIdentityKind: 'BANK_TRANSACTION',
  externalIdentityValueHash: 'c'.repeat(64),
  externalIdentityVersion: 'v1',
  amount: '100.0000',
  currency: 'USD',
  receivedAt: '2026-10-01T01:00:00.000Z',
  sourceKind: 'BANK_STATEMENT',
  evidenceReferences: [EVIDENCE_A],
  ...overrides,
});

describe('R46 S2 canonical receipt snapshot（CHANGE B）', () => {
  it('digest 等价于 sha256(canonicalJson(business fields))', () => {
    const input = base();
    const fields = receiptSnapshotBusinessFields(input);
    const expected = createHash('sha256').update(canonicalJson(fields)).digest('hex');
    expect(computeReceiptSnapshotDigest(input)).toBe(expected);
    expect(buildReceiptSnapshot(input).snapshotDigest).toBe(expected);
    expect(fields.snapshotVersion).toBe(RECEIPT_SNAPSHOT_VERSION);
  });

  it('key 顺序变化 → digest 不变', () => {
    const a = base();
    const b: ReceiptSnapshotInput = {
      sourceKind: a.sourceKind,
      receivedAt: a.receivedAt,
      currency: a.currency,
      amount: a.amount,
      evidenceReferences: [...a.evidenceReferences],
      externalIdentityKind: a.externalIdentityKind,
      externalIdentityValueHash: a.externalIdentityValueHash,
      externalIdentityVersion: a.externalIdentityVersion,
      linkageBasisKind: a.linkageBasisKind,
      caseId: a.caseId,
      claimItemId: a.claimItemId,
      organizationId: a.organizationId,
    };
    expect(computeReceiptSnapshotDigest(b)).toBe(computeReceiptSnapshotDigest(a));
  });

  it('amount 表达规范化（1.5 / 1.500000 → 1.5000）→ digest 不变', () => {
    expect(canonicalAmount('1.5')).toBe('1.5000');
    expect(canonicalAmount('1.500000')).toBe('1.5000');
    expect(computeReceiptSnapshotDigest(base({ amount: '1.5' }))).toBe(
      computeReceiptSnapshotDigest(base({ amount: '1.5000' })),
    );
  });

  it('currency canonical 化（usd → USD）→ digest 不变；非法币种拒绝', () => {
    expect(canonicalCurrency(' usd ')).toBe('USD');
    expect(computeReceiptSnapshotDigest(base({ currency: 'usd' }))).toBe(
      computeReceiptSnapshotDigest(base({ currency: 'USD' })),
    );
    expect(() => canonicalCurrency('US')).toThrowError(ReceiptSnapshotError);
    expect(() => canonicalCurrency('US1')).toThrowError(ReceiptSnapshotError);
  });

  it('receivedAt UTC 规范化 → digest 不变', () => {
    const zulu = '2026-10-01T01:00:00.000Z';
    const offset = '2026-10-01T10:00:00.000+09:00';
    expect(canonicalReceivedAt(offset)).toBe(zulu);
    expect(canonicalReceivedAt(new Date(zulu))).toBe(zulu);
    expect(computeReceiptSnapshotDigest(base({ receivedAt: offset }))).toBe(
      computeReceiptSnapshotDigest(base({ receivedAt: zulu })),
    );
  });

  it('evidence 顺序变化 → digest 不变（稳定排序）', () => {
    const ordered = base({ evidenceReferences: [EVIDENCE_A, EVIDENCE_B] });
    const reversed = base({ evidenceReferences: [EVIDENCE_B, EVIDENCE_A] });
    expect(computeReceiptSnapshotDigest(ordered)).toBe(computeReceiptSnapshotDigest(reversed));
    expect(buildReceiptSnapshot(reversed).evidenceReferences.map((e) => e.evidenceArtifactId)).toEqual([
      'ev-a',
      'ev-b',
    ]);
  });

  it('identity / version 纳入 digest（任一变化 → 新 digest）', () => {
    const baseDigest = computeReceiptSnapshotDigest(base());
    expect(computeReceiptSnapshotDigest(base({ externalIdentityValueHash: 'd'.repeat(64) }))).not.toBe(baseDigest);
    expect(computeReceiptSnapshotDigest(base({ externalIdentityVersion: 'v2' }))).not.toBe(baseDigest);
    expect(
      computeReceiptSnapshotDigest(base({ externalIdentityKind: 'PSP_SETTLEMENT' })),
    ).not.toBe(baseDigest);
    expect(
      computeReceiptSnapshotDigest(
        base({ externalIdentityValueHash: null, financialEventFingerprint: 'e'.repeat(64) }),
      ),
    ).not.toBe(baseDigest);
    expect(computeReceiptSnapshotDigest(base({ sourceKind: 'MANUAL_DOCUMENT' }))).not.toBe(baseDigest);
  });

  it('任一可信资金字段变化 → digest 变化', () => {
    const baseDigest = computeReceiptSnapshotDigest(base());
    const variants: Partial<ReceiptSnapshotInput>[] = [
      { amount: '100.0001' },
      { currency: 'EUR' },
      { receivedAt: '2026-10-01T01:00:00.001Z' },
      { claimItemId: 'claim-item-2' },
      { caseId: 'case-2' },
      { evidenceReferences: [EVIDENCE_A, EVIDENCE_B] },
      { organizationId: 'org-2' },
    ];
    for (const variant of variants) {
      expect(computeReceiptSnapshotDigest(base(variant))).not.toBe(baseDigest);
    }
  });

  it('非业务 metadata 变化 → digest 不变', () => {
    const baseDigest = computeReceiptSnapshotDigest(base());
    expect(computeReceiptSnapshotDigest(base({ createdByUserId: 'user-1' }))).toBe(baseDigest);
    expect(computeReceiptSnapshotDigest(base({ createdByUserId: 'user-2' }))).toBe(baseDigest);
    // externalIdentityValue 仅 provenance / display，不进 digest
    expect(computeReceiptSnapshotDigest(base({ externalIdentityValue: 'RAW-REF-1' }))).toBe(baseDigest);
    expect(computeReceiptSnapshotDigest(base({ externalIdentityValue: 'RAW-REF-2' }))).toBe(baseDigest);
  });

  it('客户端提供的 digest → 拒绝为不可信输入', () => {
    expect(() => computeReceiptSnapshotDigest(base({ clientSnapshotDigest: 'f'.repeat(64) }))).toThrowError(
      /CLIENT_DERIVED_FIELD_NOT_TRUSTED|client-provided snapshotDigest/,
    );
    expect(() => buildReceiptSnapshot(base({ clientSnapshotDigest: 'f'.repeat(64) }))).toThrowError(
      ReceiptSnapshotError,
    );
  });

  it('输入校验：无身份 / 无 evidence / 重复 evidence / 金额非法 / 币种非法 → fail-closed', () => {
    expect(() =>
      computeReceiptSnapshotDigest(base({ externalIdentityValueHash: null })),
    ).toThrowError(/MISSING_EXTERNAL_IDENTITY|externalIdentityValueHash/);
    expect(() => computeReceiptSnapshotDigest(base({ evidenceReferences: [] }))).toThrowError(
      /INVALID_EVIDENCE|at least one evidence/,
    );
    expect(() =>
      computeReceiptSnapshotDigest(base({ evidenceReferences: [EVIDENCE_A, { ...EVIDENCE_A }] })),
    ).toThrowError(/DUPLICATE_EVIDENCE|duplicate evidence/);
    expect(() => canonicalAmount('0')).toThrowError(/INVALID_AMOUNT|> 0/);
    expect(() => canonicalAmount('-1')).toThrowError(ReceiptSnapshotError);
    expect(() => canonicalAmount('1.00001')).toThrowError(ReceiptSnapshotError);
    expect(() => canonicalCurrency('usd1')).toThrowError(ReceiptSnapshotError);
    expect(() => canonicalReceivedAt('not-a-date')).toThrowError(/INVALID_TIMESTAMP|valid timestamp/);
    expect(() =>
      computeReceiptSnapshotDigest(base({ linkageBasisKind: 'MANUAL_BASIS', linkageBasisRef: null })),
    ).toThrowError(/MISSING_LINKAGE_BASIS|linkageBasisRef/);
    expect(() =>
      computeReceiptSnapshotDigest(base({ linkageBasisKind: 'CLAIM_ITEM_DIRECT', claimItemId: null })),
    ).toThrowError(/MISSING_LINKAGE_BASIS|claimItemId/);
  });

  it('assertReceiptSnapshotDigest：已存 digest 必须等于服务端重算结果', () => {
    const input = base();
    const digest = computeReceiptSnapshotDigest(input);
    expect(() => assertReceiptSnapshotDigest(digest, input)).not.toThrow();
    expect(() => assertReceiptSnapshotDigest('0'.repeat(64), input)).toThrowError(
      /does not match server-side canonical recomputation/,
    );
  });
});
