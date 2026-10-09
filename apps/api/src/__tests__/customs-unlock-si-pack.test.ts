// V2-07 — CUSTOMS UNLOCK domain pack 回归
// ---------------------------------------------------------------------------
// 覆盖：不消费 task:recovery: 保留命名空间 / 缺租户绑定即 BLOCK / 事实读取异常或缺失即 BLOCK /
//   链路 HOLD 时 BLOCK 并回传状态与原因码 / 全门禁通过才 PASS 且仍不自报外写 / 边界自证。

import { describe, expect, it } from 'vitest';

import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';
import type { CustomsExecutionFacts } from '../services/customs/customs-execution-chain';
import {
  CUSTOMS_UNLOCK_GUARD_ACTION,
  CUSTOMS_UNLOCK_PACK_ID,
  CUSTOMS_UNLOCK_SI_PACK_BOUNDARY,
  createCustomsUnlockSiPack,
} from '../runtime/customs-unlock-si-pack';

function task(overrides: Partial<RsiSafeTask> = {}): RsiSafeTask {
  const base: RsiSafeTask = {
    id: 'task-1',
    priority: 'NORMAL' as RsiSafeTask['priority'],
    dedupeKey: 'task:customs-unlock:opp-1',
    organizationId: 'org-1',
  };
  return { ...base, ...overrides };
}

function facts(overrides: Partial<CustomsExecutionFacts> = {}): CustomsExecutionFacts {
  return {
    organizationId: 'org-1',
    opportunity: { caseFound: true, ownerOrganizationId: 'org-1' },
    customerDecision: { started: true },
    payment: { verifiedPaid: true, entitlementActive: true, quotaRemaining: 1 },
    claim: { taskClaimed: true, recheckedAfterClaim: true },
    authorization: {
      standingAuthorizationValid: true,
      externalWriteAuthorized: true,
      actionGuardApproved: true,
    },
    profitGate: { decision: 'PASS' },
    provider: { available: true, quotedCost: '12.00' },
    evidence: { verified: true },
    settlement: {
      verifiedActualRecovery: true,
      settlementId: 'st-1',
      amount: '10000.00',
      currency: 'USD',
    },
    disputes: { revokedOrRefunded: false },
    killSwitch: { engaged: false },
    timeouts: { timedOut: false },
    billedSettlementIds: new Set<string>(),
    ...overrides,
  };
}

describe('V2-07 domain pack — 匹配规则', () => {
  it('不消费 task:recovery: 保留命名空间', () => {
    const pack = createCustomsUnlockSiPack({
      matchesTask: () => true,
      loadFacts: () => facts(),
    });
    expect(pack.matches(task({ dedupeKey: 'task:recovery:abc' }))).toBe(false);
    expect(pack.matches(task())).toBe(true);
  });

  it('pack 身份与域正确', () => {
    const pack = createCustomsUnlockSiPack({ matchesTask: () => true, loadFacts: () => facts() });
    expect(pack.packId).toBe(CUSTOMS_UNLOCK_PACK_ID);
    expect(pack.domain).toBe('CUSTOMS');
  });
});

describe('V2-07 domain pack — fail-closed', () => {
  it('缺可信租户绑定 → BLOCK（不报 PASS）', async () => {
    const pack = createCustomsUnlockSiPack({
      matchesTask: () => true,
      loadFacts: () => facts(),
    });
    const evidence = await pack.run({ task: task({ organizationId: undefined }), packId: CUSTOMS_UNLOCK_PACK_ID });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('TENANT_BINDING_MISSING');
    expect(evidence.externalWritePerformed).toBe(false);
    expect(evidence.modelCallCount).toBe(0);
  });

  it('事实读取抛错 / 返回 null → BLOCK', async () => {
    const throwing = createCustomsUnlockSiPack({
      matchesTask: () => true,
      loadFacts: () => {
        throw new Error('boom');
      },
    });
    const thrown = await throwing.run({ task: task(), packId: CUSTOMS_UNLOCK_PACK_ID });
    expect(thrown.status).toBe('BLOCK');
    expect(thrown.reasonCodes).toContain('FACTS_LOAD_FAILED');

    const empty = createCustomsUnlockSiPack({ matchesTask: () => true, loadFacts: () => null });
    const missing = await empty.run({ task: task(), packId: CUSTOMS_UNLOCK_PACK_ID });
    expect(missing.status).toBe('BLOCK');
    expect(missing.reasonCodes).toContain('FACTS_UNAVAILABLE');
  });

  it('链路 HOLD → BLOCK，回传状态与原因码，guard 决策为 DENY_HOLD', async () => {
    const pack = createCustomsUnlockSiPack({
      matchesTask: () => true,
      loadFacts: () => facts({ customerDecision: { started: false } }),
    });
    const evidence = await pack.run({ task: task(), packId: CUSTOMS_UNLOCK_PACK_ID });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('STATE:WAITING_CUSTOMER_START');
    expect(evidence.reasonCodes).toContain('CUSTOMER_START_REQUIRED');
    expect(evidence.guardActions).toEqual([
      { action: CUSTOMS_UNLOCK_GUARD_ACTION, decision: 'DENY_HOLD' },
    ]);
  });

  it('全门禁通过 → PASS，但仍不自报外写，guard 交由共享地基裁决', async () => {
    const pack = createCustomsUnlockSiPack({ matchesTask: () => true, loadFacts: () => facts() });
    const evidence = await pack.run({ task: task(), packId: CUSTOMS_UNLOCK_PACK_ID });
    expect(evidence.status).toBe('PASS');
    expect(evidence.reasonCodes).toContain('STATE:SUCCESS_FEE_RECEIVABLE');
    expect(evidence.externalWritePerformed).toBe(false);
    expect(evidence.modelCallCount).toBe(0);
    expect(evidence.guardActions).toEqual([
      { action: CUSTOMS_UNLOCK_GUARD_ACTION, decision: 'REQUIRES_SHARED_GUARD_DECISION' },
    ]);
    expect(evidence.evidenceRef.startsWith('customs-chain:task-1:')).toBe(true);
  });
});

describe('V2-07 domain pack — 边界自证', () => {
  it('CUSTOMS_UNLOCK_SI_PACK_BOUNDARY 不创建运行时 / 不自动收款', () => {
    expect(CUSTOMS_UNLOCK_SI_PACK_BOUNDARY.createsRuntime).toBe(false);
    expect(CUSTOMS_UNLOCK_SI_PACK_BOUNDARY.createsScheduler).toBe(false);
    expect(CUSTOMS_UNLOCK_SI_PACK_BOUNDARY.consumesReservedRecoveryNamespace).toBe(false);
    expect(CUSTOMS_UNLOCK_SI_PACK_BOUNDARY.externalWritePerformed).toBe(false);
    expect(CUSTOMS_UNLOCK_SI_PACK_BOUNDARY.autoCollection).toBe('HOLD');
    expect(CUSTOMS_UNLOCK_SI_PACK_BOUNDARY.modelCallCount).toBe(0);
  });
});
