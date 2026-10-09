/**
 * PHASE 3-A — U1：只读权威可信事实适配器 → 端口级单元测试（CHANGE 17–20 + CHANGE 24 修订版）
 * 授权：MSG-20261009-14（U1_READ_ONLY_SUBSET）+ MSG-20261009-15（CHANGE 17–20）+ MSG-20261009-16（CHANGE 24–25）
 * 覆盖：授权唯一性 / 多授权冲突 fail-closed、服务端范围策略与必需维度、金额与币种显式规则、
 *       调用方边界与版本失效、只读事务包裹全部读取、单授权错误范围 fail-closed、
 *       静态来源断言（不接受候选载荷 / 模型输出，唯一原生 SQL 为只读语句）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  READ_ONLY_TRANSACTION_SQL,
  TRUSTED_FACTS_ACTION_SCOPE_POLICY,
  TRUSTED_FACTS_ADAPTER_BOUNDARY,
  TRUSTED_FACTS_CALLERS,
  TRUSTED_FACTS_SCOPE_DIMENSIONS,
  checkScopeDeclaration,
  createTrustedFactsAdapter,
  exceedsMonetaryLimit,
  type StandingAuthorizationRecord,
  type TrustedFactsReadPort,
  type TrustedFactsResourceScope,
  type TrustedFactsScopeDimension,
} from '../services/self-repair/trusted-facts-adapter';

const AT = new Date('2026-10-09T03:00:00.000Z');

const org = { id: 'org-u1', identityVersion: 'idv-1' };
/** 策略要求的必需维度（platformAccountId + provider）齐备的可信范围 */
const TRUSTED_SCOPE: TrustedFactsResourceScope = {
  platformAccountId: 'acct-1',
  provider: 'AMAZON',
  domain: 'LOGISTICS',
  jurisdiction: 'US',
};

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
          return await run(undefined as never);
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
  options: {
    caller?: string;
    recheck?: 'CONFIRMED_READ_ONLY' | 'NOT_CONFIRMED';
    scope?: TrustedFactsResourceScope;
    notApplicable?: readonly TrustedFactsScopeDimension[];
  } = {},
) =>
  createTrustedFactsAdapter({
    readPort,
    executionContext: {
      subjectRef: 'runtime-member-1',
      caller: options.caller ?? 'RUNTIME_MEMBER',
      operationRecheck: options.recheck ?? 'CONFIRMED_READ_ONLY',
      resourceScope: 'scope' in options ? options.scope : TRUSTED_SCOPE,
      notApplicableScopeDimensions: options.notApplicable,
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
  scope?: TrustedFactsResourceScope;
  notApplicable?: readonly TrustedFactsScopeDimension[];
  reason: string;
}

const failureCases: FailureCase[] = [
  { label: '缺 organizationId（无法判定租户上下文）', request: { ...base, organizationId: '' }, reason: 'TENANT_CONTEXT_REQUIRED' },
  { label: '调用方不在白名单（MODEL）', request: base, caller: 'MODEL', reason: 'CALLER_NOT_TRUSTED' },
  { label: '调用方不在白名单（BUILDER）', request: base, caller: 'BUILDER', reason: 'CALLER_NOT_TRUSTED' },
  { label: '调用方不在白名单（CLIENT）', request: base, caller: 'CLIENT', reason: 'CALLER_NOT_TRUSTED' },
  { label: '调用方为空', request: base, caller: '   ', reason: 'CALLER_NOT_TRUSTED' },
  { label: '动作类型无服务端范围策略', request: { ...base, actionType: 'unknown.action' }, reason: 'SCOPE_POLICY_NOT_DEFINED' },
  { label: '可信范围整体缺失', request: base, scope: undefined, reason: 'REQUIRED_SCOPE_MISSING' },
  { label: '必需维度缺失（platformAccountId）', request: base, scope: { provider: 'AMAZON' }, reason: 'REQUIRED_SCOPE_MISSING' },
  { label: '必需维度缺失（provider）', request: base, scope: { platformAccountId: 'acct-1' }, reason: 'REQUIRED_SCOPE_MISSING' },
  {
    label: '必需维度为空串',
    request: base,
    scope: { platformAccountId: 'acct-1', provider: '   ' },
    reason: 'REQUIRED_SCOPE_MISSING',
  },
  {
    label: 'CHANGE 27：可选维度整体省略且未声明不适用（不得靠「没传」放大范围）',
    request: base,
    scope: { platformAccountId: 'acct-1', provider: 'AMAZON' },
    reason: 'OPTIONAL_SCOPE_UNDECLARED',
  },
  {
    label: 'CHANGE 27：仅省略一个可选维度（jurisdiction）且未声明不适用',
    request: base,
    scope: { platformAccountId: 'acct-1', provider: 'AMAZON', domain: 'LOGISTICS' },
    reason: 'OPTIONAL_SCOPE_UNDECLARED',
  },
  {
    label: 'CHANGE 27：必需维度被声明为不适用',
    request: base,
    scope: { platformAccountId: 'acct-1' },
    notApplicable: ['provider'],
    reason: 'REQUIRED_SCOPE_MISSING',
  },
  {
    label: 'CHANGE 27：同一维度既提供又声明不适用（声明冲突）',
    request: base,
    notApplicable: ['jurisdiction'],
    reason: 'SCOPE_DECLARATION_CONFLICT',
  },
  { label: '组织不存在', request: { ...base, organizationId: 'missing' }, overrides: { org: null }, reason: 'ORGANIZATION_NOT_FOUND' },
  { label: '该组织无任何授权行', request: base, overrides: { auths: [] }, reason: 'AUTHORIZATION_NOT_FOUND' },
  {
    label: '单授权但 Provider 不匹配',
    request: base,
    scope: { ...TRUSTED_SCOPE, provider: 'SHOPIFY' },
    reason: 'AUTHORIZATION_NOT_FOUND',
  },
  {
    label: '单授权但账户不匹配',
    request: base,
    scope: { ...TRUSTED_SCOPE, platformAccountId: 'acct-other' },
    reason: 'AUTHORIZATION_NOT_FOUND',
  },
  {
    label: '单授权但可选维度 jurisdiction 不匹配',
    request: base,
    scope: { ...TRUSTED_SCOPE, jurisdiction: 'JP' },
    reason: 'AUTHORIZATION_NOT_FOUND',
  },
  {
    label: '单授权但可选维度 domain 不匹配',
    request: base,
    scope: { ...TRUSTED_SCOPE, domain: 'FINANCE' },
    reason: 'AUTHORIZATION_NOT_FOUND',
  },
  {
    label: '可选维度提供了空串（视为未提供且未声明不适用）',
    request: base,
    scope: { ...TRUSTED_SCOPE, jurisdiction: '  ' },
    reason: 'OPTIONAL_SCOPE_UNDECLARED',
  },
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
    label: '多授权冲突（同范围两条有效记录）',
    request: base,
    overrides: { auths: [auth(), auth({ authorizationId: 'auth-2', authorizationVersion: 8 })] },
    reason: 'AUTHORIZATION_AMBIGUOUS',
  },
  { label: '动作类型不在授权范围', request: { ...base, actionType: 'payment.capture' }, reason: 'SCOPE_POLICY_NOT_DEFINED' },
  {
    label: '策略内动作但授权行不允许该动作',
    request: { ...base, actionType: 'internal.repair.propose' },
    overrides: { auths: [auth({ allowedActionTypes: ['recovery.read'] })] },
    reason: 'ACTION_TYPE_NOT_ALLOWED',
  },
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

describe('PHASE 3-A / U1 可信事实适配器（只读、CHANGE 17–20 + 24）', () => {
  it('可信事实齐备 ⇒ 返回 facts 与 provenance（含 authorizationId / caller / scopePolicy / readScope）', async () => {
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
    expect(result.provenance.scopePolicy).toEqual({
      source: 'SERVER_ACTION_POLICY',
      actionType: 'recovery.read',
      required: ['platformAccountId', 'provider'],
      optional: ['domain', 'jurisdiction'],
      providedDimensions: ['provider', 'platformAccountId', 'domain', 'jurisdiction'],
      notApplicableDimensions: [],
      resolvedAt: AT.toISOString(),
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

  it('CHANGE 27：可选维度省略但由服务端显式声明不适用 ⇒ 通过，且 provenance 留痕', async () => {
    const matched = await adapter(makePort().readPort, {
      scope: { platformAccountId: 'acct-1', provider: 'AMAZON' },
      notApplicable: ['domain', 'jurisdiction'],
    }).resolve({ ...base, expectedFactVersion: 'org:idv-1|auth:7' });
    expect(matched.ok).toBe(true);
    if (!matched.ok) throw new Error('expected ok');
    expect(matched.provenance.scopePolicy.providedDimensions).toEqual(['provider', 'platformAccountId']);
    expect(matched.provenance.scopePolicy.notApplicableDimensions).toEqual(['domain', 'jurisdiction']);
    expect(matched.provenance.scopePolicy.required).toEqual(['platformAccountId', 'provider']);
  });

  it('CHANGE 27：请求侧夹带 resourceScope 不影响结果（范围只取可信上下文）', async () => {
    const smuggled = await adapter(makePort().readPort).resolve({
      ...base,
      resourceScope: { provider: 'SHOPIFY', platformAccountId: 'acct-attacker' },
    } as never);
    expect(smuggled.ok).toBe(true);
    if (!smuggled.ok) throw new Error('expected ok');
    // 实际参与匹配的仍是可信上下文提供的维度与值（provider=AMAZON / acct-1），请求夹带被忽略
    expect(smuggled.provenance.scopePolicy.providedDimensions).toEqual([
      'provider',
      'platformAccountId',
      'domain',
      'jurisdiction',
    ]);
    expect(smuggled.provenance.authorizationActive?.authorizationId).toBe('auth-1');

    // 请求夹带也不能替代可信上下文的必需维度：可信范围缺失时依旧 fail-closed
    const missing = await adapter(makePort().readPort, { scope: { provider: 'AMAZON' } }).resolve({
      ...base,
      resourceScope: { platformAccountId: 'acct-1' },
    } as never);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('REQUIRED_SCOPE_MISSING');
  });

  it.each(failureCases)('$label ⇒ fail-closed（$reason）', async (testCase) => {
    const { readPort } = makePort(testCase.overrides);
    const result = await adapter(readPort, {
      caller: testCase.caller,
      recheck: testCase.recheck,
      ...('scope' in testCase ? { scope: testCase.scope } : {}),
      ...('notApplicable' in testCase ? { notApplicable: testCase.notApplicable } : {}),
    }).resolve(testCase.request as never);
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

  it('CHANGE 24/27：策略与范围声明检查（缺失 / 空串 / 未声明省略 / 声明冲突）', () => {
    expect(TRUSTED_FACTS_ACTION_SCOPE_POLICY['recovery.read']?.required).toEqual(['platformAccountId', 'provider']);
    expect(TRUSTED_FACTS_ACTION_SCOPE_POLICY['recovery.read']?.optional).toEqual(['domain', 'jurisdiction']);
    expect(TRUSTED_FACTS_SCOPE_DIMENSIONS).toEqual(['provider', 'platformAccountId', 'domain', 'jurisdiction']);
    const policy = { required: ['platformAccountId', 'provider'] as const, optional: ['domain', 'jurisdiction'] as const };

    expect(checkScopeDeclaration(policy, undefined, undefined)).toEqual({ ok: false, reason: 'REQUIRED_SCOPE_MISSING' });
    expect(
      checkScopeDeclaration(policy, { platformAccountId: '', provider: 'AMAZON' }, ['domain', 'jurisdiction']),
    ).toEqual({ ok: false, reason: 'REQUIRED_SCOPE_MISSING' });
    // 可选维度省略且未声明不适用 ⇒ 拒绝（不得靠「没传」放大范围）
    expect(
      checkScopeDeclaration(policy, { platformAccountId: 'acct-1', provider: 'AMAZON' }, undefined),
    ).toEqual({ ok: false, reason: 'OPTIONAL_SCOPE_UNDECLARED' });
    // 显式声明不适用 ⇒ 通过并留痕
    expect(
      checkScopeDeclaration(policy, { platformAccountId: 'acct-1', provider: 'AMAZON' }, ['domain', 'jurisdiction']),
    ).toEqual({
      ok: true,
      providedDimensions: ['provider', 'platformAccountId'],
      notApplicableDimensions: ['domain', 'jurisdiction'],
    });
    // 既提供又声明不适用 ⇒ 冲突
    expect(
      checkScopeDeclaration(
        policy,
        { platformAccountId: 'acct-1', provider: 'AMAZON', jurisdiction: 'US' },
        ['jurisdiction'],
      ),
    ).toEqual({ ok: false, reason: 'SCOPE_DECLARATION_CONFLICT' });
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
      requiresServerScopePolicy: true,
      requiresTrustedResourceScope: true,
      scopeValuesFromTrustedContextOnly: true,
      requiresExplicitNotApplicableDeclaration: true,
      scopeOmissionCannotWidenMatch: true,
    });
  });
});
