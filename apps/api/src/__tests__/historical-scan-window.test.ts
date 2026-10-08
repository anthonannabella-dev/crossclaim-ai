// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 4 + 5（纯函数）
// requested vs effective 窗口解析、reason codes、Customs 未核验政策 → 阻断 CLAIM_READY。

import { describe, expect, it } from 'vitest';

import { planScanShards } from '../services/historical-scan/shard-plan';
import { resolveRecoveryWindow } from '../services/historical-scan/window-resolver';

const FROM = '2021-10-08';
const TO = '2026-10-08';

describe('PHASE 6 · shard plan', () => {
  it('5 年月度 = 60 个分片，季度 = 21 个分片，分片区间连续且确定', () => {
    const monthly = planScanShards({ from: FROM, to: TO });
    expect(monthly).toHaveLength(60);
    expect(monthly[0]).toMatchObject({ index: 0, key: '2021-10', from: '2021-10-08' });
    expect(monthly[59]?.to).toBe(TO);
    for (let i = 1; i < monthly.length; i += 1) {
      expect(monthly[i]!.from).toBe(monthly[i - 1]!.to);
    }

    const quarterly = planScanShards({ from: FROM, to: TO, grain: 'QUARTERLY' });
    expect(quarterly.length).toBeGreaterThan(15);
    expect(quarterly[0]?.key).toBe('2021-Q4');
    expect(quarterly.every((shard) => /^\d{4}-Q[1-4]$/.test(shard.key))).toBe(true);
  });

  it('区间倒置 → 显式错误（不静默）', () => {
    expect(() => planScanShards({ from: TO, to: FROM })).toThrowError(/RANGE_INVERTED/);
  });
});

describe('PHASE 4 · RecoveryWindowResolver', () => {
  it('数据源只看得到部分历史 → SOURCE_HISTORY_LIMITED + PARTIAL，不伪称 FULL', () => {
    const result = resolveRecoveryWindow({
      domain: 'CUSTOMS',
      requestedFrom: FROM,
      requestedTo: TO,
      jurisdiction: 'US',
      sourceCoverageFrom: '2025-01-08',
      sourceCoverageTo: TO,
      policyWindow: null,
    });
    expect(result.requestedFrom).toBe(FROM);
    expect(result.effectiveFrom).toBe('2025-01-08');
    expect(result.coverage).toBe('SOURCE_LIMITED');
    expect(result.reasonCodes).toContain('SOURCE_HISTORY_LIMITED');
    expect(result.reasonCodes).toContain('PARTIAL_COVERAGE');
    // 无政策 → 不得放行 CLAIM_READY
    expect(result.blocksClaimReady).toBe(true);
    expect(result.reasonCodes).toContain('RULE_UNVERIFIED');
  });

  it('数据源完整覆盖请求区间 → FULL_COVERAGE', () => {
    const result = resolveRecoveryWindow({
      domain: 'PLATFORM',
      requestedFrom: FROM,
      requestedTo: TO,
      sourceCoverageFrom: '2020-01-01',
      sourceCoverageTo: '2026-12-31',
    });
    expect(result.coverage).toBe('FULL');
    expect(result.reasonCodes).toContain('FULL_COVERAGE');
  });

  it('Customs：缺 jurisdiction → MISSING_JURISDICTION 且阻断', () => {
    const result = resolveRecoveryWindow({
      domain: 'CUSTOMS',
      requestedFrom: FROM,
      requestedTo: TO,
      jurisdiction: null,
      sourceCoverageFrom: FROM,
      sourceCoverageTo: TO,
    });
    expect(result.reasonCodes).toContain('MISSING_JURISDICTION');
    expect(result.blocksClaimReady).toBe(true);
  });

  it('Customs：未 LEGAL_VERIFIED 政策 → RULE_UNVERIFIED 且阻断（不得 CLAIM_READY）', () => {
    const result = resolveRecoveryWindow({
      domain: 'CUSTOMS',
      requestedFrom: FROM,
      requestedTo: TO,
      jurisdiction: 'US',
      sourceCoverageFrom: FROM,
      sourceCoverageTo: TO,
      policyWindow: {
        anchorField: 'exportDate',
        daysFromAnchor: 1825,
        verified: false,
        anchorDate: '2022-05-01',
      },
    });
    expect(result.reasonCodes).toContain('RULE_UNVERIFIED');
    expect(result.blocksClaimReady).toBe(true);
  });

  it('Customs：缺 anchor → MISSING_ANCHOR 且阻断', () => {
    const result = resolveRecoveryWindow({
      domain: 'CUSTOMS',
      requestedFrom: FROM,
      requestedTo: TO,
      jurisdiction: 'US',
      sourceCoverageFrom: FROM,
      sourceCoverageTo: TO,
      policyWindow: { anchorField: 'exportDate', daysFromAnchor: 1825, verified: true, anchorDate: null },
    });
    expect(result.reasonCodes).toContain('MISSING_ANCHOR');
    expect(result.blocksClaimReady).toBe(true);
  });

  it('Customs：已核验政策窗口更窄 → POLICY_WINDOW_SHORTER 且 effective 收缩（requested 不变）', () => {
    const result = resolveRecoveryWindow({
      domain: 'CUSTOMS',
      requestedFrom: FROM,
      requestedTo: TO,
      jurisdiction: 'US',
      sourceCoverageFrom: FROM,
      sourceCoverageTo: TO,
      policyWindow: {
        anchorField: 'exportDate',
        daysFromAnchor: 365,
        verified: true,
        anchorDate: '2026-01-01',
      },
    });
    expect(result.requestedFrom).toBe(FROM);
    expect(result.effectiveFrom).toBe('2026-01-01');
    expect(result.effectiveTo).toBe('2026-10-08');
    expect(result.reasonCodes).toContain('POLICY_WINDOW_SHORTER');
    expect(result.blocksClaimReady).toBe(false);
  });
});
