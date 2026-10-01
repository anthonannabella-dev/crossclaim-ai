/**
 * ② 下一小批次（MSG-20261001-16 NEXT）：platform.write 接口 / 状态机 / 权限 / 幂等 /
 * 审批绑定 / 模拟适配器 / fail-closed 验收（离线；不触达网络与真实平台）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateActionGuard } from '../services/action-guard/action-guard';
import {
  executePlatformWrite,
  createInMemoryPlatformWriteLedger,
  createSimulatedPlatformWritePort,
  buildPlatformWriteSnapshot,
  canonicalJson,
  deriveIdempotencyKey,
  snapshotDigest,
  attemptBackoffMs,
  isTerminalState,
  nextStateAfterOutcome,
  assertTransition,
  PLATFORM_WRITE_MAX_ATTEMPTS,
  PLATFORM_WRITE_TRANSPORT_ENABLED,
  PlatformWriteError,
  type PlatformWriteApprovalRecord,
  type PlatformWriteAuditEvent,
  type PlatformWriteDeps,
  type PlatformWritePort,
  type PlatformWriteRequest,
} from '../services/platform-write';

const FIXED_NOW = () => new Date('2026-10-01T06:00:00Z');
const ORG = 'org-1';

const CAPS_ALLOW = {
  tenantEnabled: true,
  featureEnabled: { 'platform.write': true },
  platformEnablement: { 'platform.write': true },
  productionGate: 'SATISFIED' as const,
  writeEnabled: true,
};

function makeRequest(overrides: Partial<PlatformWriteRequest> = {}): PlatformWriteRequest {
  return {
    organizationId: ORG,
    caseId: 'case-1',
    targetKind: 'CLAIM',
    targetId: 'claim-1',
    platform: 'AMAZON',
    payload: { claim_type: 'FBA_REIMBURSEMENT', claimed_amount: '120.5000', claimed_currency: 'USD' },
    actorUserId: 'user-1',
    approvalId: 'ap-1',
    ...overrides,
  };
}

function digestOf(request: PlatformWriteRequest): string {
  return snapshotDigest(
    buildPlatformWriteSnapshot({
      organizationId: request.organizationId,
      caseId: request.caseId,
      targetKind: request.targetKind,
      targetId: request.targetId,
      platform: request.platform,
      payload: request.payload,
    }),
  );
}

function approvalFor(
  request: PlatformWriteRequest,
  overrides: Partial<PlatformWriteApprovalRecord> = {},
): PlatformWriteApprovalRecord {
  return {
    id: request.approvalId ?? 'ap-1',
    organizationId: request.organizationId,
    action: 'platform.write',
    basisReference: digestOf(request),
    expiresAt: '2026-10-01T07:00:00Z',
    consumedAt: null,
    ...overrides,
  };
}

function makeFixture(_request: PlatformWriteRequest, approval: PlatformWriteApprovalRecord | null, overrides: Partial<PlatformWriteDeps> = {}) {
  const ledger = createInMemoryPlatformWriteLedger();
  const sink = createSimulatedPlatformWritePort('AMAZON');
  const audits: PlatformWriteAuditEvent[] = [];
  const deps: PlatformWriteDeps = {
    guard: evaluateActionGuard,
    approvals: {
      async get(id: string) {
        return approval && approval.id === id ? approval : null;
      },
    },
    ledger,
    sink,
    capabilities: CAPS_ALLOW,
    audit: async (event) => {
      audits.push(event);
    },
    now: FIXED_NOW,
    ...overrides,
  };
  return { deps, ledger, sink, audits };
}

describe('MSG-20261001-16 NEXT · platform.write 批次验收', () => {
  it('01 硬开关与默认 fail-closed：传输关闭 → NEEDS_MANUAL，零投递/零账本/零状态推进', async () => {
    expect(PLATFORM_WRITE_TRANSPORT_ENABLED).toBe(false);
    const request = makeRequest();
    const { deps, ledger, sink, audits } = makeFixture(request, approvalFor(request));

    const result = await executePlatformWrite(request, deps);

    expect(result.status).toBe('NEEDS_MANUAL');
    expect(result.code).toBe('PLATFORM_WRITE_TRANSPORT_DISABLED');
    expect(result.transportEnabled).toBe(false);
    expect(result.sinkCalls).toBe(0);
    expect(result.attempts).toBe(0);
    expect(result.state).toBe('PENDING');
    expect(sink.callCount()).toBe(0);
    expect(ledger.size()).toBe(0);
    expect(audits.map((event) => event.type)).toEqual(['platform.write.needs_manual']);
  });

  it('02 能力闸门未满足（writeEnabled=false）→ BLOCKED，零投递', async () => {
    const request = makeRequest();
    const { deps, sink } = makeFixture(request, approvalFor(request), {
      capabilities: { ...CAPS_ALLOW, writeEnabled: false },
      simulatedTransport: true,
    });

    const result = await executePlatformWrite(request, deps);

    expect(result.status).toBe('BLOCKED');
    expect(result.code).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    expect(result.reasons.join('|')).toContain('writeEnabled');
    expect(sink.callCount()).toBe(0);
  });

  it('03 缺 approvalId → REQUIRE_APPROVAL 拒绝，零投递', async () => {
    const request = makeRequest({ approvalId: undefined });
    const { deps, sink } = makeFixture(request, null, { simulatedTransport: true });

    const result = await executePlatformWrite(request, deps);

    expect(result.status).toBe('BLOCKED');
    expect(result.code).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
    expect(sink.callCount()).toBe(0);
  });

  it('04 审批不存在 → APPROVAL_NOT_FOUND，零投递', async () => {
    const request = makeRequest();
    const { deps, sink } = makeFixture(request, null, { simulatedTransport: true });

    const result = await executePlatformWrite(request, deps);

    expect(result.code).toBe('APPROVAL_NOT_FOUND');
    expect(sink.callCount()).toBe(0);
  });

  it('05 审批动作不通用（appeal.submit 的审批）→ APPROVAL_ACTION_MISMATCH', async () => {
    const request = makeRequest();
    const { deps, sink } = makeFixture(request, approvalFor(request, { action: 'appeal.submit' }), {
      simulatedTransport: true,
    });

    const result = await executePlatformWrite(request, deps);

    expect(result.code).toBe('APPROVAL_ACTION_MISMATCH');
    expect(sink.callCount()).toBe(0);
  });

  it('06 跨租户审批 → APPROVAL_TENANT_MISMATCH', async () => {
    const request = makeRequest();
    const { deps, sink } = makeFixture(request, approvalFor(request, { organizationId: 'org-2' }), {
      simulatedTransport: true,
    });

    const result = await executePlatformWrite(request, deps);

    expect(result.code).toBe('APPROVAL_TENANT_MISMATCH');
    expect(sink.callCount()).toBe(0);
  });

  it('07 审批过期 / 已消费 → 分别拒绝，零投递', async () => {
    const request = makeRequest();
    const expired = makeFixture(request, approvalFor(request, { expiresAt: '2026-10-01T05:00:00Z' }), {
      simulatedTransport: true,
    });
    const consumed = makeFixture(request, approvalFor(request, { consumedAt: '2026-10-01T05:30:00Z' }), {
      simulatedTransport: true,
    });

    expect((await executePlatformWrite(request, expired.deps)).code).toBe('APPROVAL_EXPIRED');
    expect((await executePlatformWrite(request, consumed.deps)).code).toBe('APPROVAL_ALREADY_CONSUMED');
    expect(expired.sink.callCount() + consumed.sink.callCount()).toBe(0);
  });

  it('08 审批绑定不一致（载荷已变化）→ APPROVAL_BINDING_MISMATCH，零投递', async () => {
    const request = makeRequest();
    const stale = approvalFor(makeRequest({ payload: { claim_type: 'DNR_DISPUTE' } }));
    const { deps, sink } = makeFixture(request, stale, { simulatedTransport: true });

    const result = await executePlatformWrite(request, deps);

    expect(result.code).toBe('APPROVAL_BINDING_MISMATCH');
    expect(sink.callCount()).toBe(0);
  });

  it('09 模拟通道成功：状态机 PENDING→IN_FLIGHT→SUCCEEDED，恰一次投递 + 审计顺序', async () => {
    const request = makeRequest();
    const { deps, ledger, sink, audits } = makeFixture(request, approvalFor(request), {
      simulatedTransport: true,
    });

    const result = await executePlatformWrite(request, deps);

    expect(result.status).toBe('SUCCEEDED');
    expect(result.state).toBe('SUCCEEDED');
    expect(result.attempts).toBe(1);
    expect(result.sinkCalls).toBe(1);
    expect(result.externalRef).toBe('AMAZON-REF-0001');
    expect(sink.callCount()).toBe(1);
    expect(audits.map((event) => event.type)).toEqual(['platform.write.attempted', 'platform.write.settled']);
    const entry = ledger.entries.get(result.idempotencyKey);
    expect(entry?.state).toBe('SUCCEEDED');
    expect(entry?.attempts).toBe(1);
  });

  it('10 幂等重放：同键同摘要第二次 → REPLAYED，不重复投递', async () => {
    const request = makeRequest();
    const { deps, sink } = makeFixture(request, approvalFor(request), { simulatedTransport: true });

    const first = await executePlatformWrite(request, deps);
    const second = await executePlatformWrite(request, deps);

    expect(first.status).toBe('SUCCEEDED');
    expect(second.status).toBe('REPLAYED');
    expect(second.code).toBe('PLATFORM_WRITE_REPLAYED');
    expect(second.sinkCalls).toBe(0);
    expect(second.externalRef).toBe(first.externalRef);
    expect(sink.callCount()).toBe(1);
  });

  it('11 显式幂等键与服务端派生不一致 → IDEMPOTENCY_KEY_MISMATCH，零投递', async () => {
    const request = makeRequest({ idempotencyKey: 'pw1-0000000000000000000000000000000000000000' });
    const { deps, sink } = makeFixture(request, approvalFor(request), { simulatedTransport: true });

    const result = await executePlatformWrite(request, deps);

    expect(result.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(sink.callCount()).toBe(0);
  });

  it('12 可重试失败到上限 → DEAD_LETTER，投递次数等于上限', async () => {
    const request = makeRequest();
    const sink = createSimulatedPlatformWritePort('AMAZON', [
      { status: 'RETRYABLE', code: 'UPSTREAM_503' },
      { status: 'RETRYABLE', code: 'UPSTREAM_503' },
      { status: 'RETRYABLE', code: 'UPSTREAM_503' },
      { status: 'SUCCEEDED', externalRef: 'SHOULD-NOT-BE-USED' },
    ]);
    const { deps } = makeFixture(request, approvalFor(request), { simulatedTransport: true, sink });

    const result = await executePlatformWrite(request, deps);

    expect(result.status).toBe('DEAD_LETTER');
    expect(result.state).toBe('DEAD_LETTER');
    expect(result.attempts).toBe(PLATFORM_WRITE_MAX_ATTEMPTS);
    expect(sink.callCount()).toBe(PLATFORM_WRITE_MAX_ATTEMPTS);
    expect(result.externalRef).toBeUndefined();
  });

  it('13 上游硬拒绝 → FAILED 终态且不重试', async () => {
    const request = makeRequest();
    const sink = createSimulatedPlatformWritePort('AMAZON', [
      { status: 'REJECTED', code: 'POLICY_VIOLATION' },
      { status: 'SUCCEEDED', externalRef: 'SHOULD-NOT-BE-USED' },
    ]);
    const { deps } = makeFixture(request, approvalFor(request), { simulatedTransport: true, sink });

    const result = await executePlatformWrite(request, deps);

    expect(result.status).toBe('FAILED');
    expect(result.code).toBe('POLICY_VIOLATION');
    expect(sink.callCount()).toBe(1);
  });

  it('14 快照规范化：键顺序无关，任一字段变化都会改变摘要与幂等键', () => {
    const left = makeRequest({ payload: { a: 1, b: { x: 'y', w: [2, 1] } } });
    const right = makeRequest({ payload: { b: { w: [2, 1], x: 'y' }, a: 1 } });
    const changed = makeRequest({ payload: { a: 1, b: { x: 'y', w: [1, 2] } } });

    expect(canonicalJson(left.payload)).toBe(canonicalJson(right.payload));
    expect(digestOf(left)).toBe(digestOf(right));
    expect(digestOf(changed)).not.toBe(digestOf(left));
    expect(deriveIdempotencyKey(digestOf(left))).not.toBe(deriveIdempotencyKey(digestOf(changed)));
    expect(deriveIdempotencyKey(digestOf(left))).toBe(deriveIdempotencyKey(digestOf(right)));
  });

  it('15 非模拟端口（真实写入面）无法被启用 → SIMULATED_SINK_REQUIRED', async () => {
    const request = makeRequest();
    const realish = {
      platform: 'AMAZON',
      simulated: false,
      async submit() {
        return { status: 'SUCCEEDED' as const, externalRef: 'REAL-1' };
      },
    } as unknown as PlatformWritePort;
    const { deps } = makeFixture(request, approvalFor(request), { simulatedTransport: true, sink: realish });

    await expect(executePlatformWrite(request, deps)).rejects.toThrowError(PlatformWriteError);
    await expect(executePlatformWrite(request, deps)).rejects.toMatchObject({
      code: 'SIMULATED_SINK_REQUIRED',
    });
  });

  it('16 状态机：非法迁移抛错、终态不可离开、退避为纯函数', () => {
    expect(isTerminalState('SUCCEEDED')).toBe(true);
    expect(isTerminalState('RETRYABLE')).toBe(false);
    expect(() => assertTransition('SUCCEEDED', 'IN_FLIGHT')).toThrowError(PlatformWriteError);
    expect(() => assertTransition('PENDING', 'SUCCEEDED')).toThrowError(PlatformWriteError);
    expect(nextStateAfterOutcome({ status: 'RETRYABLE', code: 'X' }, 1)).toBe('RETRYABLE');
    expect(nextStateAfterOutcome({ status: 'RETRYABLE', code: 'X' }, PLATFORM_WRITE_MAX_ATTEMPTS)).toBe('DEAD_LETTER');
    expect(attemptBackoffMs(0)).toBe(0);
    expect(attemptBackoffMs(1)).toBe(250);
    expect(attemptBackoffMs(9)).toBe(4000);
  });

  it('17 静态探针：platform-write 模块不含网络调用、env 读取或凭据解析', () => {
    const candidates = [
      path.resolve(process.cwd(), 'src/services/platform-write'),
      path.resolve(process.cwd(), 'apps/api/src/services/platform-write'),
    ];
    const dir = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const banned = ['fetch(', 'axios', 'node:http', 'node:https', 'process.env', 'SecretProvider', 'secretRef'];
    for (const name of files) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const token of banned) {
        expect(text.includes(token), name + ' 不应包含 ' + token).toBe(false);
      }
    }
  });
});
