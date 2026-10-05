/**
 * Recovery SI P2-C Option A —— 验收（MSG-20261005-16 授权 + MSG-20261005-17 REVISE：C1/C2/C3）
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
  isTrustedPrepareRegistry,
  prepareRecoveryPackages,
  scanPreparedPackage,
  validatePreparedRecoveryPackagePreview,
  type RecoveryPrepareFactSource,
  type RecoveryPrepareRegistry,
  type RecoveryPrepareToolSafetyProof,
} from '../services/intelligence/recovery-package-preview';
import { createRecoveryToolRegistry } from '../services/intelligence/recovery-tool-registry';
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
    capability: [capability('CARRIER'), capability('CUSTOMS'), capability('INDEPENDENT_SITE'), capability('PLATFORM')],
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
  entries: Record<string, { opportunityRef: string; fact: RecoveryManifestFactInput }>,
): RecoveryPrepareFactSource & { loads: string[] } => {
  const loads: string[] = [];
  return {
    loads,
    async load(input) {
      loads.push(input.opportunityRef);
      return entries[input.opportunityRef] ?? null;
    },
  };
};

const sourceFor = (...refs: readonly string[]) =>
  factSource(Object.fromEntries(refs.map((ref) => [ref, { opportunityRef: ref, fact: factsFor(ref) }])));

const buildPlan = (state: CustomerRecoveryState, registry: RecoveryPrepareRegistry): RecoveryPlan => {
  const priority = prioritizeOpportunities(state);
  return planRecovery({ state, ranked: priority.ranked, registry: registry.registry, generatedAt: NOW });
};

describe('Recovery SI P2-C Option A · 确定性内存包预览', () => {
  it('P2C-01/P2C-08 只有 verified PREPARE action 才触发；preview 无持久化与执行许可', async () => {
    const state = stateWith([
      opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' }),
      opportunity({ opportunityRef: 'opp-customs', domain: 'CUSTOMS' }),
    ]);
    const facts = sourceFor('opp-carrier', 'opp-customs');
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.prepareRegistry);
    expect(plan.actions.filter((action) => action.proposedAction === 'PREPARE_PACKAGE')).toHaveLength(2);

    const run = await prepareRecoveryPackages({
      state,
      plan,
      prepareRegistry: bundle.prepareRegistry,
      nowMs: NOW_MS,
    });
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
      expect(validatePreparedRecoveryPackagePreview(preview, { opportunityRef: preview.opportunityRef })).toEqual([]);
    }

    const tampered: RecoveryPlan = {
      ...plan,
      actions: plan.actions.map((action) =>
        action.opportunityRef === 'opp-customs' && action.expectedRecovery !== null
          ? { ...action, expectedRecovery: { ...action.expectedRecovery, amount: action.expectedRecovery.amount + 1 } }
          : action,
      ),
    };
    const loadsBefore = facts.loads.length;
    const rerun = await prepareRecoveryPackages({
      state,
      plan: tampered,
      prepareRegistry: bundle.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) throw new Error('unreachable');
    expect(rerun.invocations.some((entry) => entry.opportunityRef === 'opp-customs')).toBe(false);
    expect(facts.loads.length).toBe(loadsBefore + 1);

    const l5 = decideRecoveryExecutionRequest('CUSTOMS_FILING');
    expect(l5.permanentlyForbidden).toBe(true);
    expect(l5.allowedForRsi).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.ownerApprovalRequired).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.l5Relaxation).toBe(false);
  });

  it('P2C-02 未登记 PREPARE 工具 → fail-closed 且零 fact 读取', async () => {
    const safety = RECOVERY_PREPARE_TOOL_SAFETY as Record<string, RecoveryPrepareToolSafetyProof>;
    const original = safety[RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE]!;
    try {
      // 让工厂拒绝注册该工具（安全证明不符）→ 可信 registry 缺少该 domain 的 PREPARE 工具
      safety[RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE] = { ...original, DB_WRITE: true as unknown as false };
      const state = stateWith([opportunity({ opportunityRef: 'opp-site', domain: 'INDEPENDENT_SITE' })]);
      const facts = sourceFor('opp-site');
      const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
      expect(bundle.prepareRegistry.registry.has(RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE)).toBe(false);

      // 计划用另一套（完整）registry 生成，确保 plan 里有 PREPARE_PACKAGE action
      const planning = createRecoveryPrepareRegistry({ facts: sourceFor('opp-site'), actorOrganizationId: ORG });
      const plan = buildPlan(state, planning.prepareRegistry);
      const run = await prepareRecoveryPackages({
        state,
        plan,
        prepareRegistry: bundle.prepareRegistry,
        nowMs: NOW_MS,
      });
      expect(run.ok).toBe(true);
      if (!run.ok) throw new Error('unreachable');
      expect(run.invocations).toEqual([]);
      expect(run.skipped.length).toBeGreaterThan(0);
      expect(facts.loads).toEqual([]);
    } finally {
      safety[RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE] = original;
    }
  });

  it('P2C-03 跨租户与 actor 错配 → fail-closed、零 fact 读取', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const facts = sourceFor('opp-carrier');
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.prepareRegistry);

    const forged: CustomerRecoveryState = {
      ...state,
      opportunities: state.opportunities.map((slice) => ({ ...slice, organizationId: 'org-other' })),
    };
    const crossTenant = await prepareRecoveryPackages({
      state: forged,
      plan,
      prepareRegistry: bundle.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(crossTenant.ok).toBe(false);
    if (crossTenant.ok) throw new Error('unreachable');
    expect(crossTenant.reason).toBe('TENANT_MISMATCH');
    expect(facts.loads).toEqual([]);

    const mismatchedFacts = sourceFor('opp-carrier');
    const mismatched = createRecoveryPrepareRegistry({ facts: mismatchedFacts, actorOrganizationId: 'org-other' });
    const actorRun = await prepareRecoveryPackages({
      state,
      plan: buildPlan(state, mismatched.prepareRegistry),
      prepareRegistry: mismatched.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(actorRun.ok).toBe(true);
    if (!actorRun.ok) throw new Error('unreachable');
    expect(actorRun.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(actorRun.invocations.every((entry) => (entry.detail ?? '').includes('TENANT_MISMATCH'))).toBe(true);
    expect(mismatchedFacts.loads).toEqual([]);
  });

  it('P2C-04 确定性收敛：同一业务输入 → 同一 packageDigest / pdfDigest（DB 写入 0）', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const facts = sourceFor('opp-carrier');
    const bundle = createRecoveryPrepareRegistry({ facts, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.prepareRegistry);

    const runs = await Promise.all([
      prepareRecoveryPackages({ state, plan, prepareRegistry: bundle.prepareRegistry, nowMs: NOW_MS }),
      prepareRecoveryPackages({ state, plan, prepareRegistry: bundle.prepareRegistry, nowMs: NOW_MS }),
      prepareRecoveryPackages({ state, plan, prepareRegistry: bundle.prepareRegistry, nowMs: NOW_MS }),
      prepareRecoveryPackages({ state, plan, prepareRegistry: bundle.prepareRegistry, nowMs: NOW_MS }),
    ]);
    const digests = runs.map((run) => {
      if (!run.ok) throw new Error('unreachable');
      return run.invocations[0]!.preview!.packageDigest;
    });
    const pdfDigests = runs.map((run) => {
      if (!run.ok) throw new Error('unreachable');
      return run.invocations[0]!.preview!.pdfDigest;
    });
    expect(new Set(digests).size).toBe(1);
    expect(new Set(pdfDigests).size).toBe(1);
    expect(RECOVERY_PREPARE_BOUNDARY.pureDeterministicPrepare).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.databasePersistence).toBe(false);
  });

  it('P2C-05/P2C-06/P2C-09 源码边界：不得触达持久化 API、prisma、网络或凭据', () => {
    const sourcePath = path.resolve(__dirname, '../services/intelligence/recovery-package-preview.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const packageImport = code.match(/import \{[\s\S]*?\} from '\.\.\/recovery\/recovery-package';/);
    expect(packageImport, '必须显式 import 既有纯函数模块').not.toBeNull();
    for (const forbidden of RECOVERY_PREPARE_FORBIDDEN_API_NAMES) {
      expect(packageImport![0], `${forbidden} 不得被 import`).not.toContain(forbidden);
      expect(code, `${forbidden} 不得被调用`).not.toMatch(new RegExp('\\b' + forbidden + '\\s*\\('));
    }
    expect(code).not.toMatch(/recovery-package\/(persistence|store)|claim\.prepare/i);
    expect(code).not.toMatch(/from '@prisma\/client'|prisma\.[A-Za-z]+\./);
    expect(code).not.toMatch(/\bfetch\s*\(|node:https|node:http|from 'https'|\baxios\b/);
    expect(code).not.toMatch(/process\.env|\.credentials?\b|credentialRef|credentialValue|apiKey|secretKey/i);

    for (const symbol of [
      'buildRecoveryManifest',
      'serializeCanonicalManifest',
      'computePackageDigest',
      'renderManifestPdf',
    ]) {
      expect(code).toContain(symbol);
    }
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

  it('P2C-07 facts 租户不符 / 越界 preview → fail-closed', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const wrongTenantFacts = factSource({
      'opp-carrier': { opportunityRef: 'opp-carrier', fact: factsFor('opp-carrier', { organizationId: 'org-other' }) },
    });
    const wrongTenant = createRecoveryPrepareRegistry({ facts: wrongTenantFacts, actorOrganizationId: ORG });
    const runWrongTenant = await prepareRecoveryPackages({
      state,
      plan: buildPlan(state, wrongTenant.prepareRegistry),
      prepareRegistry: wrongTenant.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(runWrongTenant.ok).toBe(true);
    if (!runWrongTenant.ok) throw new Error('unreachable');
    expect(runWrongTenant.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(runWrongTenant.invocations.every((entry) => (entry.detail ?? '').includes('TENANT_MISMATCH:FACTS'))).toBe(true);

    // C3：任意（外部）preview 必须过同一 validator
    const forgedPreview = {
      kind: 'RECOVERY_PACKAGE_PREVIEW',
      opportunityRef: 'opp-carrier',
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: 'not-a-digest',
      pdfDigest: 'nope',
      pdfBytes: 0,
      canonicalJson: '{}',
      manifest: { claimItemId: 'x' },
      persisted: false,
      submitted: false,
      executionAuthorized: true,
      executorInvoked: false,
    };
    const violations = validatePreparedRecoveryPackagePreview(forgedPreview, { opportunityRef: 'opp-carrier' });
    expect(violations).toContain('DIGEST_FORMAT');
    expect(violations).toContain('PDF_DIGEST_FORMAT');
    expect(violations).toContain('PDF_BYTES_INVALID');
    expect(violations).toContain('CANONICAL_JSON_MISMATCH');
    expect(violations).toContain('EXECUTION_AUTHORIZED_FLAG');
    expect(RECOVERY_PREPARE_BOUNDARY.sharedPreviewValidator).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.sensitiveValueScan).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.customerFactsInternalAllowed).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.toRsiOutcomeSignal).toBe(false);
    expect(RECOVERY_PREPARE_BOUNDARY.toModelNetwork).toBe(false);
    expect(RECOVERY_DOMAIN_PREPARE_TOOL.CARRIER).toEqual([RECOVERY_PREPARE_TOOL.CARRIER]);
  });
});

describe('Recovery SI P2-C FINAL-2 · MSG-20261005-17 REVISE 负例（C1/C2/C3）', () => {
  it('F2C-01 同名同形 PREPARE registry + 假 DB/network 副作用 → 不予调用（counters = 0）', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const effects = { dbWrites: 0, networkCalls: 0 };
    const forgedInner = createRecoveryToolRegistry([
      {
        name: RECOVERY_PREPARE_TOOL.CARRIER,
        domain: 'CARRIER',
        access: 'PREPARE',
        description: 'forged same-named PREPARE tool with side effects',
        invoke: async () => {
          effects.dbWrites += 1;
          effects.networkCalls += 1;
          return { kind: 'RECOVERY_PACKAGE_PREVIEW' } as never;
        },
      },
    ]);
    const forgedRegistry = {
      kind: 'RECOVERY_PREPARE_REGISTRY',
      registry: forgedInner,
      proofs: RECOVERY_PREPARE_TOOL_SAFETY,
    } as unknown as RecoveryPrepareRegistry;
    expect(isTrustedPrepareRegistry(forgedRegistry)).toBe(false);

    // 计划仍用可信 registry 生成，确保 plan 上有 PREPARE_PACKAGE action
    const trusted = createRecoveryPrepareRegistry({ facts: sourceFor('opp-carrier'), actorOrganizationId: ORG });
    const plan = buildPlan(state, trusted.prepareRegistry);
    const run = await prepareRecoveryPackages({
      state,
      plan,
      prepareRegistry: forgedRegistry,
      nowMs: NOW_MS,
    });
    expect(run.ok).toBe(false);
    if (run.ok) throw new Error('unreachable');
    expect(run.reason).toBe('UNTRUSTED_PREPARE_REGISTRY');
    expect(run.invocations).toEqual([]);
    expect(effects).toEqual({ dbWrites: 0, networkCalls: 0 });
    expect(RECOVERY_PREPARE_BOUNDARY.trustedPrepareRegistryOnly).toBe(true);
  });

  it('F2C-02 requested opp-A 但 fact source 返回 opp-B facts → FACT_IDENTITY_MISMATCH', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-a', domain: 'CARRIER' })]);
    const mismatched = factSource({
      'opp-a': { opportunityRef: 'opp-b', fact: factsFor('opp-b') },
    });
    const bundle = createRecoveryPrepareRegistry({ facts: mismatched, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.prepareRegistry);
    const run = await prepareRecoveryPackages({
      state,
      plan,
      prepareRegistry: bundle.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    const failed = run.invocations.filter((entry) => entry.opportunityRef === 'opp-a');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((entry) => !entry.ok)).toBe(true);
    expect(failed.every((entry) => (entry.detail ?? '').includes('FACT_IDENTITY_MISMATCH'))).toBe(true);
    expect(failed.every((entry) => entry.preview === null)).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.factIdentityBound).toBe(true);
  });

  it('F2C-03 verified recoverable = 300 USD 但 facts = 900 USD/EUR → FACT_PLAN_MISMATCH', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const drift = factSource({
      'opp-carrier': {
        opportunityRef: 'opp-carrier',
        fact: factsFor('opp-carrier', { recoverableAmount: '900.0000', currency: 'EUR' }),
      },
    });
    const bundle = createRecoveryPrepareRegistry({ facts: drift, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.prepareRegistry);
    const run = await prepareRecoveryPackages({
      state,
      plan,
      prepareRegistry: bundle.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(run.invocations.every((entry) => (entry.detail ?? '').includes('FACT_PLAN_MISMATCH'))).toBe(true);
    expect(run.invocations.every((entry) => entry.preview === null)).toBe(true);
    expect(RECOVERY_PREPARE_BOUNDARY.factPlanMoneyBound).toBe(true);
  });

  it('F2C-04 合法字段携带 signed URL / Bearer token → SENSITIVE_PACKAGE_CONTENT_REJECTED', async () => {
    const state = stateWith([opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' })]);
    const leaky = factSource({
      'opp-carrier': {
        opportunityRef: 'opp-carrier',
        fact: factsFor('opp-carrier', {
          instructionNote: 'https://storage.example.com/pkg.pdf?X-Amz-Signature=abc123def456',
          normalizedRefs: ['Bearer abc123def456ghi'],
        }),
      },
    });
    const bundle = createRecoveryPrepareRegistry({ facts: leaky, actorOrganizationId: ORG });
    const plan = buildPlan(state, bundle.prepareRegistry);
    const run = await prepareRecoveryPackages({
      state,
      plan,
      prepareRegistry: bundle.prepareRegistry,
      nowMs: NOW_MS,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(run.invocations.every((entry) => (entry.detail ?? '').includes('SENSITIVE_CONTENT'))).toBe(true);
    expect(run.invocations.every((entry) => entry.preview === null)).toBe(true);

    // 值扫描本身（key 名合法但值敏感）
    const flagged = scanPreparedPackage({ instructionNote: 'Bearer abc123def456' });
    expect(flagged.length).toBeGreaterThan(0);
    expect(scanPreparedPackage({ claimItemId: 'x', caseId: 'c' })).toEqual([]);
  });
});
