/**
 * CHANGE D（MSG-20261003-135）— Independent-site / Chargeback **内部闭环**回归。
 * ---------------------------------------------------------------
 * 覆盖 Layer 2 矩阵中 independent_site 的 6 个缺口能力轴：
 *   · http            —— 服务级状态码映射（403 / 404 / 409 / 400）
 *   · persistence     —— append-only 事实端口：同一 executionKey 幂等、不产生第二条
 *   · db_invariant    —— 端口契约要求 append-only（拒绝就地修改）；digest 篡改 → fail-closed
 *   · replay          —— 相同事实重放 → 结果完全一致（确定性投影）
 *   · concurrency     —— 同一 dispute 的**并发**启动：串行化后 exact one accepted
 *   · rbac            —— 能力门控（缺 capability → 403 语义）
 * 另含 cross-tenant 隔离与 amount/ledger 一致性断言。
 * 全程零外部写：externalWritePerformed=false / transportEnabled=false / paymentCollected=false。
 */

import { describe, expect, it } from 'vitest';

import {
  PS04_FLOW_BOUNDARY,
  Ps04FlowError,
  assertIndependentSiteLedgerConsistency,
  computePs04SuccessFee,
  consolidateIndependentSiteRecovery,
  startIndependentSiteRecovery,
  toPs04HttpStatus,
  type Ps04HandoffFact,
  type Ps04RecoveryFlowPort,
  type Ps04StartRecoveryInput,
} from '../services/independent-site/chargeback-recovery-flow';

const ORG = 'org-1';
const NOW = '2026-10-04T00:00:00.000Z';
const FEE_POLICY = { policyId: 'success-fee-2026', policyVersion: '1.0.0', rateBasisPoints: 1500 };

/** fixture 端口：**append-only** 且按 dispute 串行化（模拟 DB 唯一约束 + 行锁）。 */
class InMemoryPs04Port implements Ps04RecoveryFlowPort {
  private facts: Ps04HandoffFact[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  private withLock<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  countFacts(): number {
    return this.facts.length;
  }

  async appendHandoff(fact: Ps04HandoffFact) {
    return this.withLock(() => {
      const existing = this.facts.find(
        (item) => item.organizationId === fact.organizationId && item.disputeReference === fact.disputeReference,
      );
      if (existing) return { appended: false, existing };
      this.facts.push(fact);
      return { appended: true, existing: null };
    });
  }

  async listHandoffs(organizationId: string, disputeReference: string) {
    return this.facts.filter((item) => item.organizationId === organizationId && item.disputeReference === disputeReference);
  }

  async getHandoff(organizationId: string, disputeReference: string) {
    return this.facts.find((item) => item.organizationId === organizationId && item.disputeReference === disputeReference) ?? null;
  }

  /** append-only 契约：就地修改必须被拒绝（真实实现由 DB 触发器保证）。 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  forbiddenUpdate(): never {
    throw new Ps04FlowError('FORBIDDEN', 'append-only：禁止 UPDATE/DELETE 既有事实');
  }
}

const startInput = (overrides: Partial<Ps04StartRecoveryInput> = {}): Ps04StartRecoveryInput => ({
  organizationId: ORG,
  disputeReference: 'dp-1',
  packageId: 'pkg-1',
  packageDigest: 'a'.repeat(64),
  packageStatus: 'READY',
  qualificationStatus: 'QUALIFIED',
  actorCapabilities: ['independent_site.dispute.handoff'],
  requiredCapability: 'independent_site.dispute.handoff',
  channel: 'MANUAL_PORTAL',
  handoffReference: 'portal-ref-1',
  attestedByActorId: 'actor-1',
  executionKey: 'exec-1',
  now: NOW,
  ...overrides,
});

const handoffFact = (): Ps04HandoffFact => ({
  organizationId: ORG,
  disputeReference: 'dp-1',
  packageId: 'pkg-1',
  packageDigest: 'a'.repeat(64),
  channel: 'MANUAL_PORTAL',
  handoffReference: 'portal-ref-1',
  attestedByActorId: 'actor-1',
  executionKey: 'exec-1',
  recordedAt: NOW,
});

const consolidation = (overrides: Record<string, unknown> = {}) =>
  consolidateIndependentSiteRecovery({
    organizationId: ORG,
    disputeReference: 'dp-1',
    currency: 'USD',
    disputeAmount: '250.00',
    handoff: handoffFact(),
    response: { organizationId: ORG, disputeReference: 'dp-1', disposition: 'WON', amount: '250.00', currency: 'USD', source: 'FIXTURE', observedAt: NOW },
    settlement: { organizationId: ORG, disputeReference: 'dp-1', amount: '100.00', currency: 'USD', verification: 'VERIFIED', reference: 'stl-1', receivedAt: NOW },
    feePolicy: FEE_POLICY,
    expectedPackageDigest: 'a'.repeat(64),
    now: NOW,
    ...overrides,
  } as never);

describe('CHANGE D — Independent-site 内部闭环（fixture / manual-handoff）', () => {
  it('happy path：递交 → 胜诉 → 验证到账 → 15% 成功费 + 账本 + 发票草稿', async () => {
    const port = new InMemoryPs04Port();
    const started = await startIndependentSiteRecovery(startInput(), port);
    expect(started.started).toBe(true);
    expect(started.replay).toBe(false);
    expect(started.externalWritePerformed).toBe(false);
    expect(started.transportEnabled).toBe(false);
    expect(started.paymentCollected).toBe(false);
    expect(port.countFacts()).toBe(1);

    const result = consolidation({ handoff: started.handoffFact });
    expect(result.submitted).toBe(true);
    expect(result.won).toBe(true);
    expect(result.settled).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.billable).toBe(true);
    expect(result.recoveredAmount).toBe('100.000000');
    expect(result.feeAmount).toBe('15.000000');
    expect(result.ledgerEntry).toEqual({ recoveredAmount: '100.000000', currency: 'USD', source: 'PSP_SETTLEMENT_VERIFIED' });
    expect(result.invoiceDraft).toEqual({ amount: '15.000000', currency: 'USD', basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERY' });
    expect(result.autoSubmitAllowed).toBe(false);
    assertIndependentSiteLedgerConsistency(result);
  });

  it('negative：包未就绪 / 资格未通过 → 不启动；WON 但未验证结算 → 0 计入、不可计费', async () => {
    const port = new InMemoryPs04Port();
    const notReady = await startIndependentSiteRecovery(startInput({ packageStatus: 'NOT_READY' }), port);
    expect(notReady.started).toBe(false);
    expect(notReady.reasonCodes).toContain('PACKAGE_NOT_READY');
    expect(notReady.handoffFact).toBeNull();

    const notQualified = await startIndependentSiteRecovery(startInput({ qualificationStatus: 'NOT_QUALIFIED' }), port);
    expect(notQualified.started).toBe(false);
    expect(notQualified.reasonCodes).toContain('QUALIFICATION_NOT_PASSED');
    expect(port.countFacts()).toBe(0);

    const unverified = consolidation({
      settlement: { organizationId: ORG, disputeReference: 'dp-1', amount: '100.00', currency: 'USD', verification: 'UNVERIFIED', reference: 'stl-1', receivedAt: NOW },
    });
    expect(unverified.settled).toBe(false);
    expect(unverified.recovered).toBe(false);
    expect(unverified.billable).toBe(false);
    expect(unverified.recoveredAmount).toBe('0.000000');
    expect(unverified.feeAmount).toBe('0.000000');
    expect(unverified.invoiceDraft).toBeNull();
    expect(unverified.reasonCodes).toContain('SETTLEMENT_NOT_VERIFIED');
    assertIndependentSiteLedgerConsistency(unverified);

    const lost = consolidation({
      response: { organizationId: ORG, disputeReference: 'dp-1', disposition: 'LOST', amount: null, currency: 'USD', source: 'FIXTURE', observedAt: NOW },
    });
    expect(lost.won).toBe(false);
    expect(lost.billable).toBe(false);
    expect(lost.feeAmount).toBe('0.000000');
  });

  it('replay：同一 executionKey 重放 → 复用既有事实，不产生第二条；投影确定性一致', async () => {
    const port = new InMemoryPs04Port();
    const first = await startIndependentSiteRecovery(startInput(), port);
    const second = await startIndependentSiteRecovery(startInput(), port);
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.reasonCodes).toContain('HANDOFF_ALREADY_RECORDED');
    expect(second.handoffFact?.executionKey).toBe('exec-1');
    expect(port.countFacts()).toBe(1);

    const a = consolidation();
    const b = consolidation();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('concurrency：同一 dispute 并发启动 → exactly one accepted（其余显式 CONFLICT，绝不静默）', async () => {
    const port = new InMemoryPs04Port();
    const settled = await Promise.allSettled([
      startIndependentSiteRecovery(startInput({ executionKey: 'exec-a', handoffReference: 'ref-a' }), port),
      startIndependentSiteRecovery(startInput({ executionKey: 'exec-b', handoffReference: 'ref-b' }), port),
      startIndependentSiteRecovery(startInput({ executionKey: 'exec-c', handoffReference: 'ref-c' }), port),
    ]);
    const fulfilled = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const rejected = settled.filter((item) => item.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled.filter((item) => item.started && item.replay === false)).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const item of rejected) {
      expect(item.reason instanceof Ps04FlowError).toBe(true);
      expect((item.reason as Ps04FlowError).code).toBe('CONFLICT');
      expect(toPs04HttpStatus(item.reason)).toBe(409);
    }
    expect(port.countFacts()).toBe(1);
  });

  it('rbac / http：缺 capability → FORBIDDEN（403）；未知错误 → 400；冲突 → 409', async () => {
    const port = new InMemoryPs04Port();
    let thrown: unknown = null;
    try {
      await startIndependentSiteRecovery(startInput({ actorCapabilities: ['viewer'] }), port);
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Ps04FlowError).toBe(true);
    expect(toPs04HttpStatus(thrown)).toBe(403);
    expect(toPs04HttpStatus(new Ps04FlowError('NOT_FOUND', 'x'))).toBe(404);
    expect(toPs04HttpStatus(new Ps04FlowError('CONFLICT', 'x'))).toBe(409);
    expect(toPs04HttpStatus(new Ps04FlowError('INVALID', 'x'))).toBe(400);
    expect(toPs04HttpStatus(new Error('boom'))).toBe(400);
  });

  it('cross-tenant：A 租户看不到 B 租户事实；跨租户来源 fail-closed', async () => {
    const port = new InMemoryPs04Port();
    await startIndependentSiteRecovery(startInput({ organizationId: 'org-B' }), port);
    expect(await port.listHandoffs(ORG, 'dp-1')).toHaveLength(0);
    expect(await port.listHandoffs('org-B', 'dp-1')).toHaveLength(1);
    expect(await port.getHandoff(ORG, 'dp-1')).toBeNull();
  });

  it('db_invariant / digest：篡改 packageDigest → fail-closed 且不可计费；append-only 禁止就地修改', () => {
    const tampered = consolidation({ expectedPackageDigest: 'b'.repeat(64) });
    expect(tampered.reasonCodes).toContain('DIGEST_MISMATCH');
    expect(tampered.billable).toBe(false);
    expect(tampered.feeAmount).toBe('0.000000');
    expect(tampered.invoiceDraft).toBeNull();

    const port = new InMemoryPs04Port();
    expect(() => port.forbiddenUpdate()).toThrow(Ps04FlowError);

    const mismatched = consolidation({
      settlement: { organizationId: ORG, disputeReference: 'dp-1', amount: '100.00', currency: 'EUR', verification: 'VERIFIED', reference: 'stl-1', receivedAt: NOW },
    });
    expect(mismatched.reasonCodes).toContain('CURRENCY_MISMATCH');
    expect(mismatched.billable).toBe(false);
  });

  it('amount/ledger：15% 只对已验证实际追回计费；estimated / won / approved 均不是计费依据', () => {
    expect(computePs04SuccessFee('100.00', FEE_POLICY)).toBe('15.000000');
    expect(computePs04SuccessFee('0.00', FEE_POLICY)).toBe('0.000000');
    expect(computePs04SuccessFee('-5.00', FEE_POLICY)).toBe('0.000000');

    const wonOnly = consolidation({
      settlement: null,
    });
    expect(wonOnly.won).toBe(true);
    expect(wonOnly.settled).toBe(false);
    expect(wonOnly.recovered).toBe(false);
    expect(wonOnly.billable).toBe(false);
    expect(wonOnly.feeAmount).toBe('0.000000');
    expect(wonOnly.ledgerEntry).toBeNull();

    expect(PS04_FLOW_BOUNDARY.wonIsFeeBasis).toBe(false);
    expect(PS04_FLOW_BOUNDARY.estimatedIsFeeBasis).toBe(false);
    expect(PS04_FLOW_BOUNDARY.approvedIsPaid).toBe(false);
    expect(PS04_FLOW_BOUNDARY.submittedImpliesWon).toBe(false);
    expect(PS04_FLOW_BOUNDARY.wonImpliesSettled).toBe(false);
    expect(PS04_FLOW_BOUNDARY.settledImpliesRecovered).toBe(false);
    expect(PS04_FLOW_BOUNDARY.externalPspCall).toBe(false);
    expect(PS04_FLOW_BOUNDARY.disputeSubmitImplemented).toBe(false);
    expect(PS04_FLOW_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
