/** RSI 证据校验验收（RSI-RT-05）：PASS 必须有真实 CI/测试证据。 */

import { describe, expect, it } from 'vitest';

import { RSI_EVIDENCE_VERIFIER_BOUNDARY, verifyRunnerEvidence } from '../runtime/rsi-evidence-verifier';

const CI_OK = [{ runId: '1', head: 'abcdef1234567', status: 'completed', conclusion: 'success' }];
const CI_FAIL = [{ runId: '1', head: 'abcdef1234567', status: 'completed', conclusion: 'failure' }];
const TEST_OK = [{ suite: 'rsi', status: 'pass' }];

describe('RSI 证据校验（PASS 需真实证据）', () => {
  it('MISSING_TOKEN：空 / 占位 token 一律拒绝', () => {
    expect(verifyRunnerEvidence(undefined, { ciResults: CI_OK, testResults: [] }).reason).toBe('EVIDENCE_MISSING_TOKEN');
    expect(verifyRunnerEvidence('unconfigured', { ciResults: CI_OK, testResults: [] }).reason).toBe('EVIDENCE_MISSING_TOKEN');
    expect(verifyRunnerEvidence('timeout', { ciResults: CI_OK, testResults: [] }).reason).toBe('EVIDENCE_MISSING_TOKEN');
  });

  it('NO_SUCCESSFUL_CI_OR_TEST：没有成功的 CI/测试就不算证据', () => {
    expect(verifyRunnerEvidence('exit-0:deadbeef', { ciResults: CI_FAIL, testResults: [] }).reason).toBe(
      'NO_SUCCESSFUL_CI_OR_TEST',
    );
    expect(verifyRunnerEvidence('exit-0:deadbeef', { ciResults: [], testResults: [] }).reason).toBe(
      'NO_SUCCESSFUL_CI_OR_TEST',
    );
  });

  it('EVIDENCE_OK：有成功 CI 或通过的测试即可', () => {
    expect(verifyRunnerEvidence('exit-0:deadbeef', { ciResults: CI_OK, testResults: [] })).toEqual({
      ok: true,
      reason: 'EVIDENCE_OK',
    });
    expect(verifyRunnerEvidence('exit-0:deadbeef', { ciResults: [], testResults: TEST_OK }).ok).toBe(true);
  });

  it('HEAD_CORRELATION：带 head: 前缀时必须能匹配到成功记录', () => {
    expect(verifyRunnerEvidence('head:abcdef1', { ciResults: CI_OK, testResults: [] }).ok).toBe(true);
    expect(verifyRunnerEvidence('head:9999999', { ciResults: CI_OK, testResults: [] }).reason).toBe('HEAD_NOT_EVIDENCED');
  });

  it('BOUNDARY：PASS 需真实证据；已知缺口（陈旧证据）如实标注', () => {
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.passRequiresRealEvidence).toBe(true);
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.noEvidenceTokensRejected).toBe(true);
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.claimedAtCorrelation).toContain('SUPPORTED');
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.requireFreshnessDefault).toBe(false);
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.performsExternalWrite).toBe(false);
  });

  it('FRESHNESS_FRESH_PASSES：开启 requireFreshness 时，claim 之后的成功 CI 才算数', () => {
    const claimedAt = Date.parse('2026-10-05T10:00:00.000Z');
    const input = {
      ciResults: [{ runId: '1', head: 'abcdef1', status: 'completed', conclusion: 'success', completedAt: '2026-10-05T10:01:00.000Z' }],
      testResults: [],
    };
    expect(verifyRunnerEvidence('exit-0:abcd', input, { claimedAt, requireFreshness: true }).reason).toBe('EVIDENCE_OK');
  });

  it('FRESHNESS_STALE_IS_REJECTED：claim 之前的旧成功记录不能支撑 PASS', () => {
    const claimedAt = Date.parse('2026-10-05T10:00:00.000Z');
    const input = {
      ciResults: [{ runId: 'old', head: 'abcdef1', status: 'completed', conclusion: 'success', completedAt: '2026-10-05T09:00:00.000Z' }],
      testResults: [],
    };
    expect(verifyRunnerEvidence('exit-0:abcd', input, { claimedAt, requireFreshness: true }).reason).toBe('EVIDENCE_STALE');
  });

  it('FRESHNESS_UNVERIFIABLE：没有 completedAt 时不得假装新鲜', () => {
    const claimedAt = Date.parse('2026-10-05T10:00:00.000Z');
    const input = { ciResults: CI_OK, testResults: [] };
    expect(verifyRunnerEvidence('exit-0:abcd', input, { claimedAt, requireFreshness: true }).reason).toBe('FRESHNESS_UNVERIFIABLE');
    expect(verifyRunnerEvidence('exit-0:abcd', input, { requireFreshness: true }).reason).toBe('FRESHNESS_UNVERIFIABLE');
  });
});
