/** CA-6 HTTP 边界单测：授权计划只读端点（403 / 400 / 404 / 200 + 只读边界）。 */

import { describe, expect, it } from 'vitest';

import { handleCustomsAuthorizationPlanRequest } from '../services/customs/customs-authorization-plan-http';
import type { CustomsOneClickAuthorizationPlan } from '../services/customs/customs-one-click-authorization';

const PLAN: CustomsOneClickAuthorizationPlan = {
  gate: 'NEEDS_AUTHORIZATION',
  missingItemKeys: ['REFUND_ACCOUNT'],
  missingActions: ['CONFIRM_REFUND_ACCOUNT'],
  reuseExistingAuthorization: true,
  reasonCodes: [],
  nextAction: 'CONFIRM_REFUND_ACCOUNT',
  serverDerived: true,
  filingSubmitted: false,
  externalWritePerformed: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
};

const deps = {
  async loadPlan(input: { organizationId: string; opportunityId: string }) {
    return input.opportunityId === 'missing' ? null : PLAN;
  },
};

describe('CA-6 — authorization plan HTTP boundary（unit）', () => {
  it('未授权角色 → 403', async () => {
    const res = await handleCustomsAuthorizationPlanRequest(
      { opportunityId: 'opp-1', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'VIEWER' } },
      deps,
    );
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('ROLE_NOT_PERMITTED');
  });

  it('空 id → 400', async () => {
    const res = await handleCustomsAuthorizationPlanRequest(
      { opportunityId: '', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'OWNER' } },
      deps,
    );
    expect(res.status).toBe(400);
  });

  it('读不到 → 404（不泄露存在性）', async () => {
    const res = await handleCustomsAuthorizationPlanRequest(
      { opportunityId: 'missing', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'OWNER' } },
      deps,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('正常读取 → 200：只列缺失项 + 复用判定 + 只读边界', async () => {
    const res = await handleCustomsAuthorizationPlanRequest(
      { opportunityId: 'opp-1', session: { organizationId: 'org-1', actorUserId: 'u1', role: 'OPS' } },
      deps,
    );
    expect(res.status).toBe(200);
    const plan = res.body.authorizationPlan as CustomsOneClickAuthorizationPlan;
    expect(plan.gate).toBe('NEEDS_AUTHORIZATION');
    expect(plan.missingItemKeys).toEqual(['REFUND_ACCOUNT']);
    expect(plan.reuseExistingAuthorization).toBe(true);
    expect(res.body.boundary).toEqual({
      readOnly: true,
      filingSubmitted: false,
      transportEnabled: false,
      externalWritePerformed: false,
      productionCredentials: 'ABSENT',
    });
  });
});
