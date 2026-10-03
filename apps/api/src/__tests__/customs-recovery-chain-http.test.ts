/** BG-012 — Customs 恢复链内部触发 handler 回归（角色矩阵 / 边界字段 / 错误映射）。 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_CHAIN_RUN_ACTION,
  CUSTOMS_CHAIN_RUN_BOUNDARY,
  CUSTOMS_CHAIN_RUN_RISK_CLASS,
  postCustomsRecoveryChain,
} from '../services/customs/customs-recovery-chain-http';

const session = (role: string) => ({ organizationId: 'org-1', actorUserId: 'u1', role });

const okResult = {
  executionKey: 'e'.repeat(64),
  package: {
    packageId: 'pkg-1',
    readiness: 'READY',
    gaps: [],
    estimateOnly: true,
    billable: false,
    filingPerformed: false,
    submissionPerformed: false,
  },
  projections: [],
  algorithmVersion: 'v1',
} as never;

describe('BG-012 — customs recovery chain internal trigger', () => {
  it('OWNER / ADMIN / OPS → 200，且响应含执行身份与永久 HOLD 字段', async () => {
    for (const role of ['OWNER', 'ADMIN', 'OPS']) {
      const res = await postCustomsRecoveryChain({ session: session(role), entryFactId: 'fact-1', run: async () => okResult });
      expect(res.status).toBe(200);
      expect(res.body.executionKey).toBe('e'.repeat(64));
      const boundary = res.body.boundary as Record<string, unknown>;
      expect(boundary.filingSubmitted).toBe(false);
      expect(boundary.externalWritePerformed).toBe(false);
      expect(boundary.transportEnabled).toBe(false);
      expect(boundary.productionCredentials).toBe('ABSENT');
      expect(boundary.filingAuthorized).toBe(false);
    }
  });

  it('FINANCE / VIEWER / 未知角色 → 403（后端强制，前端无法绕过）', async () => {
    for (const role of ['FINANCE', 'VIEWER', 'UNKNOWN']) {
      const res = await postCustomsRecoveryChain({ session: session(role), entryFactId: 'fact-1', run: async () => okResult });
      expect(res.status).toBe(403);
      expect((res.body.boundary as Record<string, unknown>).filingSubmitted).toBe(false);
    }
  });

  it('空 entryFactId → 400；事实不存在 → 404；其它错误 → 409（均保留边界字段）', async () => {
    expect((await postCustomsRecoveryChain({ session: session('OWNER'), entryFactId: '  ', run: async () => okResult })).status).toBe(400);
    const notFound = await postCustomsRecoveryChain({
      session: session('OWNER'),
      entryFactId: 'missing',
      run: async () => {
        throw Object.assign(new Error('x'), { code: 'FACT_NOT_FOUND' });
      },
    });
    expect(notFound.status).toBe(404);
    const conflict = await postCustomsRecoveryChain({
      session: session('OWNER'),
      entryFactId: 'fact-1',
      run: async () => {
        throw Object.assign(new Error('y'), { code: 'PACKAGE_INPUT_INCONSISTENT' });
      },
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body.boundary as Record<string, unknown>).transportEnabled).toBe(false);
  });

  it('常量：action / 风险类别 / 零外呼与零资金副作用', () => {
    expect(CUSTOMS_CHAIN_RUN_ACTION).toBe('customs.recovery.chain.run');
    expect(CUSTOMS_CHAIN_RUN_RISK_CLASS).toBe('INTERNAL_WRITE');
    expect(CUSTOMS_CHAIN_RUN_BOUNDARY.internalWritePerformed).toBe(true);
    expect(CUSTOMS_CHAIN_RUN_BOUNDARY.providerCalls).toBe(0);
    expect(CUSTOMS_CHAIN_RUN_BOUNDARY.brokerCalls).toBe(0);
    expect(CUSTOMS_CHAIN_RUN_BOUNDARY.moneySideEffects).toBe(0);
  });
});
