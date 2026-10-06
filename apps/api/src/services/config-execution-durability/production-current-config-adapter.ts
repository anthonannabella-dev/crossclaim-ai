// P6-PROD-U1 —— Production Current Config Adapter（严格**只读**）
// 允许：read / fingerprint / compare / validate / detect drift / 生成 baseline snapshot
// 禁止：write / apply / promote / rollout / rollback / mutation（模块不导出任何写入入口）
// production mutation switch 必须继续 false；本适配器不是打开生产的通道。

import { digestOf } from './digests';

export const PRODUCTION_CURRENT_CONFIG_ADAPTER_BOUNDARY = {
  mode: 'READ_ONLY',
  allowed: ['read', 'fingerprint', 'compare', 'validate', 'detectDrift', 'snapshot'],
  forbidden: ['write', 'apply', 'promote', 'rollout', 'rollback', 'mutation'],
  productionMutation: false,
} as const;

export interface ProductionCurrentConfigSnapshot {
  target: string;
  configFingerprint: string;
  version: string;
  capturedAt: string;
  configValues: Readonly<Record<string, string>>;
}

export interface ProductionCurrentConfigReadPort {
  read(target: string): Promise<ProductionCurrentConfigSnapshot>;
}

export function computeConfigFingerprint(configValues: Record<string, string>): string {
  return digestOf(configValues);
}

export type BaselineFreshness =
  | 'FRESH'
  | 'STALE_CONFIG_FINGERPRINT'
  | 'STALE_VERSION'
  | 'PATH_VALUE_MISMATCH';

/** 执行瞬间的三重身份校验（只判定，不写）。 */
export function compareToAuthorizedBaseline(
  observed: ProductionCurrentConfigSnapshot,
  expected: {
    expectedBaselineConfigFingerprint: string;
    expectedLiveConfigVersion: string;
    configPath: string;
    expectedPathValue: string;
  },
): BaselineFreshness {
  if (observed.configFingerprint !== expected.expectedBaselineConfigFingerprint) {
    return 'STALE_CONFIG_FINGERPRINT';
  }
  if (observed.version !== expected.expectedLiveConfigVersion) return 'STALE_VERSION';
  if (observed.configValues[expected.configPath] !== expected.expectedPathValue) {
    return 'PATH_VALUE_MISMATCH';
  }
  return 'FRESH';
}

export interface ConfigDriftReport {
  drifted: boolean;
  reasons: string[];
}

/** 漂移检测：给对账与执行前检查用；只读、纯函数。 */
export function detectConfigDrift(
  observed: ProductionCurrentConfigSnapshot,
  planned: { expectedConfigFingerprint: string; configPath: string; expectedValue: string },
): ConfigDriftReport {
  const reasons: string[] = [];
  if (observed.configFingerprint !== planned.expectedConfigFingerprint) {
    reasons.push('CONFIG_FINGERPRINT_DRIFT');
  }
  const actual = observed.configValues[planned.configPath];
  if (actual === undefined) reasons.push('CONFIG_PATH_MISSING');
  else if (actual !== planned.expectedValue) reasons.push('CONFIG_PATH_VALUE_DRIFT');
  return { drifted: reasons.length > 0, reasons };
}

export interface ReadOnlyCurrentConfigAdapterOptions {
  target: string;
  version: string;
  configValues: Record<string, string>;
  capturedAt?: string;
  /** 测试注入：只读读取失败（用于 crash / unknown-outcome 分类）。 */
  failRead?: boolean;
}

/**
 * 只读适配器（含测试注入点）。
 * 返回的 snapshot 是深冻结副本：调用方无法通过返回值反向改写「当前配置」。
 */
export function createReadOnlyCurrentConfigAdapter(
  options: ReadOnlyCurrentConfigAdapterOptions,
): ProductionCurrentConfigReadPort {
  const failRead = options.failRead === true;
  return {
    async read(target: string): Promise<ProductionCurrentConfigSnapshot> {
      if (failRead) throw new Error('CURRENT_CONFIG_READ_UNAVAILABLE');
      if (target !== options.target) throw new Error('CURRENT_CONFIG_TARGET_UNKNOWN');
      const values: Record<string, string> = { ...options.configValues };
      return Object.freeze({
        target: options.target,
        configFingerprint: computeConfigFingerprint(values),
        version: options.version,
        capturedAt: options.capturedAt ?? new Date().toISOString(),
        configValues: Object.freeze(values),
      });
    },
  };
}
