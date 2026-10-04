/** Daily Health Inspection 验收：健康静默、异常产出信号、覆盖三类检查项、只读探针。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_DAILY_CHECKS,
  RSI_DAILY_INSPECTION_BOUNDARY,
  runDailyInspection,
} from '../services/autonomy/rsi-daily-inspection';

const NOW = new Date('2026-10-05T03:00:00.000Z');
const ok = async () => ({ ok: true });
const bad = async () => ({ ok: false });

describe('RSI Daily Health Inspection', () => {
  it('RSI_DAILY_CATALOG_COVERS_ALL_CATEGORIES：检查项覆盖 Runtime / API-Provider / Application', () => {
    const categories = new Set(RSI_DAILY_CHECKS.map((check) => check.category));
    expect([...categories].sort()).toEqual(['API_PROVIDER', 'APPLICATION', 'RUNTIME']);
    // 关键项必须存在
    const ids = RSI_DAILY_CHECKS.map((check) => check.id);
    for (const required of [
      'API_AVAILABILITY',
      'DB_HEALTH',
      'CONTRACT_DRIFT',
      'OAUTH_FAILURE',
      'WEBHOOK_MISMATCH',
      'KEY_ROUTES_AVAILABLE',
      'CRITICAL_WORKFLOW_STATES',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it('RSI_DAILY_SILENT_WHEN_HEALTHY：全部探针健康 → 零信号（不写噪声）', async () => {
    const report = await runDailyInspection({
      now: NOW,
      probes: Object.fromEntries(RSI_DAILY_CHECKS.map((check) => [check.id, ok])),
    });
    expect(report.healthy).toBe(true);
    expect(report.signals).toEqual([]);
    expect(report.checked).toBe(RSI_DAILY_CHECKS.length);
    expect(report.job).toBe('RSI_DAILY_HEALTH_INSPECTION');
  });

  it('RSI_DAILY_DETECTS_RUNTIME_AND_PROVIDER_ISSUES：失败项产出带 dedupeKey 的信号，HIGH 项必须建 Incident', async () => {
    const report = await runDailyInspection({
      now: NOW,
      probes: {
        API_AVAILABILITY: bad,
        OAUTH_FAILURE: bad,
        LATENCY_REGRESSION: async () => ({ ok: true, metric: 900, threshold: 300 }),
        DB_HEALTH: ok,
      },
    });
    expect(report.healthy).toBe(false);
    const byId = new Map(report.signals.map((signal) => [signal.checkId, signal]));
    expect(byId.get('API_AVAILABILITY')?.incidentRequired).toBe(true);
    expect(byId.get('OAUTH_FAILURE')?.riskClass).toBe('HIGH');
    // 阈值型：ok 但超阈值也算异常，且 MEDIUM 不强制建 Incident
    expect(byId.get('LATENCY_REGRESSION')?.incidentRequired).toBe(false);
    for (const signal of report.signals) {
      expect(signal.dedupeKey).toBe(`DAILY_INSPECTION:${signal.checkId}:2026-10-05`);
      expect(signal.summary).not.toMatch(/@|\+?\d[\d\s-]{7,}\d/); // 无邮箱/电话
    }
  });

  it('RSI_DAILY_SECURITY_AFFECTING_ALWAYS_INCIDENT：触及安全/权限的异常即使 LOW 也必须建 Incident', async () => {
    const report = await runDailyInspection({
      now: NOW,
      probes: {
        MISSING_CONFIGURATION: async () => ({ ok: false, securityAffecting: true }),
        FRONTEND_BACKEND_CONTRACT: async () => ({ ok: false, privilegeAffecting: true }),
      },
    });
    for (const signal of report.signals) expect(signal.incidentRequired).toBe(true);
    expect(report.signals.find((s) => s.checkId === 'FRONTEND_BACKEND_CONTRACT')?.riskClass).toBe('HIGH');

    // 只读边界自证
    expect(RSI_DAILY_INSPECTION_BOUNDARY.readOnlyProbes).toBe(true);
    expect(RSI_DAILY_INSPECTION_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_DAILY_INSPECTION_BOUNDARY.performsExternalWrite).toBe(false);
    expect(RSI_DAILY_INSPECTION_BOUNDARY.readsCredentials).toBe(false);
  });
});
