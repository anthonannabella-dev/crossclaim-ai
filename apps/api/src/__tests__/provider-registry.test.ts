/**
 * HOST DIRECTIVE §4/§31 — Provider Integration Layer registry 回归。
 * 断言：UPS/FedEx 绑定完整且与既有契约同一来源；未知 provider fail-closed；真实网络实现恒 false；无写 / 无 TRANSPORT。
 */

import { describe, expect, it } from 'vitest';

import {
  CARRIER_PROVIDER_IDS,
  ProviderAdapterRegistryError,
  ProviderNetworkNotImplementedError,
  listCarrierProviderAdapters,
  requireCarrierNetworkAdapter,
  requireCarrierProviderAdapter,
  resolveCarrierProviderAdapter,
} from '../integrations/core/registry';
import { resolveCarrierAuthContract } from '../services/carriers/carrier-auth-contract';
import { resolveCarrierPODAdapter } from '../services/carriers/carrier-invoice-pod-read';
import { resolveCarrierTrackingAdapter } from '../services/carriers/carrier-tracking-read';

describe('Provider Integration Layer — registry', () => {
  it('UPS / FedEx 均有绑定；未知 provider → null / 抛错', () => {
    expect(listCarrierProviderAdapters()).toHaveLength(2);
    expect(resolveCarrierProviderAdapter('ups')?.provider).toBe('UPS');
    expect(resolveCarrierProviderAdapter('DHL')).toBeNull();
    expect(() => requireCarrierProviderAdapter('DHL')).toThrow(ProviderAdapterRegistryError);
  });

  it('绑定与既有契约同一来源（不复制事实）', () => {
    for (const provider of CARRIER_PROVIDER_IDS) {
      const binding = requireCarrierProviderAdapter(provider);
      expect(binding.authContract).toBe(resolveCarrierAuthContract(provider));
      expect(binding.trackingAdapter).toBe(resolveCarrierTrackingAdapter(provider));
      expect(binding.podAdapter).toBe(resolveCarrierPODAdapter(provider));
      expect(binding.authContract.provider).toBe(provider);
    }
  });

  it('真实网络实现恒 false；platform write / TRANSPORT 恒 false', () => {
    for (const binding of listCarrierProviderAdapters()) {
      expect(binding.networkImplemented).toBe(false);
      expect(binding.platformWriteEnabled).toBe(false);
      expect(binding.transportEnabled).toBe(false);
    }
    expect(() => requireCarrierNetworkAdapter('UPS')).toThrow(ProviderNetworkNotImplementedError);
    expect(() => requireCarrierNetworkAdapter('NOT_A_CARRIER')).toThrow(ProviderAdapterRegistryError);
  });
});
