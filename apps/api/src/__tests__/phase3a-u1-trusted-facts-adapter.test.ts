/**
 * PHASE 3-A · U1（只读）—— 权威可信事实适配器 · 纯函数/端口级验收
 * 授权：MSG-20261009-14（U1_READ_ONLY_SUBSET）。本套件证明：只读、fail-closed、不可伪造输入、provenance 完整。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TRUSTED_FACTS_ADAPTER_BOUNDARY,
  createTrustedFactsAdapter,
  type TrustedFactsReadPort,
} from '../services/self-repair/trusted-facts-adapter';

const AT = new Date('2026-10-09T03:00:00.000Z');

const org = { id: 'org-u1', identityVersion: 'idv-1' };
const activeAuth = {
  authorizationVersion: 7,
  revocationState: 'ACTIVE',
  effectiveAt: new Date('2026-10-01T00:00:00.000Z'),
  expiresAt: new Date('2026-11-01T00:00:00.000Z'),
  allowedActionTypes: ['recovery.read', 'internal.repair.propose'],
  monetaryLimitUsd: '100.0000',
  scopeDigest: 'a'.repeat(64),
};

const port = (overrides: Partial<{ org: typeof org | null; auth: typeof activeAuth | null }> = {}): TrustedFactsReadPort => {
  const calls: string[] = [];
  return {
    async findOrganization() {
      calls.push('findOrganization');
      return overrides.org === undefined ? org : overrides.org;
    },
    async findStandingAuthorization() {
      calls.push('findStandingAuthorization');
      return overrides.auth === undefined ? activeAuth : overrides.auth;
    },
  };
};

const adapter = (readPort: TrustedFactsReadPort, recheck: 'CONFIRMED_READ_ONLY' | 'NOT_CONFIRMED' = 'CONFIRMED_READ_ONLY') =>
  createTrustedFactsAdapter({
    readPort,
    executionContext: { subjectRef: 'runtime-member-1', operationRecheck: recheck },
    now: () => AT,
  });

describe('PHASE 3-A / U1 可信事实适配器（只读）', () => {
  it('可信事实齐备 ⇒ 返回 facts 与完整 provenance', async () => {
    const result = await adapter(port()).resolve({ organizationId: 'org-u1', actionType: 'recovery.read' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.facts).toEqual({
      organizationIdResolved: true,
      authorizationActive: true,
      operationRecheck: 'CONFIRMED_READ_ONLY',
    });
    expect(result.provenance.organizationIdResolved).toMatchObject({
      source: 'TRUSTED_PERSISTED_IDENTITY',
      resolvedFrom: 'Organization',
      subjectRef: 'runtime-member-1',
      identityVersion: 'idv-1',
    });
    expect(result.provenance.authorizationActive).toMatchObject({
      source: 'SERVER_AUTHORIZATION_STATE',
      authorizationVersion: 7,
      scopeDigest: 'a'.repeat(64),
    });
    expect(result.provenance.operationRecheck).toMatchObject({
      source: 'TRUSTED_EXECUTION_CONTEXT',
      recheck: 'CONFIRMED_READ_ONLY',
    });
    expect(result.provenance.factVersion).toBe('org:idv-1|auth:7');
  });

  it.each([
    ['空 organizationId（无服务端租户上下文）', { organizationId: '', actionType: 'recovery.read' }, {}, 'TENANT_CONTEXT_REQUIRED'],
    ['组织不存在', { organizationId: 'missing', actionType: 'recovery.read' }, { org: null }, 'ORGANIZATION_NOT_FOUND'],
    ['无授权记录', { organizationId: 'org-u1', actionType: 'recovery.read' }, { auth: null }, 'AUTHORIZATION_NOT_FOUND'],
    [
      '授权已撤销',
      { organizationId: 'org-u1', actionType: 'recovery.read' },
      { auth: { ...activeAuth, revocationState: 'REVOKED' } },
      'AUTHORIZATION_REVOKED',
    ],
    [
      '授权未生效',
      { organizationId: 'org-u1', actionType: 'recovery.read' },
      { auth: { ...activeAuth, effectiveAt: new Date('2026-10-10T00:00:00.000Z') } },
      'AUTHORIZATION_NOT_EFFECTIVE',
    ],
    [
      '授权已过期',
      { organizationId: 'org-u1', actionType: 'recovery.read' },
      { auth: { ...activeAuth, expiresAt: new Date('2026-10-09T02:59:59.000Z') } },
      'AUTHORIZATION_NOT_EFFECTIVE',
    ],
    [
      '动作类型不在授权范围',
      { organizationId: 'org-u1', actionType: 'payment.capture' },
      {},
      'ACTION_TYPE_NOT_ALLOWED',
    ],
    [
      '金额超过授权上限',
      { organizationId: 'org-u1', actionType: 'recovery.read', amountUsd: '100.0001' },
      {},
      'MONETARY_LIMIT_EXCEEDED',
    ],
  ])('%s ⇒ fail-closed（%s）', async (_label, request, overrides, reason) => {
    const result = await adapter(port(overrides as never)).resolve(request as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe(reason);
  });

  it('运行时复核未确认 ⇒ OPERATION_RECHECK_NOT_CONFIRMED（不降级）', async () => {
    const result = await adapter(port(), 'NOT_CONFIRMED').resolve({ organizationId: 'org-u1', actionType: 'recovery.read' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('OPERATION_RECHECK_NOT_CONFIRMED');
  });

  it('金额等于上限可通过；无法解析的金额 fail-closed', async () => {
    const equal = await adapter(port()).resolve({ organizationId: 'org-u1', actionType: 'recovery.read', amountUsd: '100.0000' });
    expect(equal.ok).toBe(true);
    const bogus = await adapter(port()).resolve({ organizationId: 'org-u1', actionType: 'recovery.read', amountUsd: '1e3' });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.reason).toBe('MONETARY_LIMIT_EXCEEDED');
  });

  it('接口不含 payload/request 参数（外部输入在类型层面无法成为可信身份）', () => {
    const source = readFileSync(path.resolve(__dirname, '../services/self-repair/trusted-facts-adapter.ts'), 'utf8');
    expect(source.includes('payload')).toBe(false);
    expect(source.includes('modelOutput')).toBe(false);
    // 只读：不得出现任何写操作
    for (const forbidden of ['.create(', '.update(', '.delete(', '.upsert(', '.updateMany(', '$executeRaw', '$queryRaw']) {
      expect(source.includes(forbidden)).toBe(false);
    }
    expect(TRUSTED_FACTS_ADAPTER_BOUNDARY).toMatchObject({
      readOnly: true,
      performsWrites: false,
      createsTasks: false,
      createsCandidates: false,
      acquiresLeases: false,
      invokesRuntime: false,
      acceptsRequestOrModelInput: false,
      failClosedOnUnresolvedFacts: true,
      runtimeSourceIsolationImplemented: false,
    });
  });
});
