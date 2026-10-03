/**
 * Provider Adapter Readiness —— 首个 provider（Amazon SP-API）能力档案与 fail-closed 裁决
 * ---------------------------------------------------------------------------
 * 依据 MSG-20261001-24 NEXT：先做设计与能力取证；任一关键能力无法证明 → READ-ONLY / NEEDS_MANUAL。
 * 本测试同时把「能力档案不可静默放宽」固化为回归：三能力缺任一即不得自动写入。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateAdapterEligibility,
  evaluateTransportGate,
  resetAdapterCapabilityRegistry,
} from '../services/platform-write/adapter-capability';
import {
  AMAZON_SP_API_READ_ONLY_CAPABILITY,
  AMAZON_SP_API_READINESS,
  FIRST_PROVIDER_ID,
  firstProviderWriteDecision,
  registerFirstProviderReadOnlyCapability,
  AMAZON_WRITE_TRANSPORT_PREREQUISITES,
  isAmazonOperationWriteEligible,
} from '../services/platform-write/amazon-sp-api-readiness';

afterEach(() => {
  resetAdapterCapabilityRegistry();
});

describe('Provider Adapter Readiness — 首个 provider 能力档案（Amazon SP-API）', () => {
  it('01 档案完整：10 项、逐项有状态与官方来源，未取证项按 fail-closed 记为该状态', () => {
    expect(AMAZON_SP_API_READINESS).toHaveLength(10);
    expect(AMAZON_SP_API_READINESS.map((item) => item.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const item of AMAZON_SP_API_READINESS) {
      expect(item.item.trim()).not.toBe('');
      expect(item.finding.trim()).not.toBe('');
      expect(item.source).toMatch(/developer-docs\.amazon\.com|本档案/);
      expect(['PROVEN', 'PARTIAL', 'NOT_PROVEN']).toContain(item.status);
    }
    // 关键能力（原生幂等写 / 不确定响应处置 / 自动写入最低矩阵）必须未取证
    const notProven = AMAZON_SP_API_READINESS.filter((item) => item.status === 'NOT_PROVEN').map((item) => item.no);
    expect(notProven).toEqual(expect.arrayContaining([3, 6, 10]));
  });

  it('02 平台级描述符为只读：三能力均 false（不是遗漏，而是取证结论）', () => {
    expect(AMAZON_SP_API_READ_ONLY_CAPABILITY).toMatchObject({
      platform: FIRST_PROVIDER_ID,
      idempotentWrite: false,
      statusQuery: false,
      ambiguousResponseSemantics: false,
    });
  });

  it('03 注册后能力判定 fail-closed：不允许自动写入，原因是缺幂等写', () => {
    registerFirstProviderReadOnlyCapability();
    const eligibility = evaluateAdapterEligibility(FIRST_PROVIDER_ID);
    expect(eligibility.registered).toBe(true);
    expect(eligibility.eligibleForAutomaticWrite).toBe(false);
    expect(eligibility.reason).toBe('IDEMPOTENT_WRITE_MISSING');
  });

  it('04 即使全局 transport gate 打开，首个 provider 也不得自动写入（双重门控）', () => {
    registerFirstProviderReadOnlyCapability();
    const gate = evaluateTransportGate({
      platform: FIRST_PROVIDER_ID,
      authorizationValid: true,
      globalTransportEnabled: true,
    });
    expect(gate.transportAllowed).toBe(false);
    expect(gate.reason).toBe('ADAPTER_NOT_ELIGIBLE');

    const decision = firstProviderWriteDecision(true);
    expect(decision).toMatchObject({
      provider: FIRST_PROVIDER_ID,
      eligibleForAutomaticWrite: false,
      disposition: 'READ_ONLY',
      writeDisposition: 'NEEDS_MANUAL',
      reason: 'IDEMPOTENT_WRITE_MISSING',
      transportAllowed: false,
    });
  });

  it('05 注册幂等：重复注册不抛错、不改变口径', () => {
    registerFirstProviderReadOnlyCapability();
    registerFirstProviderReadOnlyCapability();
    const decision = firstProviderWriteDecision(false);
    expect(decision.transportAllowed).toBe(false);
    expect(decision.reason).toBe('IDEMPOTENT_WRITE_MISSING');
  });

  it('06 未注册时同样 fail-closed（能力未知 → 不允许自动写入）', () => {
    const decision = firstProviderWriteDecision(true);
    expect(decision.reason).toBe('ADAPTER_NOT_REGISTERED');
    expect(decision.transportAllowed).toBe(false);
    expect(decision.disposition).toBe('READ_ONLY');
  });
  it('07 六项写回前置冻结为代码门槛：缺任一项即 NEEDS_MANUAL（CHANGE C）', () => {
    expect(AMAZON_WRITE_TRANSPORT_PREREQUISITES).toHaveLength(6);
    const partial = isAmazonOperationWriteEligible("createReport", {
      WRITE_ENDPOINT_AND_AUTHORIZATION: true,
      IDEMPOTENCY_OR_REPLAY_SEMANTICS: true,
    });
    expect(partial.eligible).toBe(false);
    expect(partial.disposition).toBe("NEEDS_MANUAL");
    expect(partial.missing).toEqual([
      "OPERATION_OR_REQUEST_IDENTIFIER",
      "POST_WRITE_STATUS_CONFIRMATION",
      "AMBIGUOUS_RESPONSE_RECOVERY",
      "SANDBOX_EVIDENCE_AND_BASELINE",
    ]);

    const complete = isAmazonOperationWriteEligible(
      "createReport",
      Object.fromEntries(AMAZON_WRITE_TRANSPORT_PREREQUISITES.map((item) => [item, true])),
    );
    expect(complete.eligible).toBe(true);
    expect(complete.missing).toEqual([]);
  });
});
