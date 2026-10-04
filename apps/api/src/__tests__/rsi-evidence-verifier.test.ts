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
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.claimedAtCorrelation).toContain('NOT_YET');
    expect(RSI_EVIDENCE_VERIFIER_BOUNDARY.performsExternalWrite).toBe(false);
  });
});
