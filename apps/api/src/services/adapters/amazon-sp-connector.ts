/**
 * Amazon SP-API READ-ONLY Connector Bridge（MSG-20261001-26 CHANGE B / R41）
 * ---------------------------------------------------------------
 * 目标：把 Amazon 只读 adapter 接入**既有** Connector Runner / ClaimItem / Quarantine 链路，
 * 证明 Amazon adapter 没有形成平行的 ingest / 幂等 / quarantine 实现。
 *
 * 复用（不重复实现）：
 *   · connector 契约：`ConnectorDescriptor` / `Fetcher` / `Normalizer`（services/connectors/types）
 *   · 幂等与指纹：`sourceFingerprintV1` + `FINGERPRINT_VERSION`（services/claim/source-fingerprint）
 *   · 落库与审计：由 Runner 调 `createClaimItem(..., creationContext='CONNECTOR_IMPORT')`
 *   · 游标：Runner 的 `CursorStore`（一页一推进）
 *   · quarantine：Runner 的 `QuarantineSink`（白名单字段）
 *
 * 边界：本模块不写库、不读 env、不读凭据、不发网络请求（transport / credential 端口由调用方注入）；
 * 不引用任何 platform-write 能力。
 */

import { FINGERPRINT_VERSION, sourceFingerprintV1 } from '../claim/source-fingerprint';
import type {
  ConnectorDescriptor,
  Fetcher,
  FetcherPage,
  NormalizeResult,
  Normalizer,
} from '../connectors/types';
import {
  AmazonAdapterBoundaryError,
  fetchAmazonReadPage,
  type AmazonCredentialPort,
  type AmazonReadTransport,
} from './amazon-sp-read-only-adapter';

export const AMAZON_SP_NORMALIZER_VERSION = 'amazon-sp-orders-normalizer/v1';
export const AMAZON_SP_CLAIM_TYPE = 'ORDER_DISCREPANCY';

/** 只读连接器描述符（只读 scope 非空；无 write scope） */
export const AMAZON_SP_READ_ONLY_CONNECTOR: ConnectorDescriptor = {
  connectorId: 'amazon-sp-orders-readonly-v1',
  platformType: 'AMAZON',
  authKind: 'OAUTH',
  readonlyScopes: ['sellingpartnerapi::orders:read'],
  resources: ['orders'],
  rateLimitPerMinute: 360,
};

/** resource → 已登记只读 operation（不存在映射 = 未登记 = fail-closed） */
export const AMAZON_READ_OPERATION_BY_RESOURCE: Readonly<Record<string, string>> = {
  orders: 'getOrders',
};

export interface AmazonConnectorFetcherDeps {
  transport: AmazonReadTransport;
  credentials: AmazonCredentialPort;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * 把只读 adapter 暴露为既有 `Fetcher` 端口：**单页拉取**，nextToken 作为 nextCursor 交给 Runner 持久化。
 */
export function createAmazonConnectorFetcher(deps: AmazonConnectorFetcherDeps): Fetcher {
  const now = deps.now ?? (() => new Date());
  return {
    async pull(input: { resource: string; cursor: string | null; limit: number }): Promise<FetcherPage> {
      const operation = AMAZON_READ_OPERATION_BY_RESOURCE[input.resource];
      if (!operation) {
        throw new AmazonAdapterBoundaryError(
          'OPERATION_NOT_REGISTERED',
          'resource 未登记只读 operation: ' + input.resource,
        );
      }
      const page = await fetchAmazonReadPage(
        { transport: deps.transport, credentials: deps.credentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
        {
          operation,
          resource: input.resource,
          query: { MaxResultsPerPage: String(input.limit) },
          maxAttempts: 3,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
      );
      const fetchedAt = now();
      return {
        records: page.records.map((payload, index) => {
          const record = (payload ?? {}) as Record<string, unknown>;
          const resourceRef =
            typeof record.AmazonOrderId === 'string' ? record.AmazonOrderId : 'unidentified-' + String(index);
          return { resourceRef, payload: record, fetchedAt };
        }),
        nextCursor: page.nextToken,
      };
    },
  };
}

/**
 * Amazon order → 既有 NormalizerOutput（只做形状归一化；金额判断留给 Rule Engine）。
 * 指纹必须复用 `sourceFingerprintV1`（不用 Amazon 自己的哈希）。
 */
export function createAmazonConnectorNormalizer(): Normalizer {
  return {
    normalizerVersion: AMAZON_SP_NORMALIZER_VERSION,
    platformType: AMAZON_SP_READ_ONLY_CONNECTOR.platformType,
    normalize(record): NormalizeResult {
      const payload = (record?.payload ?? null) as Record<string, unknown> | null;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, reasonCode: 'INVALID_TYPE' };
      }
      const orderId = typeof payload.AmazonOrderId === 'string' ? payload.AmazonOrderId : null;
      if (!orderId) return { ok: false, reasonCode: 'IDENTITY_UNAVAILABLE' };

      const purchaseDate = typeof payload.PurchaseDate === 'string' ? payload.PurchaseDate : null;
      if (!purchaseDate) return { ok: false, reasonCode: 'MISSING_FIELD' };
      const occurredAt = new Date(purchaseDate);
      if (Number.isNaN(occurredAt.getTime())) return { ok: false, reasonCode: 'INVALID_TYPE' };

      const orderTotal = (payload.OrderTotal ?? null) as Record<string, unknown> | null;
      const amount = orderTotal && typeof orderTotal.Amount === 'string' ? orderTotal.Amount : null;
      if (!amount) return { ok: false, reasonCode: 'AMOUNT_FORMAT' };
      const currency =
        orderTotal && typeof orderTotal.CurrencyCode === 'string' && orderTotal.CurrencyCode !== ''
          ? orderTotal.CurrencyCode
          : 'USD';

      const normalizedRef = 'amazon-sp::orders::' + orderId;
      const fingerprint = sourceFingerprintV1({
        platformType: AMAZON_SP_READ_ONLY_CONNECTOR.platformType,
        claimType: AMAZON_SP_CLAIM_TYPE,
        occurredAt,
        normalizedRef,
        currency,
      });

      return {
        ok: true,
        output: {
          platformType: AMAZON_SP_READ_ONLY_CONNECTOR.platformType,
          claimType: AMAZON_SP_CLAIM_TYPE,
          occurredAt,
          amountExpected: amount,
          amountActual: null,
          currency,
          responsibleParty: 'PLATFORM',
          normalizedRef,
          normalizerVersion: AMAZON_SP_NORMALIZER_VERSION,
          sourceFingerprintCandidate: fingerprint.fingerprint,
        },
      };
    },
  };
}

/** 供测试/组合根断言：指纹版本必须与既有 Claim 链路一致（不另起版本） */
export const AMAZON_CONNECTOR_FINGERPRINT_VERSION = FINGERPRINT_VERSION;
