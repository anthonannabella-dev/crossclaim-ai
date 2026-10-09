/**
 * PHASE 3-A — U1：只读权威可信事实适配器 → 端口级单元测试（CHANGE 17–20 修订版）
 * 授权：MSG-20261009-14（U1_READ_ONLY_SUBSET）+ MSG-20261009-15（CHANGE 17–20）
 * 覆盖：授权唯一性 / 多授权冲突 fail-closed、金额与币种显式规则、调用方边界与版本失效、
 *       只读事务包裹全部读取、静态来源断言（不接受候选载荷 / 模型输出，唯一原生 SQL 为只读语句）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  READ_ONLY_TRANSACTION_SQL,
  TRUSTED_FACTS_ADAPTER_BOUNDARY,
  TRUSTED_FACTS_CALLERS,
  createTrustedFactsAdapter,
  exceedsMonetaryLimit,
  type StandingAuthorizationRecord,
  type TrustedFactsReadPort,
} from '../services/self-repair/trusted-facts-adapter';

const AT = new Date('2026-10-09T03:00:00.000Z');

const org = { id: 'org-u1', identityVersion: 'idv-1' };

const auth = (overrides: Partial<StandingAuthorizationRecord> = {}): StandingAuthorizationRecord => ({
  authorizationId: 'auth-1',
  authorizationVersion: 7,
  revocationState: 'ACTIVE',
  effectiveAt: new Date('2026-10-01T00:00:00.000Z'),
  expiresAt: new Date('2026-11-01T00:00:00.000Z'),
  allowedActionTypes: ['recovery.read', 'internal.repair.propose'],
  monetaryLimitUsd: '100.0000',
  currency: 'USD',
  provider: 'AMAZON',
  platformAccountId: 'acct-1',
  domain: 'LOGISTICS',
  jurisdiction: 'US',
  scopeDigest: 'a'.repeat(64),
  ...overrides,
});

const makePort = (
  overrides: { org?: typeof org | null; auths?: readonly StandingAuthorizationRecord[] } = {},
): { readPort: TrustedFactsReadPort; calls: string[] } => {
  const calls: string[] = [];
  let insideTransaction = false;
  return {
    calls,
    readPort: {
      async findOrganization() {
        calls.push(`findOrganization:tx=${insideTransaction}`);
        return overrides.org === undefined ? org : overrides.org;
      },
      async listStandingAuthorizations() {
        calls.push(`listStandingAuthorizations:tx=${insideTransaction}`);
        return overrides.auths === undefined ? [auth()] : overrides.auths;
      },
      async withReadOnlyTransaction(run) {
        if (insideTransaction) throw new Error('NESTED_READ_ONLY_TRANSACTION');
        calls.push('withReadOnlyTransaction:enter');
        insideTransaction = true;
        try {
          return await run();
        } finally {
          insideTransaction = false;
          calls.push('withReadOnlyTransaction:exit');
        }
      },
    },
  };
};

const adapter = (
  readPort: TrustedFactsReadPort,
  options: { caller?: string; recheck?: 'CONFIRMED_READ_ONLY' | 'NOT_CONFIRMED' } = {},
) =>
  createTrustedFactsAdapter({
    readPort,
    executionContext: {
      subjectRef: 'runtime-member-1',
      caller: options.caller ?? 'RUNTIME_MEMBER',
      operationRecheck: options.recheck ?? 'CONFIRMED_READ_ONLY',
    },
    now: () => AT,
  });

const base = { organizationId: 'org-u1', actionType: 'recovery.read', monetaryAction: false };
const monetary = { ...base, monetaryAction: true, amountUsd: '50.0000', currency: 'USD' };

interface FailureCase {
  label: string;
  request: Record<string, unknown>;
  overrides?: { org?: typeof org | null; auths?: readonly StandingAuthorizationRecord[] };
  caller?: string;
  recheck?: 'CONFIRMED_READ_ONLY' | 'NOT_CONFIRMED';
  reason: string;
}

const failureCases: FailureCase[] = [
  { label: '缺 organizationId（无法判定租户上下文）', request: { ...base, organizationId: '' }, reason: 'TENANT_CONTEXT_REQUIRED' },
  { label: '调用方不在白名单（MODEL）', request: base, caller: 'MODEL', reason: 'CALLER_NOT_TRUSTED' },
  { label: '调用方不在白名单（BUILDER）', request: base, caller: 'BUILDER', reason: 'CALLER_NOT_TRUSTED' },
  { label: '调用方不在白名单（CLIENT）', request: base, caller: 'CLIENT', reason: 'CALLER_NOT_TRUSTED' },
  { label: '调用方为空', request: base, caller: '   ', reason: 'CALLER_NOT_TRUSTED' },
  { label: '组织不存在', request: { ...base, organizationId: 'missing' }, overrides: { org: null }, reason: 'ORGANIZATION_NOT_FOUND' },
  { label: '该组织无任何授权行', request: base, overrides: { auths: [] }, reason: 'AUTHORIZATION_NOT_FOUND' },
  { label: '资源范围无匹配（provider）', request: { ...base, resourceScope: { provider: 'SHOPIFY' } }, reason: 'AUTHORIZATION_NOT_FOUND' },
  { label: '资源范围提供了空串', request: { ...base, resourceScope: { provider: '   ' } }, reason: 'AUTHORIZATION_NOT_FOUND' },
  { label: '授权已撤销', request: base, overrides: { auths: [auth({ revocationState: 'REVOKED' })] }, reason: 'AUTHORIZATION_REVOKED' },
  {
    label: '授权未生效（未来生效）',
    request: base,
    overrides: { auths: [auth({ effectiveAt: new Date('2026-10-10T00:00:00.000Z') })] },
    reason: 'AUTHORIZATION_NOT_EFFECTIVE',
  },
  {
    label: '授权已过期',
    request: base,
    overrides: { auths: [auth({ expiresAt: new Date('2026-10-09T02:59:59.000Z') })] },
    reason: 'AUTHORIZATION_NOT_EFFECTIVE',
  },
  {
    label: '多授权冲突（同请求两条有效记录）',
    request: base,
    overrides: { auths: [auth(), auth({ authorizationId: 'auth-2', authorizationVersion: 8, platformAccountId: 'acct-2' })] },
    reason: 'AUTHORIZATION_AMBIGUOUS',
  },
  { label: '动作类型不在授权范围', request: { ...base, actionType: 'payment.capture' }, reason: 'ACTION_TYPE_NOT_ALLOWED' },
  { label: '缺 monetaryAction（默认一律失败，不猜）', request: { organizationId: 'org-u1', actionType: 'recovery.read' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: 'monetaryAction 非布尔', request: { ...base, monetaryAction: 'false' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额动作缺金额', request: { ...base, monetaryAction: true, currency: 'USD' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额动作缺币种', request: { ...base, monetaryAction: true, amountUsd: '1.0000' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额形态非法（科学计数法）', request: { ...base, monetaryAction: true, amountUsd: '1e3', currency: 'USD' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额形态非法（负号）', request: { ...base, monetaryAction: true, amountUsd: '-1.0000', currency: 'USD' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额形态非法（小数超 4 位）', request: { ...base, monetaryAction: true, amountUsd: '1.00001', currency: 'USD' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额形态非法（空串）', request: { ...base, monetaryAction: true, amountUsd: '', currency: 'USD' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '请求币种非 USD', request: { ...base, monetaryAction: true, amountUsd: '1.0000', currency: 'EUR' }, reason: 'MONETARY_INPUT_INVALID' },
  {
    label: '授权行币种非 USD',
    request: monetary,
    overrides: { auths: [auth({ currency: 'EUR' })] },
    reason: 'MONETARY_INPUT_INVALID',
  },
  { label: '非金额动作却携带金额', request: { ...base, amountUsd: '1.0000' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '非金额动作却携带币种', request: { ...base, currency: 'USD' }, reason: 'MONETARY_INPUT_INVALID' },
  { label: '金额超过授权上限', request: { ...base, monetaryAction: true, amountUsd: '100.0001', currency: 'USD' }, reason: 'MONETARY_LIMIT_EXCEEDED' },
  {
    label: '授权上限不可解析',
    request: monetary,
    overrides: { auths: [auth({ monetaryLimitUsd: 'not-a-number' })] },
    reason: 'MONETARY_LIMIT_EXCEEDED',
  },
  { label: '期望事实版本不一致（陈旧事实）', request: { ...base, expectedFactVersion: 'org:idv-1|auth:6' }, reason: 'STALE_FACT_VERSION' },
  { label: '期望事实版本为空串', request: { ...base, expectedFactVersion: '' }, reason: 'STALE_FACT_VERSION' },
  { label: '运行时复核未确认', request: base, recheck: 'NOT_CONFIRMED', reason: 'OPERATION_RECHECK_NOT_CONFIRMED' },
];

describe('PHASE 3-A / U1 可信事实适配器（只读、CHANGE 17–20）', () => {
  it('可信事实齐备 ⇒ 返回 facts 与 provenance（含 authorizationId / caller / readScope）', async () => {
    const result = await adapter(makePort().readPort).resolve(base);
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
      authorizationId: 'auth-1',
      authorizationVersion: 7,
      scopeDigest: 'a'.repeat(64),
      currency: 'USD',
    });
    expect(result.provenance.callerBoundary).toMatchObject({
      source: 'TRUSTED_EXECUTION_CONTEXT',
      caller: 'RUNTIME_MEMBER',
      trusted: true,
    });
    expect(result.provenance.operationRecheck).toMatchObject({
      source: 'TRUSTED_EXECUTION_CONTEXT',
      recheck: 'CONFIRMED_READ_ONLY',
    });
    expect(result.provenance.readScope).toEqual({
      source: 'READ_ONLY_TRANSACTION',
      statement: READ_ONLY_TRANSACTION_SQL,
      coveredReads: ['Organization.findUnique', 'StandingAuthorization.findMany'],
      resolvedAt: AT.toISOString(),
    });
    expect(result.provenance.factVersion).toBe('org:idv-1|auth:7');
  });

  it('SERVER_REQUEST_GATE 也在白名单内，且金额等于上限（不超限）时通过', async () => {
    const exact = await adapter(makePort().readPort, { caller: 'SERVER_REQUEST_GATE' }).resolve({
      ...base,
      monetaryAction: true,
      amountUsd: '100.0000',
      currency: 'USD',
    });
    expect(exact.ok).toBe(true);
  });

  it('期望事实版本与本次读取一致 ⇒ 通过；资源范围提供且匹配 ⇒ 通过', async () => {
    const matched = await adapter(makePort().readPort).resolve({
      ...base,
      expectedFactVersion: 'org:idv-1|auth:7',
      resourceScope: { provider: 'amazon', platformAccountId: 'acct-1', domain: 'LOGISTICS', jurisdiction: 'US' },
    });
    expect(matched.ok).toBe(true);
    if (!matched.ok) throw new Error('expected ok');
    expect(matched.provenance.factVersion).toBe('org:idv-1|auth:7');
  });

  it.each(failureCases)('$label ⇒ fail-closed（$reason）', async (testCase) => {
    const { readPort } = makePort(testCase.overrides);
    const result = await adapter(readPort, { caller: testCase.caller, recheck: testCase.recheck }).resolve(
      testCase.request as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe(testCase.reason);
    expect(result.provenance).toBeNull();
  });

  it('全部读取在只读事务内执行，且不嵌套开启第二个事务', async () => {
    const { readPort, calls } = makePort();
    const result = await adapter(readPort).resolve(base);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      'withReadOnlyTransaction:enter',
      'findOrganization:tx=true',
      'listStandingAuthorizations:tx=true',
      'withReadOnlyTransaction:exit',
    ]);
  });

  it('失败路径（组织不存在）同样在只读事务内向端口读取', async () => {
    const { readPort, calls } = makePort({ org: null });
    const result = await adapter(readPort).resolve(base);
    expect(result.ok).toBe(false);
    expect(calls).toContain('findOrganization:tx=true');
    expect(calls[0]).toBe('withReadOnlyTransaction:enter');
    expect(calls[calls.length - 1]).toBe('withReadOnlyTransaction:exit');
  });

  it('十进制比较：等值不超限，超限 / 不可解析一律按超限处理', () => {
    expect(exceedsMonetaryLimit('100.0000', '100.0000')).toBe(false);
    expect(exceedsMonetaryLimit('0999.9999', '1000.0000')).toBe(false);
    expect(exceedsMonetaryLimit('100.0001', '100.0000')).toBe(true);
    expect(exceedsMonetaryLimit('1000.0000', '999.9999')).toBe(true);
    expect(exceedsMonetaryLimit('1.0000', 'not-a-number')).toBe(true);
    expect(exceedsMonetaryLimit('1e3', '100.0000')).toBe(true);
  });

  it('接口不接受候选载荷 / 模型输出；唯一原生 SQL 是只读事务语句', () => {
    const source = readFileSync(path.resolve(__dirname, '../services/self-repair/trusted-facts-adapter.ts'), 'utf8');
    expect(source.includes('payload')).toBe(false);
    expect(source.includes('modelOutput')).toBe(false);
    for (const forbidden of ['.create(', '.update(', '.delete(', '.upsert(', '.updateMany(', '.deleteMany(']) {
      expect(source.includes(forbidden)).toBe(false);
    }
    // 唯一允许的原生调用必须是只读事务语句本身（而不是任何写方法）
    const rawCallSites = source.match(/\$(?:execute|query)Raw\w*\(/g) ?? [];
    expect(rawCallSites).toEqual(['$executeRawUnsafe(']);
    expect(source).toContain('$executeRawUnsafe(READ_ONLY_TRANSACTION_SQL)');
    expect(source).toContain(`READ_ONLY_TRANSACTION_SQL = 'SET TRANSACTION READ ONLY'`);
    expect(READ_ONLY_TRANSACTION_SQL).toBe('SET TRANSACTION READ ONLY');
    expect(TRUSTED_FACTS_CALLERS).toEqual(['SERVER_REQUEST_GATE', 'RUNTIME_MEMBER']);
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
      requiresCallerAllowlist: true,
      requiresExplicitMonetaryAction: true,
      failsClosedOnAuthorizationConflict: true,
      supportsExpectedFactVersion: true,
      allReadsInsideReadOnlyTransaction: true,
    });
  });
});
