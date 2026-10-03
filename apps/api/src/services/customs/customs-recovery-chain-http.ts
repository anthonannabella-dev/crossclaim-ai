/**
 * BG-012（MSG-20261003-134）— Customs 恢复链**内部触发** HTTP handler。
 * ---------------------------------------------------------------
 *   · action：customs.recovery.chain.run（INTERNAL_WRITE）
 *   · 角色矩阵：OWNER / ADMIN / OPS → allow；FINANCE / VIEWER / 未知 → deny（403）
 *   · 语义：读取持久化事实 → 服务端确定性计算 → qualification → append-only projections → 返回结果
 *   · 永久边界字段：filingSubmitted=false · externalWritePerformed=false · transportEnabled=false · productionCredentials=ABSENT · filingAuthorized=false
 *   · 不调用任何 provider / broker / PSP；不产生真实资金动作。
 */

import type { CustomsChainRunResult } from './customs-recovery-chain-service';

export const CUSTOMS_CHAIN_RUN_ACTION = 'customs.recovery.chain.run';
export const CUSTOMS_CHAIN_RUN_RISK_CLASS = 'INTERNAL_WRITE';
export const CUSTOMS_CHAIN_RUN_ALLOWED_ROLES = ['OWNER', 'ADMIN', 'OPS'] as const;
export const CUSTOMS_CHAIN_RUN_DENIED_ROLES = ['FINANCE', 'VIEWER'] as const;

export const CUSTOMS_CHAIN_RUN_BOUNDARY = {
  filingSubmitted: false,
  externalWritePerformed: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
  filingAuthorized: false,
  internalWritePerformed: true,
  providerCalls: 0,
  brokerCalls: 0,
  moneySideEffects: 0,
} as const;

export interface CustomsChainHttpSession {
  organizationId: string;
  actorUserId: string;
  role: string;
}

export async function postCustomsRecoveryChain(input: {
  session: CustomsChainHttpSession;
  entryFactId: string;
  run: () => Promise<CustomsChainRunResult>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!(CUSTOMS_CHAIN_RUN_ALLOWED_ROLES as readonly string[]).includes(input.session.role)) {
    return {
      status: 403,
      body: { error: 'FORBIDDEN', reason: 'ROLE_NOT_PERMITTED', action: CUSTOMS_CHAIN_RUN_ACTION, boundary: CUSTOMS_CHAIN_RUN_BOUNDARY },
    };
  }
  if (typeof input.entryFactId !== 'string' || input.entryFactId.trim() === '') {
    return {
      status: 400,
      body: { error: 'INVALID_REQUEST', reason: 'ENTRY_FACT_ID_REQUIRED', action: CUSTOMS_CHAIN_RUN_ACTION, boundary: CUSTOMS_CHAIN_RUN_BOUNDARY },
    };
  }
  try {
    const result = await input.run();
    return {
      status: 200,
      body: {
        action: CUSTOMS_CHAIN_RUN_ACTION,
        executionKey: result.executionKey,
        package: {
          packageId: result.package.packageId,
          readiness: result.package.readiness,
          gaps: result.package.gaps,
          estimateOnly: result.package.estimateOnly,
          billable: result.package.billable,
          filingSubmitted: result.package.filingPerformed,
          submissionPerformed: result.package.submissionPerformed,
        },
        projections: result.projections,
        boundary: CUSTOMS_CHAIN_RUN_BOUNDARY,
      },
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FACT_NOT_FOUND') {
      return { status: 404, body: { error: 'NOT_FOUND', action: CUSTOMS_CHAIN_RUN_ACTION, boundary: CUSTOMS_CHAIN_RUN_BOUNDARY } };
    }
    return {
      status: 409,
      body: { error: 'CHAIN_NOT_READY', reason: code ?? 'UNKNOWN', action: CUSTOMS_CHAIN_RUN_ACTION, boundary: CUSTOMS_CHAIN_RUN_BOUNDARY },
    };
  }
}
