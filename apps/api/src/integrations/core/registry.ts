/**
 * HOST BACKEND ARCHITECTURE DIRECTIVE §4 / §31 — Provider Integration Layer **骨架**（core registry）。
 * ---------------------------------------------------------------
 * 只做三件事：
 *   1) 把既有 provider 契约（connector-capability / carrier-auth-contract / tracking / invoice / POD adapter）按 provider 聚合成一个绑定；
 *   2) 显式标出真实网络实现状态（本批恒 `networkImplemented=false`，HOLD_EXTERNAL）；
 *   3) 未知 provider 一律 fail-closed。
 * **禁止**：复制事实源、发起网络请求、写入、启用 TRANSPORT、绕过既有 tenant / credentialRef 边界。
 */

import type { CarrierAuthContract } from '../../services/carriers/carrier-auth-contract';
import { resolveCarrierAuthContract } from '../../services/carriers/carrier-auth-contract';
import type { CarrierInvoiceAdapter, CarrierPODAdapter } from '../../services/carriers/carrier-invoice-pod-read';
import { resolveCarrierInvoiceAdapter, resolveCarrierPODAdapter } from '../../services/carriers/carrier-invoice-pod-read';
import type { CarrierTrackingAdapter } from '../../services/carriers/carrier-tracking-read';
import { resolveCarrierTrackingAdapter } from '../../services/carriers/carrier-tracking-read';
import type { CarrierProvider } from '../../services/carriers/connector-capability';

export const CARRIER_PROVIDER_IDS = ['UPS', 'FEDEX'] as const;

export interface CarrierProviderAdapterBinding {
  provider: CarrierProvider;
  authContract: CarrierAuthContract;
  trackingAdapter: CarrierTrackingAdapter;
  invoiceAdapter: CarrierInvoiceAdapter;
  podAdapter: CarrierPODAdapter;
  /** §4：真实 provider 网络实现状态（本批恒 false —— HOLD_EXTERNAL）。 */
  networkImplemented: false;
  platformWriteEnabled: false;
  transportEnabled: false;
}

export class ProviderAdapterRegistryError extends Error {
  readonly code = 'CARRIER_PROVIDER_UNKNOWN';
  constructor(readonly provider: string) {
    super('CARRIER_PROVIDER_UNKNOWN:' + provider);
    this.name = 'ProviderAdapterRegistryError';
  }
}

/** 真实网络调用未实现（HOLD_EXTERNAL）：调用方必须显式处理，不得静默降级。 */
export class ProviderNetworkNotImplementedError extends Error {
  readonly code = 'PROVIDER_NETWORK_NOT_IMPLEMENTED';
  constructor(readonly provider: string) {
    super('PROVIDER_NETWORK_NOT_IMPLEMENTED:' + provider);
    this.name = 'ProviderNetworkNotImplementedError';
  }
}

function buildBinding(provider: CarrierProvider): CarrierProviderAdapterBinding | null {
  const authContract = resolveCarrierAuthContract(provider);
  const trackingAdapter = resolveCarrierTrackingAdapter(provider);
  const invoiceAdapter = resolveCarrierInvoiceAdapter(provider);
  const podAdapter = resolveCarrierPODAdapter(provider);
  if (!authContract || !trackingAdapter || !invoiceAdapter || !podAdapter) return null;
  return {
    provider,
    authContract,
    trackingAdapter,
    invoiceAdapter,
    podAdapter,
    networkImplemented: false,
    platformWriteEnabled: false,
    transportEnabled: false,
  };
}

const REGISTRY: readonly CarrierProviderAdapterBinding[] = CARRIER_PROVIDER_IDS.map((provider) => {
  const binding = buildBinding(provider);
  if (!binding) throw new ProviderAdapterRegistryError(provider);
  return binding;
});

/** 未知 provider → null（fail-closed，不猜测）。 */
export function resolveCarrierProviderAdapter(provider: string): CarrierProviderAdapterBinding | null {
  return REGISTRY.find((binding) => binding.provider === provider.toUpperCase()) ?? null;
}

export function listCarrierProviderAdapters(): readonly CarrierProviderAdapterBinding[] {
  return REGISTRY;
}

export function requireCarrierProviderAdapter(provider: string): CarrierProviderAdapterBinding {
  const binding = resolveCarrierProviderAdapter(provider);
  if (!binding) throw new ProviderAdapterRegistryError(provider);
  return binding;
}

/** 显式占位：任何真实 provider 调用在 HOLD_EXTERNAL 期间都必须走这里失败。 */
export function requireCarrierNetworkAdapter(provider: string): never {
  requireCarrierProviderAdapter(provider);
  throw new ProviderNetworkNotImplementedError(provider);
}
