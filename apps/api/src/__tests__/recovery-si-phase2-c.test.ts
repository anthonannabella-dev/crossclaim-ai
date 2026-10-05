/**
 * Recovery SI P2-C Option A —— 验收（MSG-20261005-16：P2C-01..09）
 * 纯确定性内存包预览：零落库 / 零外写 / 零 submission / 零 provider / 零凭据。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCustomerRecoveryState,
  type CapabilitySlice,
  type CustomerRecoveryState,
  type OpportunitySlice,
} from '../services/intelligence/customer-recovery-state';
import { planRecovery, type RecoveryPlan } from '../services/intelligence/recovery-planner';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import { decideRecoveryExecutionRequest } from '../services/intelligence/recovery-policy';
import {
  RECOVERY_DOMAIN_PREPARE_TOOL,
  RECOVERY_PREPARE_BOUNDARY,
  RECOVERY_PREPARE_FORBIDDEN_API_NAMES,
  RECOVERY_PREPARE_TOOL,
  RECOVERY_PREPARE_TOOL_SAFETY,
  createRecoveryPrepareRegistry,
  prepareRecoveryPackages,
  scanPreparedPackage,
  type RecoveryPrepareFactSource,
} from '../services/intelligence/recovery-package-preview';
import { createRecoveryToolRegistry, type RecoveryToolRegistry } from '../services/intelligence/recovery-tool-registry';
import {
  generateRecoveryPackage,
  persistPackageArtifacts,
  transitionRecoveryPackage,
  type RecoveryManifestFactInput,
} from '../services/recovery/recovery-package';

const NOW = '2026-10-05T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ORG = 'org-p2c';

const opportunity = (over: Partial<OpportunitySlice> = {}): OpportunitySlice => ({
  opportunityRef: 'opp-1',
  domain: 'CARRIER',
  organizationId: ORG,
  recoverable: { amount: 300, currency: 'USD', source: 'CANONICAL_FACT' },
  eligibility: 'ELIGIBLE',
  evidenceComplete: true,
  missingEvidence: [],
  authorizationReady: true,
  deadline: '2026-11-01T00:00:00.000Z',
  providerCostUsd: 0,
  expectedOperationalCostUsd: 0,
  riskClass: 'LOW',
  observedAt: NOW,
  ...over,
});

const capability = (domain: CapabilitySlice['domain']): CapabilitySlice => ({
  domain,
  readOnlyTools: [],
  providerApproval: 'READY',
});

const stateWith = (opportunities: readonly OpportunitySlice[]): CustomerRecoveryState => {
  const result = buildCustomerRecoveryState({
    organizationId: ORG,
    observedAt: NOW,
    opportunities,
    capability: [capability('CARRIER'), capability('CUSTOMS')],
  });
  if (!result.ok) throw new Error(`fixture tenant mismatch: ${result.offendingRef}`);
  return result.state;
};

const factsFor = (opportunityRef: string, over: Partial<RecoveryManifestFactInput> = {}): RecoveryManifestFactInput => ({
  organizationId: ORG,
  claimItemId: `claim-item-${opportunityRef}`,
  caseId: 'case-1',
  platformType: 'CARRIER',
  claimType: 'OVERCHARGE',
  normalizedRefs: [`SHIP-${opportunityRef}`],
  currency: 'USD',
  amountExpected: '1200.0000',
  amountActual: '900.0000',
  recoverableAmount: '300.0000',
  occurredAt: NOW,
  responsibleParty: 'carrier',
  evidence: [{ evidenceId: `ev-${opportunityRef}`, evidenceType: 'INVOICE', capturedAt: NOW }],
  ...over,
});

const factSource = (
  facts: Record<string, RecoveryManifestFactInput>,
): RecoveryPrepareFactSource & { loads: string[] } => {
  const loads: string[] = [];
  return {
    loads,
    async load(input) {
      loads.push(input.opportunityRef);
      return facts[input.opportunityRef] ?? null;
    },
  };
};

const buildPlan = (state: CustomerRecoveryState, registry: RecoveryToolRegistry): RecoveryPlan => {
  const priority = prioritizeOpportunities(state);
  return planRecovery({ state, ranked: priority.ranked, registry, generatedAt: NOW });
};

describe('Recovery SI P2-C Option A · 确定性内存包预览', () => {
  it('P2C-01/P2C-08 只有 verified PREPARE action 才触发；返回预览无持久化与执行许可', async () => {
    const state = stateWith([
      opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' }),
      opportunity({ opportunityRef: 'opp-customs', domain: 'CUSTOMS' }),
    ]);
    const facts = factSource({
      'opp-carrier': factsFor('opp-carrier'),
      'opp-customs': factsFor('opp-customs'),
    });
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.registry);
    expect(plan.actions.filter((action) => action.proposedAction === 'PREPARE_PACKAGE')).toHaveLength(2);

    const run = await prepareRecoveryPackages({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations).toHaveLength(2);
    expect(run.invocations.every((entry) => entry.ok)).toBe(true);
    for (const invocation of run.invocations) {
      const preview = invocation.preview!;
      expect(preview.kind).toBe('RECOVERY_PACKAGE_PREVIEW');
      expect(preview.opportunityRef).toBe(invocation.opportunityRef);
      expect(preview.persisted).toBe(false);
      expect(preview.submitted).toBe(false);
      expect(preview.executionAuthorized).toBe(false);
      expect(preview.executorInvoked).toBe(false);
      expect(preview.packageDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.pdfDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.pdfBytes).toBeGreaterThan(0);
    }

    // 篡改 plan → 入口内重新 verify → 受影响 action 零调用
    const tampered: RecoveryPlan = {
      ...plan,
      actions: plan.actions.map((action) =>
        action.opportunityRef === 'opp-customs' && action.expectedRecovery !== null
          ? { ...action, expectedRecovery: { ...action.expectedRecovery, amount: action.expectedRecovery.amount + 1 } }
          : action,
      ),
    };
    const loadsBefore = facts.loads.length;
    const rerun = await prepareRecoveryPackages({ state, plan: tampered, registry: bundle.registry, nowMs: NOW_MS });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error('unreachable');
    expect(rerun.invocations.some((entry) => entry.opportunityRef === 'opp-customs')).toBe(false);
    expect(facts.loads.length).toBe(loadsBefore + 1); // 仅 opp-carrier 仍被加载

    // P2C-08：L5 永久拒绝 + PREPARE 不产生执行许可
    const l5 = decideRecoveryExecutionRequest('CUSTOMS_FILING');
    expect(l5.permanentlyForbidden).toBe(true);
    expect(l5.allowedForRsi).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.ownerApprovalRequired).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.l5Relaxation).toBe(false);
  });

  it('P2C-02 未登记 PREPARE 工具 → fail-closed 且零 fact 读取', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const facts = factSource({ 'opp-carrier': factsFor('opp-carrier') });
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.registry);

    const partial: RecoveryToolRegistry = {
      list: () => bundle.registry.list().filter((entry) => entry.name !== RECOVERY_PREPARE_TOOL.CARRIER),
      has: (name) => name !== RECOVERY_PREPARE_TOOL.CARRIER && bundle.registry.has(name),
      invoke: (name, inputValue, ctx) => bundle.registry.invoke(name, inputValue, ctx),
    };
    const run = await prepareRecoveryPackages({ state, plan, registry: partial, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations).toEqual([]);
    expect(run.skipped.length).toBeGreaterThan(0);
    expect(facts.loads).toEqual([]);
  });

  it('P2C-03 跨租户与 actor 错配 → fail-closed、零 fact 读取', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const facts = factSource({ 'opp-carrier': factsFor('opp-carrier') });
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.registry);

    const forged: CustomerRecoveryState = {
      ...state,
      opportunities: state.opportunities.map((slice) => ({ ...slice, organizationId: 'org-other' })),
    };
    const crossTenant = await prepareRecoveryPackages({ state: forged, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(crossTenant.ok).toBe(false);
    if (crossTenant.ok) throw new Error('unreachable');
    expect(crossTenant.reason).toBe('TENANT_MISMATCH');
    expect(crossTenant.invocations).toEqual([]);
    expect(facts.loads).toEqual([]);

    const mismatched = createRecoveryPrepareRegistry({ facts, actorOrganizationId: 'org-other' });
    const actorRun = await prepareRecoveryPackages({
      state,
      plan: buildPlan(state, mismatched.registry),
      registry: mismatched.registry,
      nowMs: NOW_MS,
    });
    expect(actorRun.ok).toBe(true);
    if (!actorRun.ok) throw new Error('unreachable');
    expect(actorRun.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(actorRun.invocations.every((entry) => (entry.detail ?? '').includes('TENANT_MISMATCH'))).toBe(true);
    expect(facts.loads).toEqual([]);
  });

  it('P2C-04 确定性收敛：同一业务输入 → 同一 packageDigest / pdfDigest（DB 写入 0）', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const facts = factSource({ 'opp-carrier': factsFor('opp-carrier') });
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.registry);

    const first = await prepareRecoveryPackages({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    const second = await prepareRecoveryPackages({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    const [third, fourth] = await Promise.all([
      prepareRecoveryPackages({ state, plan, registry: bundle.registry, nowMs: NOW_MS }),
      prepareRecoveryPackages({ state, plan, registry: bundle.registry, nowMs: NOW_MS }),
    ]);
    const digests = [first, second, third, fourth].map((run) => {
      if (!run.ok) throw new Error('unreachable');
      return run.invocations[0]!.preview!.packageDigest;
    });
    expect(new Set(digests).size).toBe(1);
    const pdfDigests = [first, second, third, fourth].map((run) => {
      if (!run.ok) throw new Error('unreachable');
      return run.invocations[0]!.preview!.pdfDigest;
    });
    expect(new Set(pdfDigests).size).toBe(1);
    // 纯函数模式：没有 DB identity / unique constraint / 并发唯一赢家要求
    expect(RECOVERY_PREPARE_BOUNDARY.pureDeterministicPrepare).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.databasePersistence).toBe(false);
  });

  it('P2C-05/P2C-06/P2C-09 源码边界：不得触达持久化 API、prisma、网络或凭据', () => {
    const sourcePath = path.resolve(__dirname, '../services/intelligence/recovery-package-preview.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    // 只扫描“代码”（注释里可以讨论被禁 API；实现里不行）
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // P2C-09：禁止的持久化 API 不可达（未 import、未被调用）
    const packageImport = code.match(/import \{[\s\S]*?\} from '\.\.\/recovery\/recovery-package';/);
    expect(packageImport, '必须显式 import 既有纯函数模块').not.toBeNull();
    for (const forbidden of RECOVERY_PREPARE_FORBIDDEN_API_NAMES) {
      expect(packageImport![0], `${forbidden} 不得被 import`).not.toContain(forbidden);
      expect(code, `${forbidden} 不得被调用`).not.toMatch(new RegExp('\\b' + forbidden + '\\s*\\('));
    }
    expect(code).not.toMatch(/recovery-package\/(persistence|store)|claim\.prepare/i);
    // P2C-05：零 DB
    expect(code).not.toMatch(/from '@prisma\/client'|prisma\.[A-Za-z]+\./);
    // P2C-06：零网络 / 零凭据
    expect(code).not.toMatch(/\bfetch\s*\(|node:https|node:http|from 'https'|\baxios\b/);
    // 允许出现 `CREDENTIAL_READ: false` / `credentialReads: 0` 这类“声明式否定”，但不得有真实读取
    expect(code).not.toMatch(/process\.env|\.credentials?\b|credentialRef|credentialValue|apiKey|secretKey/i);

    // 只复用纯函数（且这些纯函数确实存在于既有模块）
    expect(code).toContain('buildRecoveryManifest');
    expect(code).toContain('serializeCanonicalManifest');
    expect(code).toContain('computePackageDigest');
    expect(code).toContain('renderManifestPdf');
    expect(typeof generateRecoveryPackage).toBe('function');
    expect(typeof persistPackageArtifacts).toBe('function');
    expect(typeof transitionRecoveryPackage).toBe('function');

    expect(RECOVERY_PREPARE_BOUNDARY.databasePersistence).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.recoveryPackageDbCreate).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.fileAssetCreate).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.claimDraftDbMutation).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.auditLogWrite).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.networkCalls).toBe(0);
    expect(RECOVERY_PREPARE_BOUNDARY.credentialReads).toBe(0);
    for (const name of Object.values(RECOVERY_PREPARE_TOOL)) {
      expect(RECOVERY_PREPARE_TOOL_SAFETY[name]).toEqual({
        PURE_DETERMINISTIC: true,
        DB_WRITE: false,
        NETWORK: false,
        CREDENTIAL_READ: false,
        TENANT_SCOPED: true,
        PERSISTS_PACKAGE: false,
      });
    }
  });

  it('P2C-07 输出身份 / 授权标记 / 敏感内容越界 → fail-closed', async () => {
    // (a) facts 属于其它租户 → TENANT_MISMATCH:FACTS，零预览
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const wrongTenantFacts = factSource({
      'opp-carrier': factsFor('opp-carrier', { organizationId: 'org-other' }),
    });
    const wrongTenant = createRecoveryPrepareRegistry({ facts: wrongTenantFacts, actorOrganizationId: ORG });
    const runWrongTenant = await prepareRecoveryPackages({
      state,
      plan: buildPlan(state, wrongTenant.registry),
      registry: wrongTenant.registry,
      nowMs: NOW_MS,
    });
    expect(runWrongTenant.ok).toBe(true);
    if (!runWrongTenant.ok) throw new Error('unreachable');
    expect(runWrongTenant.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(runWrongTenant.invocations.every((entry) => (entry.detail ?? '').includes('TENANT_MISMATCH:FACTS'))).toBe(true);

    // (b) miswired tool 返回别人的 opportunityRef 或 executionAuthorized=true → 入口拒绝
    const miswired: RecoveryToolRegistry = createRecoveryToolRegistry([
      {
        name: RECOVERY_PREPARE_TOOL.CARRIER,
        domain: 'CARRIER',
        access: 'PREPARE',
        description: 'miswired fixture',
        invoke: async () =>
          ({
            kind: 'RECOVERY_PACKAGE_PREVIEW',
            opportunityRef: 'opp-someone-else',
            persisted: false,
            submitted: false,
            executionAuthorized: false,
            executorInvoked: false,
          }) as unknown as never,
      },
      {
        name: RECOVERY_PREPARE_TOOL.PLATFORM,
        domain: 'PLATFORM',
        access: 'PREPARE',
        description: 'authorized-flag fixture',
        invoke: async () =>
          ({
            kind: 'RECOVERY_PACKAGE_PREVIEW',
            opportunityRef: 'opp-carrier',
            persisted: false,
            submitted: false,
            executionAuthorized: true,
            executorInvoked: false,
          }) as unknown as never,
      },
    ]);
    const miswiredRun = await prepareRecoveryPackages({
      state,
      plan: buildPlan(state, miswired),
      registry: miswired,
      nowMs: NOW_MS,
    });
    expect(miswiredRun.ok).toBe(true);
    if (!miswiredRun.ok) throw new Error('unreachable');
    expect(miswiredRun.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(miswiredRun.invocations.every((entry) => entry.detail === 'PREVIEW_IDENTITY_OR_AUTHORIZATION_INVALID')).toBe(true);

    // (c) 敏感字段扫描：storage key / signed URL 等命中即拒绝
    const flagged = scanPreparedPackage({ manifest: { claimItemId: 'x' }, signedUrl: 'https://x', storageKey: 'k' });
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    expect(scanPreparedPackage({ claimItemId: 'x', caseId: 'c' })).toEqual([]);
    expect(RECOVERY_PREPARE_BOUNDARY.customerFactsInternalAllowed).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.toRsiOutcomeSignal).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.toModelNetwork).toBe(false);
    expect(RECOVERY_DOMAIN_PREPARE_TOOL.CARRIER).toEqual([RECOVERY_PREPARE_TOOL.CARRIER]);
  });
});
