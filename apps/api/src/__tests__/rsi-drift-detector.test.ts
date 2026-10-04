/** RSI 功能漂移判定与业务不变量验收。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_INSPECTION_SCHEDULE,
  classifyDrift,
  evaluateBusinessInvariants,
  inspectSurfaces,
} from '../services/autonomy/rsi-drift-detector';

const base = { surface: 'API_RESPONSE_CONTRACT' as const, baseline: 'h1', current: 'h1' };

describe('RSI 功能漂移判定', () => {
  it('RSI_DRIFT_NO_CHANGE_IS_NOT_AN_INCIDENT：无变化不产生 Incident（静默）', () => {
    const finding = classifyDrift(base);
    expect(finding.changed).toBe(false);
    expect(finding.incidentRequired).toBe(false);
    expect(finding.reasonCode).toBe('NO_CHANGE');
  });

  it('RSI_DRIFT_UNKNOWN_AND_REGRESSION_CREATE_INCIDENT：未声明的行为变化 → REGRESSION 且必须建 Incident', () => {
    const finding = classifyDrift({ ...base, current: 'h2' });
    expect(finding.classification).toBe('REGRESSION');
    expect(finding.incidentRequired).toBe(true);
    expect(finding.reasonCode).toBe('UNDECLARED_BEHAVIOR_CHANGE');
  });

  it('RSI_DRIFT_EXPECTED_AND_IMPROVEMENT_NO_INCIDENT：已声明预期变更与有证据的改进不建 Incident', () => {
    expect(classifyDrift({ ...base, current: 'h2', expectedChangeDeclared: true })).toMatchObject({
      classification: 'EXPECTED_CHANGE',
      incidentRequired: false,
    });
    expect(classifyDrift({ ...base, current: 'h2', improvementDeclared: true })).toMatchObject({
      classification: 'IMPROVEMENT',
      incidentRequired: false,
    });
  });

  it('RSI_DRIFT_SECURITY_AND_PRIVILEGE_ALWAYS_INCIDENT：权限与安全语义变化优先级最高，必须建 Incident', () => {
    const privilege = classifyDrift({ ...base, current: 'h2', privilegeAffecting: true, expectedChangeDeclared: true });
    expect(privilege.classification).toBe('PRIVILEGE_CHANGE');
    expect(privilege.incidentRequired).toBe(true);

    const security = classifyDrift({ ...base, current: 'h2', securityAffecting: true, improvementDeclared: true });
    expect(security.classification).toBe('SECURITY_RELEVANT_CHANGE');
    expect(security.incidentRequired).toBe(true);

    // 多面巡检：只要有一个必须建 Incident，整体就不再静默
    const findings = inspectSurfaces([
      { ...base, surface: 'ROUTE_BEHAVIOR' },
      { ...base, surface: 'PERMISSION_BEHAVIOR', current: 'h9', privilegeAffecting: true },
    ]);
    expect(findings.filter((f) => f.incidentRequired)).toHaveLength(1);
  });

  it('RSI_INVARIANTS_HOLD_BOUNDARIES_ENFORCED：HOLD 边界与 VIEWER 权限违反一律 HIGH Incident', () => {
    const clean = evaluateBusinessInvariants({
      submitActorRole: 'OPERATOR',
      externalWriteAttempted: false,
      externalWriteHold: true,
      paymentCaptureAttempted: false,
      paymentHold: true,
      productionCredentialUsed: false,
    });
    expect(clean).toEqual([]);

    const violations = evaluateBusinessInvariants({
      submitActorRole: 'VIEWER',
      externalWriteAttempted: true,
      externalWriteHold: true,
      paymentCaptureAttempted: true,
      paymentHold: true,
      productionCredentialUsed: true,
    });
    expect(violations.map((v) => v.code).sort()).toEqual([
      'EXTERNAL_WRITE_DURING_HOLD',
      'PAYMENT_CAPTURE_DURING_HOLD',
      'PRODUCTION_CREDENTIAL_USE',
      'VIEWER_PRIVILEGED_SUBMIT',
    ]);
    for (const violation of violations) {
      expect(violation.incidentRequired).toBe(true);
      expect(violation.riskClass).toBe('HIGH');
    }

    // 巡检属于系统内部任务，不靠聊天心跳
    expect(RSI_INSPECTION_SCHEDULE.daily.job).toBe('RSI_DAILY_HEALTH_INSPECTION');
    expect(RSI_INSPECTION_SCHEDULE.weekly.job).toBe('RSI_WEEKLY_FULL_SYSTEM_REVIEW');
    expect(RSI_INSPECTION_SCHEDULE.heartbeatIsNotInspection).toBe(true);
    expect(RSI_INSPECTION_SCHEDULE.silentWhenHealthy).toBe(true);
  });
});
