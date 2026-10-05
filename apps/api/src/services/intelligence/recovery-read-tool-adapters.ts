/**
 * Recovery SI —— P2-B adapter：只读端口 → **现有确定性只读服务**
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-13 + MSG-20261005-14（REVISE：CHANGE B2）。
 * 适配器只做四件事：绑定 tenant、调用既有只读服务、投影最小字段、返回给 SI。
 *
 * 硬约束：
 *   · **CHANGE B2**：`input.organizationId !== actor.organizationId` → 直接抛错（fail-closed），
 *     绝不按 actor 的租户去查询“别人的”上下文；
 *   · 零写入（无 `prisma.<model>.create/update/upsert/delete/...`）、零网络、零凭据读取；
 *   · 所有查询都带 `organizationId`（tenant-scoped）。
 *
 * 复用（不新建第二套读取逻辑）：
 *   · opportunity  → `services/workflow/opportunity-insight.ts#getOpportunityInsight`
 *   · evidence     → `services/workflow/case-read.ts#listCaseEvidence`
 *   · customs      → `services/customs/customs-authorization-center-loader.ts#createPrismaCustomsAuthorizationContextLoader`
 */

import type { PrismaClient } from '@prisma/client';

import { listCaseEvidence } from '../workflow/case-read';
import { getOpportunityInsight } from '../workflow/opportunity-insight';
import { createPrismaCustomsAuthorizationContextLoader } from '../customs/customs-authorization-center-loader';
import type { RecoveryReadPorts, RecoveryReadToolInput } from './recovery-read-tools';

/** 只读 actor：tenant + 既有角色口径（权限判定仍由既有服务完成，缺权限 → 拒绝） */
export interface RecoveryReadActor {
  organizationId: string;
  role: string;
}

export function createPrismaRecoveryReadPorts(prisma: PrismaClient, actor: RecoveryReadActor): RecoveryReadPorts {
  const customsLoader = createPrismaCustomsAuthorizationContextLoader(prisma);

  // CHANGE B2：adapter 侧 tenant 绑定（composition root 错配 → fail-closed，绝不按 actor 查询）
  const assertActorTenant = (input: RecoveryReadToolInput): void => {
    if (input.organizationId !== actor.organizationId) {
      throw new Error(`TENANT_MISMATCH:ADAPTER_ACTOR:${input.organizationId}!=${actor.organizationId}`);
    }
  };

  return {
    async opportunityRead(input) {
      assertActorTenant(input);
      const insight = await getOpportunityInsight(
        prisma,
        { organizationId: actor.organizationId, role: actor.role },
        input.opportunityRef,
      );
      return {
        opportunityRef: insight.opportunityId,
        status: insight.status,
        currency: insight.currency,
        hasRecoverableAmount: insight.recoverableAmount !== null,
        hasRuleEvaluation: insight.calculation.ruleVersion !== null,
      };
    },

    async evidenceRead(input) {
      assertActorTenant(input);
      // opportunity → case 只读解析；未进入案件的机会没有可读证据集（不编造、不推断）
      const kase = await prisma.case.findFirst({
        where: {
          organizationId: actor.organizationId,
          opportunities: { some: { opportunityId: input.opportunityRef } },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (kase === null) {
        return { opportunityRef: input.opportunityRef, caseRef: null, evidenceCount: 0, kinds: [] };
      }
      const items = await listCaseEvidence(
        prisma,
        { organizationId: actor.organizationId, role: actor.role },
        kase.id,
      );
      return {
        opportunityRef: input.opportunityRef,
        caseRef: kase.id,
        evidenceCount: items.length,
        kinds: [...new Set(items.map((item) => item.kind))].sort(),
      };
    },

    async customsAuthorizationReadinessRead(input) {
      assertActorTenant(input);
      const context = await customsLoader.load({
        organizationId: actor.organizationId,
        opportunityId: input.opportunityRef,
      });
      if (context === null) {
        return {
          opportunityRef: input.opportunityRef,
          route: 'UNAVAILABLE',
          readyToFile: false,
          blockerCodes: ['AUTHORIZATION_CONTEXT_UNAVAILABLE'],
        };
      }
      return {
        opportunityRef: input.opportunityRef,
        route: String(context.center.route),
        readyToFile: context.center.stages.READY_TO_FILE,
        blockerCodes: [...context.center.advancedBlockerCodes].sort(),
      };
    },
  };
}

export const RECOVERY_READ_TOOL_ADAPTER_BOUNDARY = {
  reusesExistingReadServices: true,
  secondReadImplementation: false,
  databaseWrites: 0,
  networkCalls: 0,
  credentialReads: 0,
  tenantScopedQueriesOnly: true,
  /** CHANGE B2：input.organizationId === actor.organizationId 否则 fail-closed */
  actorTenantBoundToInput: true,
  rawEvidenceContentReturned: false,
  rawStorageReferenceReturned: false,
} as const;
