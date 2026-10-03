/**
 * platform.write HTTP 响应契约（MSG-20261001-22 CHANGE B）
 * ---------------------------------------------------------------
 * 纪律：
 *   · 成功 HTTP 响应**必须**让调用方看出「平台尚未真实写入」；
 *   · 至少包含 status / attemptId / platformWriteExecuted / executionDisposition；
 *   · 在 transport 关闭阶段 platformWriteExecuted 恒为 false，executionDisposition 恒为 'NEEDS_MANUAL'；
 *   · **不得**返回 provider success 类字段（providerRef / providerStatus / externalRef 等仅内部使用）；
 *   · 未来 transport Gate 真正开启后再单独定义真实执行响应语义。
 */

export const PLATFORM_WRITE_EXECUTION_DISPOSITIONS = ['NEEDS_MANUAL'] as const;
export type PlatformWriteExecutionDisposition = (typeof PLATFORM_WRITE_EXECUTION_DISPOSITIONS)[number];

/** 编排层允许进入响应契约的结果（超集；响应会丢弃 provider 成功类字段） */
export interface PlatformWriteInternalResult {
  status: 'NEEDS_MANUAL' | 'SUCCEEDED' | 'FAILED' | 'RETRYABLE' | 'UNKNOWN_PROVIDER_RESPONSE' | 'REPLAYED' | 'BLOCKED';
  attemptId: string | null;
  /** 内部使用：上游引用（**不进入 HTTP 响应**） */
  providerRef?: string | null;
  sinkCalls?: number;
  code?: string | null;
}

export interface PlatformWriteHttpResponse {
  status: PlatformWriteInternalResult['status'];
  attemptId: string | null;
  /** 平台是否已被真实写入 —— 当前阶段恒为 false */
  platformWriteExecuted: false;
  executionDisposition: PlatformWriteExecutionDisposition;
  code?: string | null;
}

/** 响应字段白名单：任何不在其中的字段都不会出现在响应里 */
export const PLATFORM_WRITE_RESPONSE_FIELDS: readonly string[] = [
  'status',
  'attemptId',
  'platformWriteExecuted',
  'executionDisposition',
  'code',
];

/** provider 成功类字段黑名单（响应构造期拒绝） */
export const PLATFORM_WRITE_PROVIDER_SUCCESS_FIELDS: readonly string[] = [
  'providerRef',
  'providerStatus',
  'externalRef',
  'sinkCalls',
  'providerSuccess',
];

/**
 * 构造 HTTP 响应体（纯函数）。
 * transport 关闭时：platformWriteExecuted=false 且 executionDisposition='NEEDS_MANUAL'。
 */
export function buildPlatformWriteResponse(
  result: PlatformWriteInternalResult,
  options: { transportEnabled?: boolean } = {},
): PlatformWriteHttpResponse {
  const transportEnabled = options.transportEnabled === true;
  if (transportEnabled) {
    // 真实 transport 语义尚未定义（MSG-20261001-22 CHANGE B）：必须先经架构方裁决
    throw new Error('PLATFORM_WRITE_RESPONSE_CONTRACT_NOT_DEFINED_FOR_ENABLED_TRANSPORT');
  }

  const response: PlatformWriteHttpResponse = {
    status: result.status,
    attemptId: result.attemptId,
    platformWriteExecuted: false,
    executionDisposition: 'NEEDS_MANUAL',
  };
  if (result.code) response.code = result.code;

  for (const key of Object.keys(response as unknown as Record<string, unknown>)) {
    if (!PLATFORM_WRITE_RESPONSE_FIELDS.includes(key)) {
      throw new Error('PLATFORM_WRITE_RESPONSE_FIELD_REJECTED: ' + key);
    }
  }
  return response;
}

/** 供路由层断言使用：响应体内不得出现任何 provider 成功类字段 */
export function assertNoProviderSuccessFields(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (PLATFORM_WRITE_PROVIDER_SUCCESS_FIELDS.includes(key)) {
      throw new Error('PLATFORM_WRITE_PROVIDER_SUCCESS_FIELD_LEAKED: ' + key);
    }
  }
}
