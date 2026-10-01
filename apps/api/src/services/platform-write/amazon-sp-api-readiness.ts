/**
 * Provider Adapter Readiness —— 首个样板 provider 的能力档案（Amazon SP-API）
 * ---------------------------------------------------------------
 * 依据：MSG-20261001-24 NEXT「Provider Adapter Readiness / First Provider Design Gate」
 *   · 本轮只做**设计与能力取证**：不实现真实写 adapter、不配置真实凭据、不发送任何写请求；
 *   · 10 项能力逐项留证（官方文档为主来源），能力不足者一律 fail-closed；
 *   · 平台级描述符由 adapter implementation 固定声明（MSG-20261001-22 CHANGE C），
 *     不来自 HTTP 请求、租户配置或客户端参数。
 *
 * 结论（本轮取证结果）：**READ-ONLY 先行；platform.write 保持 NEEDS_MANUAL**。
 * 原因：平台级「原生幂等写」与「不确定响应的可复现处置语义」无法用官方文档证明（③⑥未取证）。
 */

import {
  evaluateAdapterEligibility,
  evaluateTransportGate,
  getAdapterCapability,
  registerAdapterCapability,
} from './adapter-capability';

export const FIRST_PROVIDER_ID = 'amazon-sp';
export const FIRST_PROVIDER_LABEL = 'Amazon Selling Partner API (SP-API)';

export type ReadinessStatus = 'PROVEN' | 'PARTIAL' | 'NOT_PROVEN';

export interface ProviderReadinessItem {
  /** 1–10，与 MSG-20261001-24 NEXT 清单一一对应 */
  no: number;
  item: string;
  status: ReadinessStatus;
  /** 取证结论（一句话） */
  finding: string;
  /** 主来源（官方文档） */
  source: string;
}

/**
 * 10 项能力档案（官方文档取证；取证时间 2026-10-01 JST）。
 * 主来源域名：developer-docs.amazon.com/sp-api/（含 .md 页面与 llms.txt 索引）。
 */
export const AMAZON_SP_API_READINESS: readonly ProviderReadinessItem[] = [
  {
    no: 1,
    item: '官方 API endpoint / API version / required scopes',
    status: 'PROVEN',
    finding:
      '存在按区域划分的 SP-API endpoint 与按版本划分的 API（如 application-management-v2023-11-30）；LWA 有 client_credentials（grantless，需 scope）与 refresh_token 两种授权路径。',
    source:
      'https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints.md ; https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api.md',
  },
  {
    no: 2,
    item: 'read scope 与 write scope 是否可物理分离',
    status: 'PARTIAL',
    finding:
      '授权以 application role / use case 为单位；受限数据另需 Restricted Data Token。未见“每个调用按 read/write 粒度独立授权”的统一机制，故只能做到角色级隔离，非调用级物理分离。',
    source:
      'https://developer-docs.amazon.com/sp-api/docs/authorizing-selling-partner-api-applications.md ; https://developer-docs.amazon.com/sp-api/docs/authorization-with-the-restricted-data-token.md',
  },
  {
    no: 3,
    item: 'provider 原生 idempotency 能力（同 key 不重复产生外部副作用）',
    status: 'NOT_PROVEN',
    finding:
      '官方文档未提供平台级、跨 API 的原生幂等写保证（未检索到统一的 Idempotency-Key 语义）。个别 API 可能接受调用方提供的标识，但必须逐操作取证，不能作为平台级能力。',
    source: 'https://developer-docs.amazon.com/sp-api/llms.txt（索引全量检索）+ 各 API 参考页（需逐操作取证）',
  },
  {
    no: 4,
    item: 'request identifier / operation identifier',
    status: 'PARTIAL',
    finding:
      '部分操作返回可追踪标识（feed/operation 类返回 id 以便轮询），但并非所有写操作都提供稳定 operation identifier；需逐操作取证。',
    source: 'https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints.md（按 API 分册，需逐操作核对）',
  },
  {
    no: 5,
    item: '写入后的 status-query / reconciliation 能力',
    status: 'PARTIAL',
    finding:
      '存在按操作的状态查询（如 check-the-status-of-your-listing、check-the-invoice-status-for-a-delivery-by-amazon-order、retrieve-list-of-shipments），但不存在覆盖全部写操作的统一“按 request id 查询”能力。',
    source:
      'https://developer-docs.amazon.com/sp-api/llms.txt（含 Check Listing Status / Check the invoice submission status / Retrieve a List of Shipments 等条目）',
  },
  {
    no: 6,
    item: 'timeout / 5xx / connection reset 后如何判断 ambiguous response',
    status: 'NOT_PROVEN',
    finding:
      '官方文档未定义“请求已发出但结果不可判定”时的统一可复现处置语义（无平台级去重凭证可依赖）；因此超时后不得重发写请求。',
    source: 'https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits.md（仅覆盖 429，不覆盖写去重语义）',
  },
  {
    no: 7,
    item: 'rate limit / retry 官方规则',
    status: 'PROVEN',
    finding:
      '429 为可重试状态码，需退避策略；响应头 x-amzn-RateLimit-Limit 提供限额信息；sandbox 可测试 429 处理但不能复现生产限流速率。',
    source: 'https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits.md',
  },
  {
    no: 8,
    item: 'credential 生命周期、rotation、revocation',
    status: 'PROVEN',
    finding:
      'LWA refresh token 为长期凭据（用于换取 access token，无需卖家重复授权）；credential rotation = 生成新 client secret 并使旧 secret 失效；提供 Revoke/Reactivate Authorizations 文档。',
    source:
      'https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api.md ; https://developer-docs.amazon.com/sp-api/docs/revoke-authorizations.md ; https://developer-docs.amazon.com/sp-api/docs/application-management-api.md',
  },
  {
    no: 9,
    item: 'sandbox / test-mode 能力',
    status: 'PROVEN',
    finding:
      '提供 sandbox application 注册与首次调用指引（onboarding step 4/5），可用于联调与 429 处理演练；注意 sandbox 所有操作共享同一速率，不能复现生产限流。',
    source:
      'https://developer-docs.amazon.com/sp-api/docs/sp-api-sandbox.md ; https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits.md',
  },
  {
    no: 10,
    item: '是否满足自动写入最低能力矩阵',
    status: 'NOT_PROVEN',
    finding:
      '最低矩阵要求「原生幂等写 + 不确定响应可复现处置 + 写后可按标识对账」三者同时成立；③与⑥未取证 → **不满足**，自动写入必须保持 NEEDS_MANUAL。',
    source: '本档案 §3/§5/§6 综合判定（fail-closed 口径）',
  },
] as const;

export interface ProviderWriteDecision {
  provider: string;
  eligibleForAutomaticWrite: boolean;
  /** 该 provider 本阶段的接入姿态：能力不足 → READ_ONLY（写请求走 NEEDS_MANUAL） */
  disposition: 'READ_ONLY' | 'NEEDS_MANUAL';
  /** 写请求的处置（当前恒为 NEEDS_MANUAL，直到最低能力矩阵被逐操作证明） */
  writeDisposition: 'NEEDS_MANUAL';
  reason: string;
  transportAllowed: boolean;
}

/**
 * 平台级能力描述符：**只读**（idempotentWrite / statusQuery / ambiguousResponseSemantics 均为 false）。
 * 这不是“忘了填”，而是取证结论：在逐操作证明之前一律 fail-closed。
 */
export const AMAZON_SP_API_READ_ONLY_CAPABILITY = {
  platform: FIRST_PROVIDER_ID,
  idempotentWrite: false,
  statusQuery: false,
  ambiguousResponseSemantics: false,
} as const;

/** 幂等注册（重复调用安全；已注册同样口径时直接返回） */
export function registerFirstProviderReadOnlyCapability(): void {
  const existing = getAdapterCapability(FIRST_PROVIDER_ID);
  if (existing) return;
  registerAdapterCapability({ ...AMAZON_SP_API_READ_ONLY_CAPABILITY });
}

/**
 * 首个 provider 的写入裁决（fail-closed）：
 * 能力不足 → NEEDS_MANUAL；即使全球 transport gate 被打开也不得自动写入。
 */
export function firstProviderWriteDecision(globalTransportEnabled = false): ProviderWriteDecision {
  const eligibility = evaluateAdapterEligibility(FIRST_PROVIDER_ID);
  const gate = evaluateTransportGate({
    platform: FIRST_PROVIDER_ID,
    authorizationValid: true,
    globalTransportEnabled,
  });
  return {
    provider: FIRST_PROVIDER_ID,
    eligibleForAutomaticWrite: eligibility.eligibleForAutomaticWrite,
    disposition: eligibility.eligibleForAutomaticWrite ? 'NEEDS_MANUAL' : 'READ_ONLY',
    writeDisposition: 'NEEDS_MANUAL',
    reason: eligibility.reason,
    transportAllowed: gate.transportAllowed,
  };
}
