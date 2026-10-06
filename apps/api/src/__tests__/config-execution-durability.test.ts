// P6-PROD-U1 耐久执行底座 —— 纯决策层回归（无数据库）
// 覆盖：状态机守卫 / reservation 去重与幂等冲突 / lease 与 takeover / crash recovery 分类 /
//       startup reconciliation 幂等 / 终态结果语义 / outbox 与消费者幂等 / 只读 current-config 适配器边界

import { describe, expect, it } from 'vitest';

import * as durability from '../services/config-execution-durability';
import {
  CONFIG_EXECUTION_RESULT_CODE_STATUS,
  CONFIG_EXECUTION_RESULT_SEMANTICS,
  ConfigExecutionDurabilityError,
  assertConfigExecutionEnvironment,
  assertConfigExecutionTransition,
  canTransitionConfigExecution,
  compareToAuthorizedBaseline,
  createReadOnlyCurrentConfigAdapter,
  classifyStrandedExecution,
  decideOutboxDelivery,
  decideReservation,
  buildTerminalOutboxEvent,
  buildTerminalResult,
  computeConfigFingerprint,
  detectConfigDrift,
  planLeaseClaim,
  planReservation,
  planStartupReconciliation,
  type ConfigExecutionBasis,
  type ReconciliationAction,
  type ReservationView,
} from '../services/config-execution-durability';

const NOW = new Date('2026-10-06T03:00:00.000Z');

function basis(overrides: Partial<ConfigExecutionBasis> = {}): ConfigExecutionBasis {
  return {
    authorizationVerdictDigest: 'v'.repeat(64),
    authorizationTicketDigest: 't'.repeat(64),
    planDigest: 'p'.repeat(64),
    candidateDigest: 'c'.repeat(64),
    proposalDigest: 'r'.repeat(64),
    controlledAdoptionDigest: 'a'.repeat(64),
    rollbackPlanDigest: 'b'.repeat(64),
    baselineSnapshotDigest: 's'.repeat(64),
    baselineConfigFingerprint: 'f'.repeat(64),
    environment: 'SANDBOX',
    executionMode: 'SANDBOX_WRITE_ONLY',
    target: 'sandbox-config',
    configPath: 'outcomeLearning.autoAdoptThreshold',
    fromValue: '0.80',
    toValue: '0.85',
    ...overrides,
  };
}

function reservation(overrides: Partial<ReservationView> = {}): ReservationView {
  return {
    id: 'res-1',
    reservationKey: 'k1',
    immutableBasisDigest: 'digest-1',
    idempotencyKey: 'idem-1',
    idempotencyPayloadDigest: 'payload-1',
    authorizationVerdictDigest: 'v'.repeat(64),
    authorizationTicketDigest: 't'.repeat(64),
    status: 'RESERVED',
    executionAttempt: 0,
    ownerRef: null,
    leaseId: null,
    leaseAcquiredAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null,
    reservationExpiresAt: new Date(NOW.getTime() + 600_000),
    ...overrides,
  };
}

const expectation = {
  baselineConfigFingerprint: 'f'.repeat(64),
  preConfigVersion: 'cfg-1',
  fromValue: '0.80',
  toValue: '0.85',
};

describe('P6-PROD-U1 状态机与边界', () => {
  it('合法迁移通过；非法迁移 / terminal 再迁移 fail-closed', () => {
    expect(canTransitionConfigExecution('RESERVED', 'EXECUTING')).toBe(true);
    expect(canTransitionConfigExecution('EXECUTING', 'SUCCEEDED')).toBe(true);
    expect(canTransitionConfigExecution('RESERVED', 'SUCCEEDED')).toBe(false);
    expect(canTransitionConfigExecution('SUCCEEDED', 'EXECUTING')).toBe(false);

    expect(() => assertConfigExecutionTransition('RESERVED', 'SUCCEEDED')).toThrow(
      ConfigExecutionDurabilityError,
    );
    expect(() => assertConfigExecutionTransition('SUCCEEDED', 'EXECUTING')).toThrow(
      /terminal/,
    );
  });

  it('NO PRODUCTION ENABLEMENT：非 SANDBOX 环境一律 fail-closed', () => {
    expect(assertConfigExecutionEnvironment('SANDBOX')).toBe('SANDBOX');
    expect(() => assertConfigExecutionEnvironment('PRODUCTION')).toThrow(
      /NO PRODUCTION ENABLEMENT/,
    );
    expect(durability.CONFIG_EXECUTION_DURABILITY_BOUNDARY.productionMutation).toBe(
      'NOT_AUTHORIZED',
    );
    expect(durability.CONFIG_EXECUTION_DURABILITY_BOUNDARY.boundaries.PRODUCTION_CONFIG_MUTATION).toBe(
      false,
    );
  });
});

describe('P6-PROD-U1 reservation / dedupe', () => {
  it('reservation 身份确定：同输入 → 同 reservationKey / immutableBasisDigest / payloadDigest', () => {
    const a = planReservation({ basis: basis(), idempotencyKey: 'idem-1', now: NOW });
    const b = planReservation({ basis: basis(), idempotencyKey: 'idem-1', now: NOW });
    expect(a.reservationKey).toBe(b.reservationKey);
    expect(a.immutableBasisDigest).toBe(b.immutableBasisDigest);
    expect(a.idempotencyPayloadDigest).toBe(b.idempotencyPayloadDigest);
    expect(a.status).toBe('RESERVED');
    expect(a.reservationExpiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('依据变化 → reservationKey / payloadDigest 变化', () => {
    const a = planReservation({ basis: basis(), idempotencyKey: 'idem-1', now: NOW });
    const b = planReservation({
      basis: basis({ toValue: '0.90' }),
      idempotencyKey: 'idem-1',
      now: NOW,
    });
    expect(a.reservationKey).not.toBe(b.reservationKey);
    expect(a.idempotencyPayloadDigest).not.toBe(b.idempotencyPayloadDigest);
  });

  it('缺 idempotencyKey / 非 sandbox 环境 / 非 sandbox 模式 → 拒绝', () => {
    expect(() => planReservation({ basis: basis(), idempotencyKey: '   ', now: NOW })).toThrow(
      /idempotencyKey/,
    );
    expect(() =>
      planReservation({ basis: basis({ environment: 'PRODUCTION' }), idempotencyKey: 'i', now: NOW }),
    ).toThrow(/NO PRODUCTION ENABLEMENT/);
    expect(() =>
      planReservation({
        basis: basis({ executionMode: 'PRODUCTION_APPLY' }),
        idempotencyKey: 'i',
        now: NOW,
      }),
    ).toThrow(/SANDBOX_WRITE_ONLY/);
  });

  it('重复 reservation：同依据复用；同幂等键异载荷 / 同授权异依据 → FAIL CLOSED', () => {
    const plan = planReservation({ basis: basis(), idempotencyKey: 'idem-1', now: NOW });

    expect(decideReservation(null, plan)).toEqual({ kind: 'CREATE', plan });

    const reuse = decideReservation(
      reservation({ immutableBasisDigest: plan.immutableBasisDigest, status: 'EXECUTING' }),
      plan,
    );
    expect(reuse).toEqual({ kind: 'REUSE', reservationId: 'res-1', status: 'EXECUTING' });

    const conflict = decideReservation(
      reservation({ immutableBasisDigest: 'other', idempotencyKey: plan.idempotencyKey }),
      plan,
    );
    expect(conflict.kind).toBe('FAIL_CLOSED');
    if (conflict.kind === 'FAIL_CLOSED') {
      expect(conflict.code).toBe('CONFIG_EXECUTION_IDEMPOTENCY_KEY_CONFLICT');
    }

    const otherBasis = decideReservation(
      reservation({ immutableBasisDigest: 'other', idempotencyKey: 'idem-other' }),
      plan,
    );
    expect(otherBasis.kind).toBe('FAIL_CLOSED');
    if (otherBasis.kind === 'FAIL_CLOSED') {
      expect(otherBasis.code).toBe('CONFIG_EXECUTION_RESERVATION_PAYLOAD_CONFLICT');
    }
  });
});

describe('P6-PROD-U1 lease / ownership', () => {
  it('RESERVED → ACQUIRE（attempt 递增，lease 身份确定）', () => {
    const decision = planLeaseClaim({ reservation: reservation(), ownerRef: 'worker-A', now: NOW });
    expect(decision.kind).toBe('ACQUIRE');
    if (decision.kind === 'ACQUIRE') {
      expect(decision.toStatus).toBe('EXECUTING');
      expect(decision.executionAttempt).toBe(1);
      expect(decision.leaseId).toHaveLength(64);
      expect(decision.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('有效 lease 不得被抢：另一 owner → LEASE_HELD；同 owner → RENEW', () => {
    const held = reservation({
      status: 'EXECUTING',
      ownerRef: 'worker-A',
      leaseId: 'lease-A',
      leaseAcquiredAt: NOW,
      leaseRenewedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      executionAttempt: 1,
    });
    expect(planLeaseClaim({ reservation: held, ownerRef: 'worker-B', now: NOW }).kind).toBe(
      'LEASE_HELD',
    );
    const renew = planLeaseClaim({ reservation: held, ownerRef: 'worker-A', now: NOW });
    expect(renew.kind).toBe('RENEW');
  });

  it('过期 lease → 确定性 TAKEOVER（新 lease 身份 + attempt 递增 + 原因）', () => {
    const stale = reservation({
      status: 'EXECUTING',
      ownerRef: 'worker-A',
      leaseId: 'lease-A',
      leaseAcquiredAt: new Date(NOW.getTime() - 300_000),
      leaseRenewedAt: new Date(NOW.getTime() - 300_000),
      leaseExpiresAt: new Date(NOW.getTime() - 1_000),
      executionAttempt: 1,
    });
    const takeover = planLeaseClaim({ reservation: stale, ownerRef: 'worker-B', now: NOW });
    expect(takeover.kind).toBe('TAKEOVER');
    if (takeover.kind === 'TAKEOVER') {
      expect(takeover.previousOwnerRef).toBe('worker-A');
      expect(takeover.reason).toBe('LEASE_EXPIRED');
      expect(takeover.leaseId).not.toBe('lease-A');
      expect(takeover.executionAttempt).toBe(2);
    }
    // lease 字段缺失（orphan EXECUTING）同样走 takeover，但原因可区分
    const orphan = planLeaseClaim({
      reservation: reservation({ status: 'EXECUTING', executionAttempt: 1 }),
      ownerRef: 'worker-C',
      now: NOW,
    });
    expect(orphan.kind).toBe('TAKEOVER');
    if (orphan.kind === 'TAKEOVER') expect(orphan.reason).toBe('LEASE_MISSING');
  });

  it('reservation 窗口过期 → 不得再开始执行；terminal → 不再迁移', () => {
    const expired = planLeaseClaim({
      reservation: reservation({ reservationExpiresAt: new Date(NOW.getTime() - 1) }),
      ownerRef: 'worker-A',
      now: NOW,
    });
    expect(expired.kind).toBe('RESERVATION_EXPIRED');

    const terminal = planLeaseClaim({
      reservation: reservation({ status: 'SUCCEEDED' }),
      ownerRef: 'worker-A',
      now: NOW,
    });
    expect(terminal.kind).toBe('TERMINAL_NOOP');
  });
});

describe('P6-PROD-U1 crash recovery 分类（禁止 blind retry）', () => {
  const expiredLease = {
    ownerRef: 'worker-A',
    leaseId: 'lease-A',
    acquiredAt: new Date(NOW.getTime() - 300_000),
    renewedAt: new Date(NOW.getTime() - 300_000),
    expiresAt: new Date(NOW.getTime() - 1_000),
  };

  const classify = (observation: { configFingerprint: string; version: string; pathValue: string } | null) =>
    classifyStrandedExecution({
      status: 'EXECUTING',
      lease: expiredLease,
      reservationExpiresAt: new Date(NOW.getTime() + 300_000),
      now: NOW,
      observation,
      expected: expectation,
    });

  it('有效 lease 未过期 / 已是终态 → NOOP', () => {
    const active = classifyStrandedExecution({
      status: 'EXECUTING',
      lease: { ...expiredLease, expiresAt: new Date(NOW.getTime() + 30_000) },
      reservationExpiresAt: new Date(NOW.getTime() + 300_000),
      now: NOW,
      observation: null,
      expected: expectation,
    });
    expect(active.kind).toBe('NOOP');
    const terminal = classifyStrandedExecution({
      status: 'SUCCEEDED',
      lease: expiredLease,
      reservationExpiresAt: new Date(NOW.getTime() + 300_000),
      now: NOW,
      observation: null,
      expected: expectation,
    });
    expect(terminal.kind).toBe('NOOP');
  });

  it('观测不到 → NEEDS_RECONCILIATION（unknown outcome，绝不重放 CAS）', () => {
    const decision = classify(null);
    expect(decision.kind).toBe('NEEDS_RECONCILIATION');
    if (decision.kind === 'NEEDS_RECONCILIATION') {
      expect(decision.reason).toBe('OBSERVATION_UNAVAILABLE');
      expect(decision.post).toBeNull();
    }
  });

  it('目标值已生效且 version 前进 → RECOVERED_COMMITTED（有证据的恢复）', () => {
    const decision = classify({
      configFingerprint: 'post'.padEnd(64, '0'),
      version: 'cfg-2',
      pathValue: '0.85',
    });
    expect(decision.kind).toBe('RECOVERED_COMMITTED');
    if (decision.kind === 'RECOVERED_COMMITTED') expect(decision.post.version).toBe('cfg-2');
  });

  it('仍是 pre 值且 version 未变 → SAFE_TO_RETRY（无副作用证据）', () => {
    const decision = classify({
      configFingerprint: 'f'.repeat(64),
      version: 'cfg-1',
      pathValue: '0.80',
    });
    expect(decision.kind).toBe('SAFE_TO_RETRY');
  });

  it('目标值但 version 未变 / 其它漂移 → NEEDS_RECONCILIATION（证据不足）', () => {
    const ambiguous = classify({
      configFingerprint: 'f'.repeat(64),
      version: 'cfg-1',
      pathValue: '0.85',
    });
    expect(ambiguous.kind).toBe('NEEDS_RECONCILIATION');
    if (ambiguous.kind === 'NEEDS_RECONCILIATION') {
      expect(ambiguous.reason).toBe('TARGET_VALUE_WITHOUT_VERSION_ADVANCE');
    }
    const drift = classify({
      configFingerprint: 'f'.repeat(64),
      version: 'cfg-1',
      pathValue: '0.42',
    });
    expect(drift.kind).toBe('NEEDS_RECONCILIATION');
    if (drift.kind === 'NEEDS_RECONCILIATION') expect(drift.reason).toBe('OBSERVED_DRIFT');
  });

  it('RESERVED 超期 → 取消（零写）；RESERVED 未超期 → 等待 worker', () => {
    const expired = classifyStrandedExecution({
      status: 'RESERVED',
      lease: { ownerRef: null, leaseId: null, acquiredAt: null, renewedAt: null, expiresAt: null },
      reservationExpiresAt: new Date(NOW.getTime() - 1),
      now: NOW,
      observation: null,
      expected: expectation,
    });
    expect(expired.kind).toBe('CANCEL_EXPIRED_RESERVATION');
    const waiting = classifyStrandedExecution({
      status: 'RESERVED',
      lease: { ownerRef: null, leaseId: null, acquiredAt: null, renewedAt: null, expiresAt: null },
      reservationExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
      observation: null,
      expected: expectation,
    });
    expect(waiting.kind).toBe('NOOP');
  });
});

describe('P6-PROD-U1 startup reconciliation（幂等 + 覆盖全部异常态）', () => {
  // 说明：这里的 in-memory 状态**只用于演练对账算法**，不是执行路径；
  // 生产路径必须落到 Prisma durable store（DB 并发/崩溃用例在 -db 测试里证明）。
  type RehearsalRow = { view: ReservationView; terminal: boolean };
  const apply = (rows: Map<string, RehearsalRow>, actions: ReconciliationAction[]): void => {
    for (const action of actions) {
      const row = rows.get(action.reservationId);
      if (!row) continue;
      if (action.kind === 'TERMINALIZE') {
        row.terminal = true;
        row.view = { ...row.view, status: action.status };
      } else if (action.kind === 'CANCEL') {
        row.terminal = true;
        row.view = { ...row.view, status: 'CANCELLED' };
      } else if (action.kind === 'REVIEW') {
        row.terminal = true;
        row.view = { ...row.view, status: 'MANUAL_REVIEW' };
      }
    }
  };

  it('同一输入两次 → 动作完全一致；应用后再次对账 → 只剩 NOOP', () => {
    const rows = new Map<string, RehearsalRow>();
    const put = (view: ReservationView) => rows.set(view.id, { view, terminal: false });
    put(reservation({ id: 'r-expired-reserved', reservationExpiresAt: new Date(NOW.getTime() - 1) }));
    put(
      reservation({
        id: 'r-stranded',
        status: 'EXECUTING',
        ownerRef: 'worker-A',
        leaseId: 'lease-A',
        leaseAcquiredAt: new Date(NOW.getTime() - 300_000),
        leaseRenewedAt: new Date(NOW.getTime() - 300_000),
        leaseExpiresAt: new Date(NOW.getTime() - 1_000),
        executionAttempt: 1,
      }),
    );
    put(
      reservation({
        id: 'r-orphan',
        status: 'EXECUTING',
        ownerRef: null,
        leaseId: null,
        leaseExpiresAt: null,
        executionAttempt: 1,
      }),
    );
    put(reservation({ id: 'r-healthy' }));

    const observations: Record<string, { configFingerprint: string; version: string; pathValue: string }> =
      {
        'r-stranded': { configFingerprint: 'f'.repeat(64), version: 'cfg-1', pathValue: '0.80' },
        'r-orphan': { configFingerprint: 'f'.repeat(64), version: 'cfg-1', pathValue: '0.85' },
      };

    const runPlan = () =>
      planStartupReconciliation({
        reservations: [...rows.values()].map((row) => row.view),
        now: NOW,
        observe: (view) => observations[view.id] ?? null,
        expectedFor: () => expectation,
      });

    const first = runPlan();
    const second = runPlan();
    expect(second).toEqual(first);

    const byId = new Map(first.map((action) => [action.reservationId, action]));
    expect(byId.get('r-expired-reserved')).toMatchObject({ kind: 'CANCEL' });
    expect(byId.get('r-stranded')).toMatchObject({
      kind: 'RECLAIM',
      reason: 'SAFE_TO_RETRY',
    });
    expect(byId.get('r-orphan')).toMatchObject({
      kind: 'TERMINALIZE',
      status: 'NEEDS_RECONCILIATION',
    });
    expect(byId.get('r-healthy')).toMatchObject({ kind: 'NOOP' });

    apply(rows, first);
    const third = runPlan();
    // 落库后：已收敛的三行变 NOOP；可安全重试的那一行仍只产出 RECLAIM（等待 worker 重新取 lease），
    // 也就是说重复 reconcile 不会产生第二条终态 / 第二条 reservation。
    const thirdById = new Map(third.map((action) => [action.reservationId, action]));
    expect(thirdById.get('r-expired-reserved')).toMatchObject({ kind: 'NOOP' });
    expect(thirdById.get('r-orphan')).toMatchObject({ kind: 'NOOP' });
    expect(thirdById.get('r-healthy')).toMatchObject({ kind: 'NOOP' });
    expect(thirdById.get('r-stranded')).toMatchObject({ kind: 'RECLAIM', reason: 'SAFE_TO_RETRY' });

    // 重复 reconcile 幂等：动作集合稳定（不会新增终态 / 不会重复取消）
    apply(rows, third);
    expect(runPlan()).toEqual(third);
  });

  it('read-back 证明已提交 → 对账直接收敛为 SUCCEEDED / RECOVERED_COMMITTED（不重放 CAS）', () => {
    const stranded = reservation({
      id: 'r-recover',
      status: 'EXECUTING',
      ownerRef: 'worker-A',
      leaseId: 'lease-A',
      leaseAcquiredAt: new Date(NOW.getTime() - 300_000),
      leaseRenewedAt: new Date(NOW.getTime() - 300_000),
      leaseExpiresAt: new Date(NOW.getTime() - 1_000),
      executionAttempt: 1,
    });
    const actions = planStartupReconciliation({
      reservations: [stranded],
      now: NOW,
      observe: () => ({ configFingerprint: 'p'.repeat(64), version: 'cfg-2', pathValue: '0.85' }),
      expectedFor: () => expectation,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'TERMINALIZE',
      status: 'SUCCEEDED',
      resultCode: 'RECOVERED_COMMITTED',
    });
  });
});

describe('P6-PROD-U1 终态结果 / outbox / 消费者幂等', () => {
  const terminalInput = {
    reservationId: 'res-1',
    executionId: 'exec-1',
    preConfigFingerprint: 'f'.repeat(64),
    preConfigVersion: 'cfg-1',
    idempotencyKey: 'idem-1',
    provenanceDigest: 'prov-1',
    recordedAt: NOW,
  };

  it('resultCode → status / semantics 一一对应；失败结果绝不携带 COMMITTED 语义', () => {
    for (const [code, semantics] of Object.entries(CONFIG_EXECUTION_RESULT_SEMANTICS)) {
      const record = buildTerminalResult({
        ...terminalInput,
        resultCode: code as keyof typeof CONFIG_EXECUTION_RESULT_SEMANTICS,
        postConfigFingerprint: code === 'COMMITTED' ? 'p'.repeat(64) : null,
        postConfigVersion: code === 'COMMITTED' ? 'cfg-2' : null,
        evidenceSource: 'EXECUTION',
      });
      expect(record.semantics).toBe(semantics);
      expect(record.status).toBe(CONFIG_EXECUTION_RESULT_CODE_STATUS[record.resultCode]);
      if (record.resultCode !== 'COMMITTED') {
        expect(record.semantics).not.toBe('SANDBOX_CONFIG_MUTATION_COMMITTED');
      }
    }
  });

  it('post identity 只能完整已知或完整 UNKNOWN；零写结果码不得带 post identity', () => {
    expect(() =>
      buildTerminalResult({
        ...terminalInput,
        resultCode: 'NEEDS_RECONCILIATION',
        postConfigFingerprint: 'p'.repeat(64),
        postConfigVersion: null,
        evidenceSource: 'EXECUTION',
      }),
    ).toThrow(/完整/);

    expect(() =>
      buildTerminalResult({
        ...terminalInput,
        resultCode: 'CONFLICT',
        postConfigFingerprint: 'p'.repeat(64),
        postConfigVersion: 'cfg-2',
        evidenceSource: 'EXECUTION',
      }),
    ).toThrow(/零写/);

    const unknown = buildTerminalResult({
      ...terminalInput,
      resultCode: 'NEEDS_RECONCILIATION',
      postConfigFingerprint: null,
      postConfigVersion: null,
      evidenceSource: 'EXECUTION',
    });
    expect(unknown.postConfigFingerprint).toBeNull();
    expect(unknown.postConfigVersion).toBeNull();
  });

  it('resultDigest 绑定 status / semantics / post identity（不同结果 → 不同摘要）', () => {
    const committed = buildTerminalResult({
      ...terminalInput,
      resultCode: 'COMMITTED',
      postConfigFingerprint: 'p'.repeat(64),
      postConfigVersion: 'cfg-2',
      evidenceSource: 'EXECUTION',
    });
    const noop = buildTerminalResult({
      ...terminalInput,
      resultCode: 'NOOP_ALREADY_APPLIED',
      postConfigFingerprint: 'p'.repeat(64),
      postConfigVersion: 'cfg-2',
      evidenceSource: 'EXECUTION',
    });
    const unknown = buildTerminalResult({
      ...terminalInput,
      resultCode: 'NEEDS_RECONCILIATION',
      postConfigFingerprint: null,
      postConfigVersion: null,
      evidenceSource: 'EXECUTION',
    });
    expect(new Set([committed.resultDigest, noop.resultDigest, unknown.resultDigest]).size).toBe(3);
  });

  it('outbox 事件键确定性；消费者幂等（重复消费不产生第二条交付）', () => {
    const record = buildTerminalResult({
      ...terminalInput,
      resultCode: 'COMMITTED',
      postConfigFingerprint: 'p'.repeat(64),
      postConfigVersion: 'cfg-2',
      evidenceSource: 'EXECUTION',
    });
    const eventA = buildTerminalOutboxEvent({ reservationId: 'res-1', result: record });
    const eventB = buildTerminalOutboxEvent({ reservationId: 'res-1', result: record });
    expect(eventA.eventKey).toBe(eventB.eventKey);
    expect(eventA.payloadDigest).toBe(eventB.payloadDigest);

    const first = decideOutboxDelivery(null, {
      outboxId: 'out-1',
      consumerRef: 'projection-worker',
      payloadDigest: eventA.payloadDigest,
      now: NOW,
    });
    expect(first.kind).toBe('CONSUME');

    const replay = decideOutboxDelivery(
      { id: 'del-1', payloadDigest: eventA.payloadDigest },
      { outboxId: 'out-1', consumerRef: 'projection-worker', payloadDigest: eventA.payloadDigest, now: NOW },
    );
    expect(replay).toEqual({ kind: 'ALREADY_CONSUMED', deliveryId: 'del-1' });

    const conflict = decideOutboxDelivery(
      { id: 'del-1', payloadDigest: eventA.payloadDigest },
      { outboxId: 'out-1', consumerRef: 'projection-worker', payloadDigest: 'other', now: NOW },
    );
    expect(conflict.kind).toBe('FAIL_CLOSED');
  });
});

describe('P6-PROD-U1 production current-config adapter（严格只读）', () => {
  const values = { 'outcomeLearning.autoAdoptThreshold': '0.80', 'policy.mode': 'SHADOW' };

  it('只读读取：指纹自算、版本可读、返回快照不可反向改写', async () => {
    const adapter = createReadOnlyCurrentConfigAdapter({
      target: 'prod-config',
      version: 'cfg-1',
      configValues: values,
      capturedAt: NOW.toISOString(),
    });
    const snapshot = await adapter.read('prod-config');
    expect(snapshot.configFingerprint).toBe(computeConfigFingerprint(values));
    expect(snapshot.version).toBe('cfg-1');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.configValues)).toBe(true);
    await expect(adapter.read('other-target')).rejects.toThrow(/UNKNOWN/);
  });

  it('三重身份比较：FRESH / STALE_CONFIG_FINGERPRINT / STALE_VERSION / PATH_VALUE_MISMATCH', async () => {
    const adapter = createReadOnlyCurrentConfigAdapter({
      target: 'prod-config',
      version: 'cfg-1',
      configValues: values,
    });
    const snapshot = await adapter.read('prod-config');
    const expected = {
      expectedBaselineConfigFingerprint: computeConfigFingerprint(values),
      expectedLiveConfigVersion: 'cfg-1',
      configPath: 'outcomeLearning.autoAdoptThreshold',
      expectedPathValue: '0.80',
    };
    expect(compareToAuthorizedBaseline(snapshot, expected)).toBe('FRESH');
    expect(
      compareToAuthorizedBaseline(snapshot, {
        ...expected,
        expectedBaselineConfigFingerprint: 'not-the-baseline-fingerprint',
      }),
    ).toBe('STALE_CONFIG_FINGERPRINT');
    expect(compareToAuthorizedBaseline(snapshot, { ...expected, expectedLiveConfigVersion: 'cfg-2' })).toBe(
      'STALE_VERSION',
    );
    expect(compareToAuthorizedBaseline(snapshot, { ...expected, expectedPathValue: '0.9' })).toBe(
      'PATH_VALUE_MISMATCH',
    );
  });

  it('漂移检测与读取失败（unknown outcome）可判定', async () => {
    const adapter = createReadOnlyCurrentConfigAdapter({
      target: 'prod-config',
      version: 'cfg-1',
      configValues: values,
    });
    const snapshot = await adapter.read('prod-config');
    expect(
      detectConfigDrift(snapshot, {
        expectedConfigFingerprint: computeConfigFingerprint(values),
        configPath: 'outcomeLearning.autoAdoptThreshold',
        expectedValue: '0.80',
      }),
    ).toEqual({ drifted: false, reasons: [] });
    expect(
      detectConfigDrift(snapshot, {
        expectedConfigFingerprint: 'other',
        configPath: 'missing.path',
        expectedValue: 'x',
      }).drifted,
    ).toBe(true);

    const failing = createReadOnlyCurrentConfigAdapter({
      target: 'prod-config',
      version: 'cfg-1',
      configValues: values,
      failRead: true,
    });
    await expect(failing.read('prod-config')).rejects.toThrow(/READ_UNAVAILABLE/);
  });

  it('模块不导出任何写入 / 发布 / 回滚入口', () => {
    const exportedFunctions = Object.entries(durability)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    for (const name of exportedFunctions) {
      expect(name).not.toMatch(/write|apply|promote|rollout|rollback|mutat/i);
    }
  });
});
