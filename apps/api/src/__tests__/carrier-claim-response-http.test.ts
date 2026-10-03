/**
 * CARRIER QUEUE #10 FINAL（MSG-20261003-122 ㉘㉙㉛）— HTTP 边界验收。
 * 断言：人工入口**只能**产生 USER_REPORTED（client 不得提交 source / verificationLevel / 身份字段）；
 *       角色矩阵 OWNER/ADMIN/OPS 可、FINANCE/VIEWER/未知不可；anti-enumeration 404；
 *       幂等重放 200；读模型 tenant-scoped 且不泄漏 credential；两端点均无网络。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  handleCarrierClaimResponseReadRequest,
  handleCarrierClaimResponseRecordRequest,
  type CarrierClaimResponseHttpDeps,
} from '../services/carriers/carrier-claim-response-http';
import {
  createInMemoryCarrierClaimResponseStore,
  type CarrierClaimResponseFact,
} from '../services/carriers/carrier-claim-response';
import { PERMISSIONS } from '../services/workflow/permissions';

const ORG = 'ccd30000-0000-4000-8000-000000000001';
const ORG_B = 'ccd30000-0000-4000-8000-000000000009';
const USER = 'ccd30000-0000-4000-8000-000000000002';
const PKG = 'pkg-q10f-http';
const NOW = new Date('2026-10-03T10:00:00.000Z');

function depsFor(): CarrierClaimResponseHttpDeps {
  return {
    submissions: {
      async load(organizationId, packageId) {
        if (organizationId !== ORG || packageId !== PKG) return null;
        return {
          packageId: PKG,
          submissionRecordId: 'ccd40000-0000-4000-8000-000000000001',
          provider: 'UPS' as const,
          externalAccountId: 'UPS-ACCT-1',
          trackingNumber: '1Z999AA10123456784',
        };
      },
    },
    store: createInMemoryCarrierClaimResponseStore(),
    now: () => NOW,
  };
}

function session(role: string, organizationId = ORG) {
  return { organizationId, actorUserId: USER, role };
}

function recordRequest(body: Record<string, unknown>, role = 'OWNER', deps = depsFor()) {
  return handleCarrierClaimResponseRecordRequest(
    { packageId: PKG, request: body as never, session: session(role) },
    deps,
  );
}

describe('CARRIER QUEUE #10 FINAL — HTTP boundary', () => {
  it('㉘ 角色矩阵：OWNER/ADMIN/OPS 有 recordCarrierClaimResponse，FINANCE/VIEWER 没有', () => {
    expect(PERMISSIONS.OWNER.recordCarrierClaimResponse).toBe(true);
    expect(PERMISSIONS.ADMIN.recordCarrierClaimResponse).toBe(true);
    expect(PERMISSIONS.OPS.recordCarrierClaimResponse).toBe(true);
    expect(PERMISSIONS.FINANCE.recordCarrierClaimResponse).toBe(false);
    expect(PERMISSIONS.VIEWER.recordCarrierClaimResponse).toBe(false);
  });

  it('㉙ client 提交 source → 400（HTTP surface 不暴露 provider 来源选择权）', async () => {
    const deps = depsFor();
    const res = await recordRequest({ status: 'APPROVED', source: 'PROVIDER_API', providerReference: 'X' }, 'OWNER', deps);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('FIELD_NOT_ALLOWED:source');
    expect(await deps.store.listByPackage(ORG, PKG)).toHaveLength(0);
  });

  it('㉙ client 提交 verificationLevel / 身份字段 → 400 且零事实', async () => {
    const deps = depsFor();
    for (const field of ['verificationLevel', 'organizationId', 'recordedByUserId', 'trackingNumber', 'idempotencyKey']) {
      const res = await recordRequest({ status: 'APPROVED', [field]: 'x' }, 'OWNER', deps);
      expect(res.status).toBe(400);
      expect(res.body.detail).toBe('FIELD_NOT_ALLOWED:' + field);
    }
    expect(await deps.store.listByPackage(ORG, PKG)).toHaveLength(0);
  });

  it('㉘ VIEWER（无 capability）→ 403 且零事实；未知角色同样 403', async () => {
    const deps = depsFor();
    const viewer = await recordRequest({ status: 'APPROVED' }, 'VIEWER', deps);
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe('CAPABILITY_REQUIRED');
    const unknown = await recordRequest({ status: 'APPROVED' }, 'GHOST', deps);
    expect(unknown.status).toBe(403);
    expect(await deps.store.listByPackage(ORG, PKG)).toHaveLength(0);
  });

  it('㉝ 未知 package → 404 SUBMISSION_NOT_FOUND（anti-enumeration）', async () => {
    const deps = depsFor();
    const res = await handleCarrierClaimResponseRecordRequest(
      { packageId: 'pkg-missing', request: { status: 'APPROVED' } as never, session: session('OWNER') },
      deps,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SUBMISSION_NOT_FOUND');
    const crossTenant = await handleCarrierClaimResponseRecordRequest(
      { packageId: PKG, request: { status: 'APPROVED' } as never, session: session('OWNER', ORG_B) },
      deps,
    );
    expect(crossTenant.status).toBe(404);
  });

  it('㉙ OWNER + 合法人工补录 → 201，事实恒为 USER_REPORTED / UNVERIFIED', async () => {
    const deps = depsFor();
    const res = await recordRequest({ status: 'APPROVED', providerReference: 'CASE-9' }, 'OWNER', deps);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('RECORDED');
    const fact = res.body.responseFact as CarrierClaimResponseFact;
    expect(fact.source).toBe('USER_REPORTED');
    expect(fact.verificationLevel).toBe('UNVERIFIED');
    expect(fact.providerReference).toBe('CASE-9');
    expect(fact.status).toBe('APPROVED');
  });

  it('㉝ 幂等重放 → 200 ALREADY_RECORDED，事实仍只有一条', async () => {
    const deps = depsFor();
    const first = await recordRequest({ status: 'PAID' }, 'OWNER', deps);
    const second = await recordRequest({ status: 'PAID' }, 'OWNER', deps);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('ALREADY_RECORDED');
    expect(await deps.store.listByPackage(ORG, PKG)).toHaveLength(1);
  });

  it('形状校验：未知 status → 400；未来 observedAt → 400 FUTURE_TIMESTAMP', async () => {
    const bad = await recordRequest({ status: 'REFUNDED' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_REQUEST');
    const future = await recordRequest({ status: 'APPROVED', observedAt: '2026-10-05T00:00:00.000Z' });
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('FUTURE_TIMESTAMP');
  });

  it('㉛ 读模型：GET 返回 projection（history / currentStatus / provenance），tenant-scoped', async () => {
    const deps = depsFor();
    await recordRequest({ status: 'PENDING', observedAt: '2026-10-03T06:00:00.000Z' }, 'OWNER', deps);
    await recordRequest({ status: 'UNDER_REVIEW', observedAt: '2026-10-03T07:00:00.000Z' }, 'OWNER', deps);
    const res = await handleCarrierClaimResponseReadRequest({ packageId: PKG, session: session('VIEWER') }, deps);
    expect(res.status).toBe(200);
    const responses = res.body.responses as Record<string, unknown>;
    expect(responses.currentStatus).toBe('UNDER_REVIEW');
    expect(responses.currentVerificationLevel).toBe('UNVERIFIED');
    expect((responses.history as unknown[]).length).toBe(2);
    expect(responses.derivesRecoveredCash).toBe(false);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['credential', 'accessToken', 'rawPayload', 'secret', 'successFee', 'actualRecovered']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉛ 读模型：未知 package → 404；未知角色 → 403', async () => {
    const deps = depsFor();
    const missing = await handleCarrierClaimResponseReadRequest({ packageId: 'pkg-missing', session: session('OWNER') }, deps);
    expect(missing.status).toBe(404);
    const ghost = await handleCarrierClaimResponseReadRequest({ packageId: PKG, session: session('GHOST') }, deps);
    expect(ghost.status).toBe(403);
  });

  it('无网络：记录与读取路径都不发起 provider 调用；TRANSPORT 相关字段恒 false', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const deps = depsFor();
      const res = await recordRequest({ status: 'CLOSED' }, 'OPS', deps);
      expect(res.status).toBe(201);
      const fact = res.body.responseFact as CarrierClaimResponseFact;
      expect(fact.externalWritePerformed).toBe(false);
      expect(fact.transportEnabled).toBe(false);
      expect(fact.platformWriteEnabled).toBe(false);
      expect(fact.productionCredentials).toBe('ABSENT');
      const read = await handleCarrierClaimResponseReadRequest({ packageId: PKG, session: session('ADMIN') }, deps);
      expect(read.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
