/**
 * R46 S4 —— Fee policy 可信来源（MSG-20261002-60 CHANGE A）
 *
 * 目标：Fee policy（basis / rate / fixedAmount / currency / version）**只能**由服务端可信、
 * 版本化 policy source 解析；调用方只允许提交 policyRef + feeBasisVersion（引用），
 * 不得提交 basis / rate / fixedAmount / currency 等可信字段。
 *
 * 解析结果参与 approval digest（server policy 漂移 → 旧 approval 失效），并作为
 * FeeCalculation 的唯一费率来源。
 */

import type { FeePolicyInput } from './fee-compute';

export interface FeePolicyRecord extends FeePolicyInput {
  /** 版本化来源标识（例如费率表版本 / 合同版本） */
  sourceKind: 'RATE_CARD' | 'CUSTOMER_CONTRACT' | 'TIERED_SCHEDULE' | 'SYSTEM_DEFAULT';
  /** 记录自身的完整性摘要（服务端计算，写入审计与 approval 绑定） */
  policyDigest: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  organizationId: string;
}

export interface FeePolicyResolutionRequest {
  organizationId: string;
  policyRef: string;
  feeBasisVersion: string;
  /** 判定时刻（便于可复现） */
  now?: string;
}

export interface FeePolicySource {
  /** 解析**生效中的**服务端 policy；找不到 → 抛错（fail-closed） */
  resolve(request: FeePolicyResolutionRequest): Promise<FeePolicyRecord>;
}

export class FeePolicyError extends Error {
  constructor(
    public readonly code:
      | 'CLIENT_POLICY_FIELDS_NOT_TRUSTED'
      | 'POLICY_NOT_FOUND'
      | 'POLICY_NOT_EFFECTIVE'
      | 'POLICY_TENANT_MISMATCH',
    message?: string,
  ) {
    super(message ? code + ': ' + message : code);
    this.name = 'FeePolicyError';
  }
}

/** 调用方提交体中**禁止**出现的可信字段 */
export const FORBIDDEN_FEE_POLICY_FIELDS = ['basis', 'rate', 'fixedAmount', 'currency', 'policyDigest'] as const;

export function assertNoClientPolicyFields(payload: Record<string, unknown>): void {
  for (const field of FORBIDDEN_FEE_POLICY_FIELDS) {
    if (payload[field] !== undefined && payload[field] !== null) {
      throw new FeePolicyError(
        'CLIENT_POLICY_FIELDS_NOT_TRUSTED',
        `client-supplied policy field "${field}" is not trusted`,
      );
    }
  }
}

/** 解析并校验：租户 / 生效期 / 版本一致；返回可用于 digest 与持久化的 server policy */
export async function resolveServerFeePolicy(
  source: FeePolicySource,
  request: FeePolicyResolutionRequest,
): Promise<FeePolicyRecord> {
  const record = await source.resolve(request);
  if (!record) throw new FeePolicyError('POLICY_NOT_FOUND', 'fee policy not found');
  if (record.organizationId !== request.organizationId) {
    throw new FeePolicyError('POLICY_TENANT_MISMATCH', 'fee policy belongs to another tenant');
  }
  if (record.policyRef !== request.policyRef || record.feeBasisVersion !== request.feeBasisVersion) {
    throw new FeePolicyError('POLICY_NOT_FOUND', 'resolved policy does not match requested reference/version');
  }
  const nowMs = request.now ? Date.parse(request.now) : Date.now();
  const fromMs = Date.parse(record.effectiveFrom);
  if (Number.isFinite(fromMs) && nowMs < fromMs) {
    throw new FeePolicyError('POLICY_NOT_EFFECTIVE', 'fee policy is not yet effective');
  }
  if (record.effectiveTo) {
    const toMs = Date.parse(record.effectiveTo);
    if (Number.isFinite(toMs) && nowMs > toMs) {
      throw new FeePolicyError('POLICY_NOT_EFFECTIVE', 'fee policy has expired');
    }
  }
  return record;
}
