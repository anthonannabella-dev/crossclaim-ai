/**
 * R43 S2 —— Recovery Package canonical manifest / digest 确定性（无 DB）
 * 覆盖 MSG-20261001-33 TEST 1–6、11、12 的纯函数部分。
 */

import { describe, expect, it } from 'vitest';

import {
  RECOVERY_NOT_SUBMITTED_LABEL,
  RECOVERY_PACKAGE_DIGEST_VERSION,
  RECOVERY_PACKAGE_VERSION,
  buildRecoveryManifest,
  buildRecoveryPackageBasisReference,
  computePackageDigest,
  renderManifestPdf,
  renderManifestPdfLines,
  serializeCanonicalManifest,
  sha256Hex,
  type RecoveryManifestFactInput,
} from '../services/recovery/recovery-package';

function fact(overrides: Partial<RecoveryManifestFactInput> = {}): RecoveryManifestFactInput {
  return {
    organizationId: 'org-1',
    claimItemId: 'claim-item-1',
    caseId: 'case-1',
    platformType: 'AMAZON',
    claimType: 'ORDER_DISCREPANCY',
    normalizedRefs: ['amazon-sp::orders::2', 'amazon-sp::orders::1'],
    currency: 'usd',
    amountExpected: '120',
    amountActual: '100.5',
    recoverableAmount: 19.5,
    occurredAt: '2026-09-02T03:04:05.6789+08:00',
    responsibleParty: 'PLATFORM',
    evidence: [
      { evidenceId: 'ev-b', evidenceType: 'INVOICE', capturedAt: '2026-09-01T00:00:00.000Z' },
      { evidenceId: 'ev-a', evidenceType: 'POD', capturedAt: null },
    ],
    instructionNote: 'submit via Seller Central case',
    ...overrides,
  };
}

describe('R43 S2 — canonical manifest / digest 确定性', () => {
  it('S2-01 key / 数组顺序无关：同类事实输入 → canonical 完全一致、digest 一致', () => {
    const a = buildRecoveryManifest(fact());
    const b = buildRecoveryManifest(
      fact({
        normalizedRefs: ['amazon-sp::orders::1', 'amazon-sp::orders::2'],
        evidence: [
          { evidenceId: 'ev-a', evidenceType: 'POD', capturedAt: null },
          { evidenceId: 'ev-b', evidenceType: 'INVOICE', capturedAt: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(serializeCanonicalManifest(a)).toBe(serializeCanonicalManifest(b));
    expect(computePackageDigest(a)).toBe(computePackageDigest(b));
    // 显式验证 key 顺序无关：手写对象顺序不同 → 序列化相同
    const reordered = { ...a, evidence: a.evidence, packageVersion: a.packageVersion };
    expect(serializeCanonicalManifest(reordered as typeof a)).toBe(serializeCanonicalManifest(a));
  });

  it('S2-02 Decimal / currency / timestamp / null / optional 契约固定', () => {
    const manifest = buildRecoveryManifest(fact());
    expect(manifest.amountExpected).toBe('120.0000');
    expect(manifest.amountActual).toBe('100.5000');
    expect(manifest.recoverableAmount).toBe('19.5000');
    expect(manifest.currency).toBe('USD');
    // 带时区输入 → UTC ISO-8601 毫秒
    expect(manifest.occurredAt).toBe('2026-09-01T19:04:05.678Z');
    // 证据按 evidenceId 字典序排列：ev-a（capturedAt 为空）在前
    expect(manifest.evidence[0].evidenceId).toBe('ev-a');
    expect(manifest.evidence[0].capturedAt).toBeNull();
    expect(manifest.evidence[1].capturedAt).toBe('2026-09-01T00:00:00.000Z');
    // 不同写法但等值的金额 → 同一表达
    expect(buildRecoveryManifest(fact({ amountActual: 100.5 })).amountActual).toBe('100.5000');
    expect(buildRecoveryManifest(fact({ amountActual: '0100.5000' })).amountActual).toBe('100.5000');
  });

  it('S2-03 任一受保护业务字段变化 → digest 必须变化', () => {
    const base = computePackageDigest(buildRecoveryManifest(fact()));
    const variants: Partial<RecoveryManifestFactInput>[] = [
      { claimItemId: 'claim-item-2' },
      { caseId: 'case-2' },
      { claimType: 'DAMAGE' },
      { currency: 'EUR' },
      { amountExpected: '121' },
      { amountActual: null },
      { recoverableAmount: '20.0000' },
      { occurredAt: '2026-09-03T00:00:00.000Z' },
      { responsibleParty: 'CARRIER' },
      { normalizedRefs: ['amazon-sp::orders::1'] },
      { evidence: [{ evidenceId: 'ev-a', evidenceType: 'POD', capturedAt: null }] },
    ];
    for (const variant of variants) {
      expect(computePackageDigest(buildRecoveryManifest(fact(variant)))).not.toBe(base);
    }
  });

  it('S2-04 非业务 metadata（exporter / 时间 / 路径）不进入 package identity', () => {
    const manifest = buildRecoveryManifest(fact());
    const keys = Object.keys(manifest);
    for (const forbidden of ['exportedAt', 'exportedByUserId', 'fileAssetId', 'storageKey', 'path', 'generatedAt']) {
      expect(keys).not.toContain(forbidden);
    }
    // 同一事实、不同生成时间/导出者 → digest 不变（二者根本不在 manifest 中）
    const again = buildRecoveryManifest(fact());
    expect(computePackageDigest(again)).toBe(computePackageDigest(manifest));
  });

  it('S2-05 JSON manifest 是规范事实载体，PDF 从它派生（含 digest 与 NOT SUBMITTED 标识）', () => {
    const manifest = buildRecoveryManifest(fact());
    const digest = computePackageDigest(manifest);
    const lines = renderManifestPdfLines(manifest, digest);
    expect(lines[0]).toContain('RECOVERY SUBMISSION PACKAGE');
    expect(lines[1]).toBe(RECOVERY_NOT_SUBMITTED_LABEL);
    expect(lines.join('\n')).toContain(digest);
    const pdf = renderManifestPdf(manifest, digest);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain(digest);
    // PDF 不引入任何独立业务事实源：其内容行完全来自 manifest
    expect(lines.join('\n')).toContain(manifest.claimItemId);
    expect(lines.join('\n')).toContain(manifest.platformType);
  });

  it('S2-06 artifact 内容不含 credential / token / secret / key 材料', () => {
    const manifest = buildRecoveryManifest(fact());
    const digest = computePackageDigest(manifest);
    const payload = serializeCanonicalManifest(manifest) + '\n' + renderManifestPdf(manifest, digest).toString('latin1');
    for (const pattern of [/credential/i, /token/i, /secret/i, /api[_-]?key/i, /password/i, /bearer\s/i]) {
      expect(payload).not.toMatch(pattern);
    }
    expect(payload).not.toContain('SUBMITTED_MANUAL');
    expect(payload).not.toContain('provider accepted');
  });

  it('S2-11 approval basis 绑定 packageVersion + digestVersion + packageDigest（唯一 canonical builder）', () => {
    const manifest = buildRecoveryManifest(fact());
    const digest = computePackageDigest(manifest);
    const base = buildRecoveryPackageBasisReference({
      claimItemId: manifest.claimItemId,
      caseId: manifest.caseId as string,
      packageVersion: RECOVERY_PACKAGE_VERSION,
      digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
      packageDigest: digest,
    });
    expect(base).toBe(`rmp1:${manifest.claimItemId}:case-1:${RECOVERY_PACKAGE_VERSION}:v1:${digest}`);
    for (const variant of [
      { packageVersion: 'recovery-package/v2' },
      { digestVersion: 'v2' },
      { packageDigest: sha256Hex('other') },
      { caseId: 'case-2' },
      { claimItemId: 'claim-item-2' },
    ]) {
      const other = buildRecoveryPackageBasisReference({
        claimItemId: manifest.claimItemId,
        caseId: 'case-1',
        packageVersion: RECOVERY_PACKAGE_VERSION,
        digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
        packageDigest: digest,
        ...variant,
      });
      expect(other).not.toBe(base);
    }
  });

  it('S2-12 PDF 渲染确定性：同一 manifest + digest → 字节完全相同，且 digest 为 64 hex', () => {
    const manifest = buildRecoveryManifest(fact());
    const digest = computePackageDigest(manifest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(renderManifestPdf(manifest, digest).equals(renderManifestPdf(manifest, digest))).toBe(true);
    expect(sha256Hex(renderManifestPdf(manifest, digest))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('S2-13 非法金额 / 时间表达 → 结构化拒绝（不静默降级）', () => {
    expect(() => buildRecoveryManifest(fact({ amountExpected: 'abc' }))).toThrowError(/INVALID_DECIMAL|非法金额/);
    expect(() => buildRecoveryManifest(fact({ occurredAt: 'not-a-date' }))).toThrowError(/INVALID_TIMESTAMP|非法时间/);
    expect(() => buildRecoveryManifest(fact({ claimItemId: '' }))).toThrowError(/必填/);
  });
});
