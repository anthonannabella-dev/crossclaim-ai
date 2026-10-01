/**
 * Adapter 能力注册表（代码 typed descriptor）与 transport 双重门控
 * ---------------------------------------------------------------
 * 依据：MSG-20261001-22 CHANGE C / CHANGE D
 *   · 三能力必须显式声明，且只能由 adapter implementation 固定声明；
 *   · 本轮不新增数据库 Schema（代码注册表即可）；
 *   · fail-closed：未注册 / 能力未知 / 缺 idempotentWrite / ambiguous 语义未定义 → 不允许自动 write；
 *     缺 statusQuery → 不允许自动 reconciliation；
 *   · transport 双重门控：global gate ON **且** adapter 合格 **且** T1 授权有效，缺一即 fail-closed；
 *     生产凭据存在绝不等于 enablement。
 */

import { PLATFORM_WRITE_TRANSPORT_ENABLED } from './types';

export interface AdapterCapabilityDescriptor {
  /** 稳定的平台标识（如 'amazon-sp' / 'ups'） */
  readonly platform: string;
  /** 上游是否支持幂等写（同 key 不重复产生副作用） */
  readonly idempotentWrite: boolean;
  /** 是否支持按 provider request/idempotency reference 只读查询状态 */
  readonly statusQuery: boolean;
  /** 是否对超时/不确定响应具备明确、可复现的处置语义 */
  readonly ambiguousResponseSemantics: boolean;
}

const registry = new Map<string, AdapterCapabilityDescriptor>();

/** 注册（重复注册同 platform 视为配置错误，直接拒绝） */
export function registerAdapterCapability(descriptor: AdapterCapabilityDescriptor): void {
  const platform = String(descriptor?.platform ?? '').trim();
  if (!platform) throw new Error('ADAPTER_CAPABILITY_PLATFORM_REQUIRED');
  if (registry.has(platform)) throw new Error('ADAPTER_CAPABILITY_ALREADY_REGISTERED: ' + platform);
  registry.set(platform, Object.freeze({ ...descriptor, platform }));
}

export function getAdapterCapability(platform: string): AdapterCapabilityDescriptor | null {
  return registry.get(String(platform ?? '').trim()) ?? null;
}

export function listAdapterCapabilities(): AdapterCapabilityDescriptor[] {
  return [...registry.values()];
}

/** 仅测试使用：清空注册表 */
export function resetAdapterCapabilityRegistry(): void {
  registry.clear();
}

export interface AdapterEligibility {
  registered: boolean;
  capabilitiesValidated: boolean;
  eligibleForAutomaticWrite: boolean;
  eligibleForAutomaticReconciliation: boolean;
  /** 面向审计/响应的稳定原因码 */
  reason:
    | 'ADAPTER_NOT_REGISTERED'
    | 'IDEMPOTENT_WRITE_MISSING'
    | 'AMBIGUOUS_RESPONSE_SEMANTICS_UNDEFINED'
    | 'STATUS_QUERY_MISSING'
    | 'ELIGIBLE';
}

/** 能力判定（fail-closed；不接受任何外部参数覆盖） */
export function evaluateAdapterEligibility(platform: string): AdapterEligibility {
  const caps = getAdapterCapability(platform);
  if (!caps) {
    return {
      registered: false,
      capabilitiesValidated: false,
      eligibleForAutomaticWrite: false,
      eligibleForAutomaticReconciliation: false,
      reason: 'ADAPTER_NOT_REGISTERED',
    };
  }
  const ambiguousOk = caps.ambiguousResponseSemantics === true;
  const writeOk = caps.idempotentWrite === true && ambiguousOk;
  const reconcileOk = caps.statusQuery === true;
  const reason: AdapterEligibility['reason'] = !writeOk
    ? caps.idempotentWrite !== true
      ? 'IDEMPOTENT_WRITE_MISSING'
      : 'AMBIGUOUS_RESPONSE_SEMANTICS_UNDEFINED'
    : !reconcileOk
      ? 'STATUS_QUERY_MISSING'
      : 'ELIGIBLE';

  return {
    registered: true,
    capabilitiesValidated: true,
    eligibleForAutomaticWrite: writeOk,
    eligibleForAutomaticReconciliation: writeOk && reconcileOk,
    reason,
  };
}

export interface TransportGateDecision {
  /** 是否允许真实 transport 调用（当前实现恒为 false：全局 gate 关闭或 adapter 不合格） */
  transportAllowed: boolean;
  globalGateEnabled: boolean;
  adapterEligible: boolean;
  authorizationValid: boolean;
  reason:
    | 'GLOBAL_GATE_DISABLED'
    | 'ADAPTER_NOT_ELIGIBLE'
    | 'AUTHORIZATION_INVALID'
    | 'TRANSPORT_ALLOWED';
}

/**
 * transport 双重门控（CHANGE D）：四项全部满足才允许真实调用。
 * 生产凭据的存在不作为任何一项的替代物（本函数不读取凭据）。
 */
export function evaluateTransportGate(input: {
  platform: string;
  authorizationValid: boolean;
  /** 仅测试可覆盖；生产默认取硬开关 */
  globalTransportEnabled?: boolean;
}): TransportGateDecision {
  const globalGateEnabled = (input.globalTransportEnabled ?? PLATFORM_WRITE_TRANSPORT_ENABLED) === true;
  const eligibility = evaluateAdapterEligibility(input.platform);
  const adapterEligible = eligibility.eligibleForAutomaticWrite;
  const authorizationValid = input.authorizationValid === true;

  const reason: TransportGateDecision['reason'] = !globalGateEnabled
    ? 'GLOBAL_GATE_DISABLED'
    : !adapterEligible
      ? 'ADAPTER_NOT_ELIGIBLE'
      : !authorizationValid
        ? 'AUTHORIZATION_INVALID'
        : 'TRANSPORT_ALLOWED';

  return {
    transportAllowed: reason === 'TRANSPORT_ALLOWED',
    globalGateEnabled,
    adapterEligible,
    authorizationValid,
    reason,
  };
}
