/**
 * V2-01 — PAID_CUSTOMS_API_GATE（免费 / 付费关税 API 调用边界 · fail-closed）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」
 *   PHASE A（免费发现与预估）+ PHASE D（付费关税 API 执行门禁）。
 * 目标验收：FREE_CUSTOMS_PAID_API_CALL_COUNT = 0。
 *
 * 不变式：
 *  1. 免费阶段（发现 / 核查 / 预估 / 历史扫描 / 预览刷新 / 异步只读任务）永不触发收费关税数据源调用。
 *  2. 收费调用只能经本 Gate 放行；未经放行的调用不得触及 provider 实现。
 *  3. 本模块自身不发起任何外部调用、不扣款、不收款、不写库：只做判定与计数。
 *  4. 任何缺失证据（归属 / 权益 / 额度 / Standing Authorization / 外部写授权 / Provider 可用性 /
 *     报价 / 预算 / 利润门 / Kill Switch / 支付开关）→ HOLD。
 *  5. 免费路径尝试收费操作 → HOLD，并记入 freePathPaidAttempt 计数（验收断言必须为 0 触达）。
 *  6. HOLD 不得被调用方误认为成功：包装器在 HOLD 时抛出具名错误，绝不返回伪造的 provider 结果。
 */

export const PAID_CUSTOMS_API_GATE_VERSION = 'paid-customs-api-gate-v2.0.0';

/**
 * 收费外部关税操作：任何一项都不得由免费路径触发。
 * 与 C15 CustomsFilingProvider 的出站 operation 对齐；
 * RATE_LOOKUP 在宿主确认其不计费之前一律按 PAID_EXTERNAL 处理（fail-closed）。
 * 注意：WEBHOOK 为 provider → 我方入站事件，不产生出站调用费用，故不在此列。
 */
export const PAID_CUSTOMS_OPERATIONS = [
  'DATA_READ',
  'RATE_LOOKUP',
  'FILING_CREATE',
  'DOCUMENT_UPLOAD',
  'SUBMISSION_READ',
  'STATUS_READ',
  'RFI_READ',
  'RFI_RESPOND',
  'REFUND_STATUS',
] as const;
export type PaidCustomsOperation = (typeof PAID_CUSTOMS_OPERATIONS)[number];

/** 免费阶段允许的本地 / 只读操作（只读事实源，不产生外部费用）。 */
export const FREE_CUSTOMS_OPERATIONS = [
  'LOCAL_ENTRY_FACT_READ',
  'LOCAL_CLASSIFICATION_DISCREPANCY_COMPUTE',
  'LOCAL_ELIGIBILITY_COMPUTE',
  'LOCAL_ESTIMATE_COMPUTE',
  'LOCAL_HISTORICAL_SCAN',
  'LOCAL_IOR_READINESS_READ',
  'LOCAL_EVIDENCE_LINEAGE_READ',
] as const;
export type FreeCustomsOperation = (typeof FREE_CUSTOMS_OPERATIONS)[number];

/** 调用方路径：免费路径永远不得触发收费调用。 */
export const CUSTOMS_CALLER_PATHS = ['FREE_SCAN', 'CUSTOMER_PAID', 'OPERATOR_APPROVED'] as const;
export type CustomsCallerPath = (typeof CUSTOMS_CALLER_PATHS)[number];

export type CustomsPaidGateReasonCode =
  | 'FREE_PATH_CANNOT_CALL_PAID_OPERATION'
  | 'OPPORTUNITY_NOT_FOUND'
  | 'OPPORTUNITY_REFERENCE_REQUIRED'
  | 'OPPORTUNITY_OWNERSHIP_UNKNOWN'
  | 'OPPORTUNITY_NOT_OWNED'
  | 'NO_ACTIVE_PAID_ENTITLEMENT'
  | 'INSUFFICIENT_VERIFICATION_QUOTA'
  | 'STANDING_AUTHORIZATION_INVALID'
  | 'EXTERNAL_WRITE_NOT_AUTHORIZED'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'PROVIDER_QUOTE_MISSING'
  | 'PROVIDER_QUOTE_INVALID'
  | 'PROVIDER_QUOTE_VALIDITY_REQUIRED'
  | 'PROVIDER_QUOTE_CURRENCY_MISMATCH'
  | 'PROVIDER_QUOTE_EXPIRED'
  | 'PER_CHECK_BUDGET_EXCEEDED'
  | 'TENANT_BUDGET_EXCEEDED'
  | 'PROFIT_GATE_HOLD'
  | 'KILL_SWITCH_ENGAGED'
  | 'PAYMENTS_NOT_ENABLED'
  | 'PRODUCTION_PAYMENT_NOT_ENABLED';

export interface PaidCustomsGateEntitlement {
  active: boolean;
  entitlementId: string | null;
  remainingQuota: number;
}

export interface PaidCustomsGateAuthorization {
  standingAuthorizationValid: boolean;
  /** 生产 / 外部写门禁是否已由宿主正式授权（未授权 → 一律 HOLD）。 */
  externalWriteAuthorized: boolean;
}

export interface PaidCustomsGateProvider {
  providerId: string | null;
  available: boolean;
  /** provider 报价（decimal string）；缺失即 HOLD，禁止"先调用后补价"。 */
  quotedCost: string | null;
  quoteCurrency: string | null;
  quoteValidUntil: string | null;
}

export interface PaidCustomsGateBudget {
  /** 单次核验成本上限（decimal string）。 */
  maximumPerCheckCost: string;
  /** 租户剩余预算（decimal string）。 */
  tenantRemainingBudget: string;
  currency: string;
}

export interface PaidCustomsGateScope {
  organizationId: string;
  opportunityId: string | null;
  /** 机会 / 案件的实际归属组织；用于跨租户拒绝。 */
  ownerOrganizationId: string | null;
  caseFound: boolean;
}

export interface PaidCustomsGateProfitGate {
  decision: 'PASS' | 'HOLD';
  reasonCode: string | null;
}

export interface PaidCustomsGateContext {
  callerPath: CustomsCallerPath;
  scope: PaidCustomsGateScope;
  entitlement: PaidCustomsGateEntitlement;
  authorization: PaidCustomsGateAuthorization;
  provider: PaidCustomsGateProvider;
  budget: PaidCustomsGateBudget;
  profitGate: PaidCustomsGateProfitGate;
  killSwitch: { engaged: boolean };
  payment: { paymentsEnabled: boolean; productionPaymentEnabled: boolean };
}

export interface PaidCustomsApiGateInput extends PaidCustomsGateContext {
  operation: PaidCustomsOperation;
  now: Date;
}

export interface PaidCustomsApiGateResult {
  kind: 'PAID_CUSTOMS_API_GATE';
  version: string;
  operation: PaidCustomsOperation;
  decision: 'ALLOW' | 'HOLD';
  reasonCodes: readonly CustomsPaidGateReasonCode[];
  /** 免费路径试图触发收费调用（验收要求该值为 0）。 */
  freePathPaidAttempt: boolean;
  paidApiCallPermitted: boolean;
  /** 本 Gate 自身永不发起外部调用。 */
  externalCallPerformed: false;
  chargedAmount: null;
  evaluatedAt: string;
}

export class CustomsPaidApiGateError extends Error {
  readonly code = 'CUSTOMS_PAID_API_GATE_BLOCKED';
  readonly result: PaidCustomsApiGateResult;

  constructor(result: PaidCustomsApiGateResult) {
    super(
      `CUSTOMS_PAID_API_GATE_BLOCKED:${result.operation}:${result.reasonCodes.join('|') || 'UNKNOWN'}`,
    );
    this.name = 'CustomsPaidApiGateError';
    this.result = result;
  }
}

/**
 * 定点数规范化：只接受非负 decimal string（最多 4 位小数），其余一律 null（fail-closed）。
 * 金融金额禁止走浮点。
 */
export function normalizeDecimalAmount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  const [intRaw, fracRaw = ''] = trimmed.split('.');
  const intPart = intRaw.replace(/^0+(?=\d)/, '');
  const fracPart = fracRaw.replace(/0+$/, '');
  return fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`;
}

/** 比较两个非负定点数：-1 / 0 / 1；任一非法返回 null。 */
export function compareDecimalAmounts(left: string, right: string): number | null {
  const a = normalizeDecimalAmount(left);
  const b = normalizeDecimalAmount(right);
  if (a === null || b === null) return null;
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const width = Math.max(aFrac.length, bFrac.length);
  const aPad = aFrac.padEnd(width, '0');
  const bPad = bFrac.padEnd(width, '0');
  if (aPad === bPad) return 0;
  return aPad < bPad ? -1 : 1;
}

function evaluateQuote(
  provider: PaidCustomsGateProvider,
  budget: PaidCustomsGateBudget,
  now: Date,
  reasons: CustomsPaidGateReasonCode[],
): string | null {
  if (provider.quotedCost === null) {
    reasons.push('PROVIDER_QUOTE_MISSING');
    return null;
  }
  const quotedCost = normalizeDecimalAmount(provider.quotedCost);
  if (quotedCost === null) {
    reasons.push('PROVIDER_QUOTE_INVALID');
    return null;
  }
  if (provider.quoteCurrency === null || provider.quoteCurrency !== budget.currency) {
    reasons.push('PROVIDER_QUOTE_CURRENCY_MISMATCH');
  }
  // V2-R1 / CHANGE 05：报价**必须**带截止时间；缺失不得视为"永不过期"。
  if (provider.quoteValidUntil === null) {
    reasons.push('PROVIDER_QUOTE_VALIDITY_REQUIRED');
  } else {
    const validUntil = Date.parse(provider.quoteValidUntil);
    if (Number.isNaN(validUntil) || validUntil <= now.getTime()) {
      reasons.push('PROVIDER_QUOTE_EXPIRED');
    }
  }
  return quotedCost;
}

/**
 * 纯判定：不产生任何副作用、不调用 provider、不扣款。
 * 免费路径 + 收费操作 → 立即 HOLD（仅记 FREE_PATH_CANNOT_CALL_PAID_OPERATION）。
 */
export function evaluatePaidCustomsApiGate(input: PaidCustomsApiGateInput): PaidCustomsApiGateResult {
  const freePathPaidAttempt = input.callerPath === 'FREE_SCAN';
  const reasons: CustomsPaidGateReasonCode[] = [];

  if (freePathPaidAttempt) {
    reasons.push('FREE_PATH_CANNOT_CALL_PAID_OPERATION');
  } else {
    if (!input.scope.caseFound) reasons.push('OPPORTUNITY_NOT_FOUND');
    // V2-R1 / CHANGE 05：收费操作必须带机会标识与可判定的归属，缺一即 HOLD。
    if (input.scope.opportunityId === null) {
      reasons.push('OPPORTUNITY_REFERENCE_REQUIRED');
    }
    if (input.scope.opportunityId !== null && input.scope.ownerOrganizationId === null) {
      reasons.push('OPPORTUNITY_OWNERSHIP_UNKNOWN');
    }
    if (
      input.scope.opportunityId !== null &&
      input.scope.ownerOrganizationId !== input.scope.organizationId
    ) {
      reasons.push('OPPORTUNITY_NOT_OWNED');
    }
    if (!input.entitlement.active || input.entitlement.entitlementId === null) {
      reasons.push('NO_ACTIVE_PAID_ENTITLEMENT');
    } else if (input.entitlement.remainingQuota <= 0) {
      reasons.push('INSUFFICIENT_VERIFICATION_QUOTA');
    }
    if (!input.authorization.standingAuthorizationValid) {
      reasons.push('STANDING_AUTHORIZATION_INVALID');
    }
    if (!input.authorization.externalWriteAuthorized) {
      reasons.push('EXTERNAL_WRITE_NOT_AUTHORIZED');
    }
    if (!input.provider.available || input.provider.providerId === null) {
      reasons.push('PROVIDER_NOT_AVAILABLE');
    }
    if (input.killSwitch.engaged) reasons.push('KILL_SWITCH_ENGAGED');
    if (!input.payment.paymentsEnabled) reasons.push('PAYMENTS_NOT_ENABLED');
    if (!input.payment.productionPaymentEnabled) reasons.push('PRODUCTION_PAYMENT_NOT_ENABLED');
    if (input.profitGate.decision !== 'PASS') reasons.push('PROFIT_GATE_HOLD');

    const quotedCost = evaluateQuote(input.provider, input.budget, input.now, reasons);
    if (quotedCost !== null) {
      const perCheck = normalizeDecimalAmount(input.budget.maximumPerCheckCost);
      const tenantBudget = normalizeDecimalAmount(input.budget.tenantRemainingBudget);
      if (perCheck === null || tenantBudget === null) {
        reasons.push('PROVIDER_QUOTE_INVALID');
      } else {
        if (compareDecimalAmounts(quotedCost, perCheck) === 1) {
          reasons.push('PER_CHECK_BUDGET_EXCEEDED');
        }
        if (compareDecimalAmounts(quotedCost, tenantBudget) === 1) {
          reasons.push('TENANT_BUDGET_EXCEEDED');
        }
      }
    }
  }

  const decision: 'ALLOW' | 'HOLD' = reasons.length === 0 ? 'ALLOW' : 'HOLD';
  return {
    kind: 'PAID_CUSTOMS_API_GATE',
    version: PAID_CUSTOMS_API_GATE_VERSION,
    operation: input.operation,
    decision,
    reasonCodes: reasons,
    freePathPaidAttempt,
    paidApiCallPermitted: decision === 'ALLOW' && !freePathPaidAttempt,
    externalCallPerformed: false,
    chargedAmount: null,
    evaluatedAt: input.now.toISOString(),
  };
}

export interface PaidCustomsCallSnapshot {
  /** 验收指标：免费阶段触达收费 API 的次数（必须为 0）。 */
  freeCustomsPaidApiCallCount: number;
  freePathPaidAttemptCount: number;
  blockedPaidCallCount: number;
  permittedPaidCallCount: number;
  permittedOperations: readonly PaidCustomsOperation[];
}

export interface PaidCustomsCallCounter {
  recordFreePathPaidAttempt(): void;
  recordBlocked(result: PaidCustomsApiGateResult): void;
  recordPermitted(operation: PaidCustomsOperation): void;
  snapshot(): PaidCustomsCallSnapshot;
}

/** 进程内计数（可注入测试 / 遥测）；不落库、不涉及任何外部调用。 */
export function createPaidCustomsCallCounter(): PaidCustomsCallCounter {
  let freeAttempts = 0;
  let blocked = 0;
  let permitted = 0;
  const operations: PaidCustomsOperation[] = [];
  return {
    recordFreePathPaidAttempt() {
      freeAttempts += 1;
    },
    recordBlocked(result) {
      blocked += 1;
      if (result.freePathPaidAttempt) freeAttempts += 1;
    },
    recordPermitted(operation) {
      permitted += 1;
      operations.push(operation);
    },
    snapshot() {
      return {
        freeCustomsPaidApiCallCount: freeAttempts,
        freePathPaidAttemptCount: freeAttempts,
        blockedPaidCallCount: blocked,
        permittedPaidCallCount: permitted,
        permittedOperations: [...operations],
      };
    },
  };
}

export class FreeCustomsPaidApiCallViolation extends Error {
  readonly code = 'FREE_CUSTOMS_PAID_API_CALL_COUNT_NONZERO';
  readonly snapshot: PaidCustomsCallSnapshot;

  constructor(snapshot: PaidCustomsCallSnapshot) {
    super(`FREE_CUSTOMS_PAID_API_CALL_COUNT=${snapshot.freeCustomsPaidApiCallCount} (expected 0)`);
    this.name = 'FreeCustomsPaidApiCallViolation';
    this.snapshot = snapshot;
  }
}

/** 验收断言：免费阶段触达收费 API 的次数必须为 0。 */
export function assertNoFreeCustomsPaidApiCalls(
  counter: PaidCustomsCallCounter,
): PaidCustomsCallSnapshot {
  const snapshot = counter.snapshot();
  if (snapshot.freeCustomsPaidApiCallCount !== 0) {
    throw new FreeCustomsPaidApiCallViolation(snapshot);
  }
  return snapshot;
}

/**
 * 出站方法白名单：provider 契约里所有会产生外部（可能计费）调用的方法。
 * V2-02：补齐 getSubmission（此前漏包 → 可直接绕过 Gate 的读出口）。
 * 新增方法若不进入本表 → assertProviderFullyGated 运行期拒绝（fail-closed）。
 */
export const CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS = [
  'readData',
  'lookupRate',
  'createSubmission',
  'uploadEvidence',
  'getSubmission',
  'getSubmissionStatus',
  'listRequestsForInformation',
  'respondToRequest',
  'getRefundStatus',
] as const;
export type CustomsFilingProviderOutboundMethod =
  (typeof CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS)[number];

/**
 * operation ⇄ 方法名 双向穷尽映射：任一方向缺少成员都会编译失败
 * （Record 的 key 穷尽性检查），从而不可能"悄悄"新增一个未受 Gate 约束的出站出口。
 */
export const METHOD_BY_OPERATION: Record<PaidCustomsOperation, CustomsFilingProviderOutboundMethod> = {
  DATA_READ: 'readData',
  RATE_LOOKUP: 'lookupRate',
  FILING_CREATE: 'createSubmission',
  DOCUMENT_UPLOAD: 'uploadEvidence',
  SUBMISSION_READ: 'getSubmission',
  STATUS_READ: 'getSubmissionStatus',
  RFI_READ: 'listRequestsForInformation',
  RFI_RESPOND: 'respondToRequest',
  REFUND_STATUS: 'getRefundStatus',
};

export const OPERATION_BY_METHOD: Record<CustomsFilingProviderOutboundMethod, PaidCustomsOperation> = {
  readData: 'DATA_READ',
  lookupRate: 'RATE_LOOKUP',
  createSubmission: 'FILING_CREATE',
  uploadEvidence: 'DOCUMENT_UPLOAD',
  getSubmission: 'SUBMISSION_READ',
  getSubmissionStatus: 'STATUS_READ',
  listRequestsForInformation: 'RFI_READ',
  respondToRequest: 'RFI_RESPOND',
  getRefundStatus: 'REFUND_STATUS',
};

/** C15 operation → provider 方法名（唯一收费调用通道的映射表）。 */
export function operationMethodName(operation: PaidCustomsOperation): string {
  return METHOD_BY_OPERATION[operation];
}

export interface WrapPaidCustomsProviderOptions<TProvider extends object> {
  provider: TProvider;
  counter: PaidCustomsCallCounter;
  /** 每次调用前解析上下文；返回 null → HOLD（fail-closed）。 */
  resolveContext: (operation: PaidCustomsOperation) => PaidCustomsGateContext | null;
  now?: () => Date;
}

function holdResult(operation: PaidCustomsOperation, now: Date): PaidCustomsApiGateResult {
  return {
    kind: 'PAID_CUSTOMS_API_GATE',
    version: PAID_CUSTOMS_API_GATE_VERSION,
    operation,
    decision: 'HOLD',
    reasonCodes: ['PROVIDER_NOT_AVAILABLE'],
    freePathPaidAttempt: false,
    paidApiCallPermitted: false,
    externalCallPerformed: false,
    chargedAmount: null,
    evaluatedAt: now.toISOString(),
  };
}

/**
 * 唯一收费关税调用通道：包装 provider 的每一个出站 operation。
 * - 未过 Gate → 记 blocked，抛 CustomsPaidApiGateError；绝不触达底层 provider。
 * - 过 Gate → 记 permitted 后委派底层实现。
 */
export function wrapPaidCustomsProvider<TProvider extends object>(
  options: WrapPaidCustomsProviderOptions<TProvider>,
): TProvider {
  const { provider, counter, resolveContext } = options;
  const now = options.now ?? (() => new Date());

  function guarded<TResult>(
    operation: PaidCustomsOperation,
    invoke: () => Promise<TResult>,
  ): Promise<TResult> {
    const context = resolveContext(operation);
    if (context === null) {
      const blocked = holdResult(operation, now());
      counter.recordBlocked(blocked);
      return Promise.reject(new CustomsPaidApiGateError(blocked));
    }
    const result = evaluatePaidCustomsApiGate({ ...context, operation, now: now() });
    if (result.decision !== 'ALLOW') {
      counter.recordBlocked(result);
      return Promise.reject(new CustomsPaidApiGateError(result));
    }
    counter.recordPermitted(operation);
    return invoke();
  }

  // V2-R1 / CHANGE 04：**不**用 Object.create(provider) —— 那会把原始 provider 变成原型，
  // 业务层可通过原型链拿到未包装的原始方法。这里构造无原型逃逸的最小权限对象。
  const wrapped: Record<string, unknown> = {};
  for (const name of SAFE_PROVIDER_METADATA_KEYS) {
    const value = readOwnDataProperty(provider, name);
    if (isSafeMetadataValue(value) && value !== undefined) wrapped[name] = value;
  }
  const capabilities = safeCapabilitiesCopy(readOwnDataProperty(provider, 'capabilities'));
  if (capabilities !== undefined) wrapped.capabilities = capabilities;
  for (const operation of PAID_CUSTOMS_OPERATIONS) {
    const key = operationMethodName(operation);
    const original = (provider as unknown as Record<string, unknown>)[key];
    if (typeof original !== 'function') continue;
    wrapped[key] = (input: unknown) =>
      guarded(operation, () =>
        (original as (value: unknown) => Promise<unknown>).call(provider, input),
      );
  }
  return wrapped as unknown as TProvider;
}

export class CustomsProviderUngatedExitError extends Error {
  readonly code = 'CUSTOMS_PROVIDER_UNGATED_EXIT';
  readonly methods: readonly string[];

  constructor(methods: readonly string[]) {
    super(`CUSTOMS_PROVIDER_UNGATED_EXIT:${methods.join(',')}`);
    this.name = 'CustomsProviderUngatedExitError';
    this.methods = methods;
  }
}

/** V2-R1 / CHANGE 04：出现未声明的可调用出口（含原型与符号方法）→ 结构性封闭失败。 */
export class CustomsProviderUndeclaredExitError extends Error {
  readonly code = 'CUSTOMS_PROVIDER_UNDECLARED_EXIT';
  readonly exits: readonly string[];

  constructor(exits: readonly string[]) {
    super(`CUSTOMS_PROVIDER_UNDECLARED_EXIT:${exits.join(',')}`);
    this.name = 'CustomsProviderUndeclaredExitError';
    this.exits = exits;
  }
}

/** 遍历实例自身 + 原型链 + 符号方法，收集**全部**可调用出口。 */
export function collectProviderFunctionExits(provider: object): string[] {
  const names = new Set<string>();
  let current: object | null = provider;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor') continue;
      if (typeof (current as Record<string, unknown>)[name] === 'function') names.add(name);
    }
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      if (typeof (current as Record<symbol, unknown>)[symbol] === 'function') {
        names.add(symbol.toString());
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names].sort();
}

/**
 * V2-R2 / CHANGE 11：包装**只**允许携带显式白名单里的安全元数据。
 * 不再自动复制 provider 的非函数属性——那会把内部 HTTP client / transport 等
 * 引用对象一并交出去，且在读取 getter 时触发副作用。
 */
export const SAFE_PROVIDER_METADATA_KEYS = ['providerId', 'displayName'] as const;

/** 只读**自有数据属性**的描述符（绝不触发 getter，也不沿原型链取值）。 */
function readOwnDataProperty(provider: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(provider, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/** capabilities 只保留显式 true 的布尔声明，并冻结为**新的**对象（不交原始引用）。 */
function safeCapabilitiesCopy(value: unknown): Readonly<Record<string, true>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const copy: Record<string, true> = {};
  for (const key of Object.keys(source)) {
    if (source[key] === true) copy[key] = true;
  }
  return Object.freeze(copy);
}

/** 仅接受原始值元数据；对象 / 函数一律不复制。 */
function isSafeMetadataValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * 全出口覆盖断言：provider 上存在的每一个出站方法，在包装结果上都必须是**新函数**。
 * 若包装结果仍直接暴露原函数（漏包 / 被覆盖 / 事后被人为还原）→ 抛错，fail-closed。
 */
export function assertProviderFullyGated<T extends object>(
  original: T,
  wrapped: T,
  options: { allowExtraExits?: readonly string[] } = {},
): void {
  // (1) 结构性封闭：任何未声明的可调用出口（含原型/符号）都视为越权能力
  const allowed = new Set(options.allowExtraExits ?? []);
  const declared = new Set<string>(CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS);
  const undeclared = collectProviderFunctionExits(original).filter(
    (name) => !declared.has(name) && !allowed.has(name),
  );
  if (undeclared.length > 0) throw new CustomsProviderUndeclaredExitError(undeclared);

  // (2) 已声明出口必须确实被包装（引用不同）
  const originalRecord = original as unknown as Record<string, unknown>;
  const wrappedRecord = wrapped as unknown as Record<string, unknown>;
  const ungated = CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS.filter((method) => {
    const target = originalRecord[method];
    if (typeof target !== 'function') return false;
    return wrappedRecord[method] === target;
  });
  if (ungated.length > 0) throw new CustomsProviderUngatedExitError(ungated);
}

/** 边界自证：本模块不产生外部调用 / 资金动作。 */
export const CUSTOMS_PAID_API_GATE_BOUNDARY = {
  externalCallPerformed: false,
  providerInvoked: false,
  chargedAmount: null,
  paymentCaptured: false,
  autoCollectionEnabled: false,
  refundCollected: false,
  successFeeCalculated: false,
  transportEnabled: false,
  platformWriteEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
