/**
 * Recovery SI —— 统一只读客户恢复状态（Phase 1）
 * ---------------------------------------------------------------
 * 授权：HOST《CrossClaim Recovery SI Control Layer》。复用审计见
 * `docs/releases/RECOVERY-SI-REUSE-MATRIX.md`，架构见 `docs/releases/RECOVERY-SI-ARCHITECTURE.md`。
 *
 * 硬规则（Phase 1）：
 *   · **只读聚合**：不修改 Canonical Fact、不重算 money truth、不编造客户事实、不读 provider secret；
 *   · **tenant-scoped**：任何跨租户切片一律 `TENANT_MISMATCH`（fail-closed，不降级）；
 *   · **金额必须来自持久化事实**：`recoverable.source !== 'CANONICAL_FACT' | 'PERSISTED_ESTIMATE'` 时
 *     该金额被丢弃（记入 `droppedMoneyRefs`），绝不用 LLM/估算补位；
 *   · 每条切片携带 `observedAt`，供 planner/verifier 做陈旧性判定。
 */

export const RECOVERY_DOMAINS = ['PLATFORM', 'CARRIER', 'CUSTOMS', 'INDEPENDENT_SITE'] as const;
export type RecoveryDomain = (typeof RECOVERY_DOMAINS)[number];

export const RECOVERY_MONEY_SOURCES = ['CANONICAL_FACT', 'PERSISTED_ESTIMATE', 'UNKNOWN'] as const;
export type RecoveryMoneySource = (typeof RECOVERY_MONEY_SOURCES)[number];

export interface RecoveryMoney {
  amount: number;
  currency: string;
  source: RecoveryMoneySource;
}

export const RECOVERY_ELIGIBILITY = ['ELIGIBLE', 'NOT_ELIGIBLE', 'INDETERMINATE'] as const;
export type RecoveryEligibility = (typeof RECOVERY_ELIGIBILITY)[number];

export interface OpportunitySlice {
  opportunityRef: string;
  domain: RecoveryDomain;
  organizationId: string;
  recoverable: RecoveryMoney | null;
  eligibility: RecoveryEligibility;
  evidenceComplete: boolean;
  missingEvidence: readonly string[];
  authorizationReady: boolean;
  /** ISO 或 null（无截止日不得编造） */
  deadline: string | null;
  /** 供应商/API 成本（USD 记账口径；无来源时置 0 并记 reasonCode） */
  providerCostUsd: number;
  expectedOperationalCostUsd: number;
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
  observedAt: string;
}

export interface CapabilitySlice {
  domain: RecoveryDomain;
  /** 该域已就绪的**只读/规划类**工具名（Phase 1 不含执行类） */
  readOnlyTools: readonly string[];
  /** provider 审批状态；Phase 1 一律 HOLD */
  providerApproval: 'HOLD' | 'READY';
}

export interface CustomerRecoveryState {
  organizationId: string;
  observedAt: string;
  opportunities: readonly OpportunitySlice[];
  capability: readonly CapabilitySlice[];
  /** 因金额来源不可信而被丢弃的引用（审计用，不是错误） */
  droppedMoneyRefs: readonly string[];
  /** 状态本身是否通过 tenant 校验 */
  tenantVerified: boolean;
}

export type BuildStateResult =
  | { ok: true; state: CustomerRecoveryState }
  | { ok: false; reason: 'TENANT_MISMATCH'; offendingRef: string };

export function buildCustomerRecoveryState(input: {
  organizationId: string;
  observedAt: string;
  opportunities: readonly OpportunitySlice[];
  capability: readonly CapabilitySlice[];
}): BuildStateResult {
  for (const slice of input.opportunities) {
    if (slice.organizationId !== input.organizationId) {
      return { ok: false, reason: 'TENANT_MISMATCH', offendingRef: slice.opportunityRef };
    }
  }
  const droppedMoneyRefs: string[] = [];
  const opportunities = input.opportunities.map((slice) => {
    if (slice.recoverable === null) return { ...slice };
    if (slice.recoverable.source === 'CANONICAL_FACT' || slice.recoverable.source === 'PERSISTED_ESTIMATE') {
      return { ...slice };
    }
    droppedMoneyRefs.push(slice.opportunityRef);
    return { ...slice, recoverable: null };
  });
  return {
    ok: true,
    state: {
      organizationId: input.organizationId,
      observedAt: input.observedAt,
      opportunities,
      capability: input.capability.map((slice) => ({ ...slice })),
      droppedMoneyRefs: droppedMoneyRefs.sort(),
      tenantVerified: true,
    },
  };
}

export const CUSTOMER_RECOVERY_STATE_BOUNDARY = {
  readOnly: true,
  mutatesCanonicalFact: false,
  recomputesMoneyTruth: false,
  inventsCustomerFacts: false,
  readsProviderSecrets: false,
  tenantScoped: true,
  crossTenantFailsClosed: true,
  moneyMustComeFromPersistedFact: true,
} as const;
