/**
 * MSG-20261001-22 CHANGE C/D 验收：typed adapter capability registry + transport 双重门控
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  PLATFORM_WRITE_TRANSPORT_ENABLED,
  evaluateAdapterEligibility,
  evaluateTransportGate,
  getAdapterCapability,
  listAdapterCapabilities,
  registerAdapterCapability,
  resetAdapterCapabilityRegistry,
} from '../services/platform-write';

const FULL = {
  platform: 'simulated-full',
  idempotentWrite: true,
  statusQuery: true,
  ambiguousResponseSemantics: true,
} as const;

beforeEach(() => resetAdapterCapabilityRegistry());

describe('MSG-20261001-22 · adapter 能力注册表与 transport 双重门控', () => {
  it('01 未注册 adapter → fail-closed（NEEDS_MANUAL 语义）', () => {
    expect(getAdapterCapability('nope')).toBeNull();
    const e = evaluateAdapterEligibility('nope');
    expect(e.registered).toBe(false);
    expect(e.eligibleForAutomaticWrite).toBe(false);
    expect(e.reason).toBe('ADAPTER_NOT_REGISTERED');
  });

  it('02 缺 idempotentWrite → 不允许自动 write', () => {
    registerAdapterCapability({ ...FULL, platform: 'no-idem', idempotentWrite: false });
    const e = evaluateAdapterEligibility('no-idem');
    expect(e.eligibleForAutomaticWrite).toBe(false);
    expect(e.reason).toBe('IDEMPOTENT_WRITE_MISSING');
  });

  it('03 ambiguous 语义未定义 → 不允许自动 write', () => {
    registerAdapterCapability({ ...FULL, platform: 'no-amb', ambiguousResponseSemantics: false });
    const e = evaluateAdapterEligibility('no-amb');
    expect(e.eligibleForAutomaticWrite).toBe(false);
    expect(e.reason).toBe('AMBIGUOUS_RESPONSE_SEMANTICS_UNDEFINED');
  });

  it('04 缺 statusQuery → 允许 write 但禁止自动 reconciliation', () => {
    registerAdapterCapability({ ...FULL, platform: 'no-status', statusQuery: false });
    const e = evaluateAdapterEligibility('no-status');
    expect(e.eligibleForAutomaticWrite).toBe(true);
    expect(e.eligibleForAutomaticReconciliation).toBe(false);
    expect(e.reason).toBe('STATUS_QUERY_MISSING');
  });

  it('05 三能力齐备 → ELIGIBLE（仍不等于 transport 已开启）', () => {
    registerAdapterCapability(FULL);
    const e = evaluateAdapterEligibility(FULL.platform);
    expect(e.reason).toBe('ELIGIBLE');
    expect(e.eligibleForAutomaticWrite).toBe(true);
    expect(listAdapterCapabilities().map((c) => c.platform)).toEqual([FULL.platform]);
  });

  it('06 重复注册同一 platform → 拒绝（配置错误）', () => {
    registerAdapterCapability(FULL);
    expect(() => registerAdapterCapability(FULL)).toThrowError(/ADAPTER_CAPABILITY_ALREADY_REGISTERED/);
    expect(() => registerAdapterCapability({ ...FULL, platform: '  ' })).toThrowError(/PLATFORM_REQUIRED/);
  });

  it('07 双重门控：全局 gate 关闭 → 即使 adapter 全能力也不得调用 transport', () => {
    registerAdapterCapability(FULL);
    expect(PLATFORM_WRITE_TRANSPORT_ENABLED).toBe(false);
    const g = evaluateTransportGate({ platform: FULL.platform, authorizationValid: true });
    expect(g.transportAllowed).toBe(false);
    expect(g.reason).toBe('GLOBAL_GATE_DISABLED');
  });

  it('08 双重门控：gate ON 但 adapter 不合格 / 授权无效同样 fail-closed；四项齐备才 allowed', () => {
    registerAdapterCapability({ ...FULL, platform: 'weak', idempotentWrite: false });
    const weak = evaluateTransportGate({ platform: 'weak', authorizationValid: true, globalTransportEnabled: true });
    expect(weak.transportAllowed).toBe(false);
    expect(weak.reason).toBe('ADAPTER_NOT_ELIGIBLE');

    const unknown = evaluateTransportGate({ platform: 'unknown', authorizationValid: true, globalTransportEnabled: true });
    expect(unknown.transportAllowed).toBe(false);
    expect(unknown.reason).toBe('ADAPTER_NOT_ELIGIBLE');

    registerAdapterCapability(FULL);
    const noAuth = evaluateTransportGate({ platform: FULL.platform, authorizationValid: false, globalTransportEnabled: true });
    expect(noAuth.transportAllowed).toBe(false);
    expect(noAuth.reason).toBe('AUTHORIZATION_INVALID');

    const all = evaluateTransportGate({ platform: FULL.platform, authorizationValid: true, globalTransportEnabled: true });
    expect(all.transportAllowed).toBe(true);
    expect(all.reason).toBe('TRANSPORT_ALLOWED');
  });
});
