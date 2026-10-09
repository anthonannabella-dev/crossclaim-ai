/**
 * V2-07 — CUSTOMS UNLOCK domain capability pack（接入既有 ONE SI Runtime）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-10「V2-AUTONOMOUS-20261010-01」§二。
 *
 * 硬约束（复用既有运行时，不新建第二套）：
 *  1. 本模块**只**实现 `RsiDomainCapabilityPack`，由既有 `createRsiDomainPackRunner` 派发；
 *     不创建 Runtime / 控制器 / 事件循环 / 调度器 / 第二套 Policy Engine。
 *  2. 不消费 `task:recovery:` 保留命名空间（FINAL-6）；保留命名空间只允许 reserved pack。
 *  3. 事实读不到 / 无法判定 → `BLOCK`（fail-closed；绝不 PASS、绝不 no-op 成功）。
 *  4. 链路上任何门禁未满足 → `BLOCK` 并回传状态与原因码，供控制器保持 HOLD。
 *  5. 本 pack **永不**自报外写：`externalWritePerformed` 恒为 false；外写授权由共享 Action Guard 裁决。
 *  6. deterministic-first：本轮不调用 Model Gateway（`modelCallCount = 0`）。
 */

import { RECOVERY_TASK_DEDUPE_PREFIX } from './rsi-domain-pack';
import type { RsiDomainCapabilityPack, RsiDomainPackContext, RsiDomainPackEvidence } from './rsi-domain-pack';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';
import {
  CUSTOMS_EXECUTION_CHAIN_VERSION,
  evaluateCustomsExecutionChain,
  type CustomsExecutionFacts,
} from '../services/customs/customs-execution-chain';

export const CUSTOMS_UNLOCK_PACK_ID = 'customs-unlock-si';
export const CUSTOMS_UNLOCK_PACK_DOMAIN = 'CUSTOMS';

export const CUSTOMS_UNLOCK_GUARD_ACTION = 'CUSTOMS_FILING_SUBMIT';

export interface CustomsUnlockSiPackDependencies {
  /**
   * 判断任务是否属于本 pack（由 host 注入；本模块不自带启发式匹配，避免误吞他域任务）。
   * 返回 true 的任务还必须通过保留命名空间检查。
   */
  matchesTask(task: RsiSafeTask): boolean;
  /**
   * CHANGE 08：任务声明的案件身份引用。pack 用它把"任务 → 案件"绑定起来，
   * 与事实里的 opportunityRef 强一致；返回 null/空 → BLOCK。
   */
  expectedOpportunityRef(task: RsiSafeTask): string | null;
  /**
   * 只读事实加载：返回 null 表示事实不可用（→ BLOCK）。**不得**在此发起外写或付费调用。
   */
  loadFacts(task: RsiSafeTask): Promise<CustomsExecutionFacts | null> | CustomsExecutionFacts | null;
}

function isReservedRecoveryTask(task: RsiSafeTask): boolean {
  return task.dedupeKey.startsWith(RECOVERY_TASK_DEDUPE_PREFIX);
}

/**
 * 事实不可用 / 链路停住 → BLOCK 证据（绝不 PASS）。
 */
function blockEvidence(input: {
  task: RsiSafeTask;
  reasonCodes: readonly string[];
  state: string;
  guardDecision: string;
}): RsiDomainPackEvidence {
  return {
    status: 'BLOCK',
    evidenceRef: `customs-chain:${input.task.id}:${input.state}`,
    reasonCodes: input.reasonCodes,
    modelCallCount: 0,
    guardActions: [{ action: CUSTOMS_UNLOCK_GUARD_ACTION, decision: input.guardDecision }],
    externalWritePerformed: false,
  };
}

export function createCustomsUnlockSiPack(
  dependencies: CustomsUnlockSiPackDependencies,
): RsiDomainCapabilityPack {
  return {
    packId: CUSTOMS_UNLOCK_PACK_ID,
    domain: CUSTOMS_UNLOCK_PACK_DOMAIN,
    matches(task: RsiSafeTask): boolean {
      // FINAL-6：保留命名空间不归本 pack 消费。
      if (isReservedRecoveryTask(task)) return false;
      return dependencies.matchesTask(task);
    },
    async run(context: RsiDomainPackContext): Promise<RsiDomainPackEvidence> {
      // 1) 客户授权链要求：必须有可信租户绑定，否则 fail-closed。
      if (typeof context.task.organizationId !== 'string' || context.task.organizationId.length === 0) {
        return blockEvidence({
          task: context.task,
          reasonCodes: ['TENANT_BINDING_MISSING'],
          state: 'FREE_DISCOVERY',
          guardDecision: 'DENY_HOLD',
        });
      }

      // 2) 只读事实
      let facts: CustomsExecutionFacts | null;
      try {
        facts = await dependencies.loadFacts(context.task);
      } catch {
        // 事实读取失败 → BLOCK（不允许"读失败但报 PASS"）
        return blockEvidence({
          task: context.task,
          reasonCodes: ['FACTS_LOAD_FAILED'],
          state: 'FREE_DISCOVERY',
          guardDecision: 'DENY_HOLD',
        });
      }
      if (facts === null) {
        return blockEvidence({
          task: context.task,
          reasonCodes: ['FACTS_UNAVAILABLE'],
          state: 'FREE_DISCOVERY',
          guardDecision: 'DENY_HOLD',
        });
      }

      // 3) CHANGE 08：任务租户 × 事实租户 × 机会归属 × 案件身份 四项强一致
      const identityReasons: string[] = [];
      if (facts.organizationId !== context.task.organizationId) {
        identityReasons.push('FACT_TENANT_MISMATCH');
      }
      // V2-R2 / CHANGE 12：归属**无法确定**必须立即 BLOCK，不得继续进入执行链。
      const owner = facts.opportunity.ownerOrganizationId;
      if (owner === null || owner.trim().length === 0) {
        identityReasons.push('OPPORTUNITY_OWNERSHIP_UNKNOWN');
      } else if (owner !== facts.organizationId) {
        identityReasons.push('OPPORTUNITY_OWNERSHIP_MISMATCH');
      }
      const expectedRef = dependencies.expectedOpportunityRef(context.task);
      if (expectedRef === null || expectedRef.trim().length === 0) {
        identityReasons.push('TASK_OPPORTUNITY_REF_MISSING');
      } else if (
        typeof facts.opportunityRef !== 'string' ||
        facts.opportunityRef.length === 0 ||
        facts.opportunityRef !== expectedRef
      ) {
        identityReasons.push('CASE_IDENTITY_MISMATCH');
      }
      if (identityReasons.length > 0) {
        return blockEvidence({
          task: context.task,
          reasonCodes: identityReasons,
          state: 'FREE_DISCOVERY',
          guardDecision: 'DENY_HOLD',
        });
      }

      // 4) 链路判定（纯函数）：任何门禁未满足 → BLOCK + 状态/原因码
      const chain = evaluateCustomsExecutionChain(facts);
      const chainReasonCodes = [
        `CHAIN_VERSION:${CUSTOMS_EXECUTION_CHAIN_VERSION}`,
        `STATE:${chain.state}`,
        ...chain.holdReasons,
      ];

      if (chain.holding) {
        return blockEvidence({
          task: context.task,
          reasonCodes: chainReasonCodes,
          state: chain.state,
          guardDecision: 'DENY_HOLD',
        });
      }

      // 5) 全部门禁通过：本 pack 仍不自报外写；外写授权交由共享 Action Guard 裁决。
      return {
        status: 'PASS',
        evidenceRef: `customs-chain:${context.task.id}:${chain.state}`,
        reasonCodes: chainReasonCodes,
        modelCallCount: 0,
        guardActions: [{ action: CUSTOMS_UNLOCK_GUARD_ACTION, decision: 'REQUIRES_SHARED_GUARD_DECISION' }],
        externalWritePerformed: false,
      };
    },
  };
}

/** 边界自证：本 pack 不创建运行时 / 调度器，也不产生外写与资金动作。 */
export const CUSTOMS_UNLOCK_SI_PACK_BOUNDARY = {
  createsRuntime: false,
  createsScheduler: false,
  consumesReservedRecoveryNamespace: false,
  externalWritePerformed: false,
  providerInvoked: false,
  chargedAmount: null,
  autoCollection: 'HOLD',
  modelCallCount: 0,
  productionCredentials: 'ABSENT',
} as const;
