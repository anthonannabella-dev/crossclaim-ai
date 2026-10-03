/**
 * C21 HTTP 边界验收（MSG-20261003-124 ⑭–㉑）。
 * 断言：领域字段注入 400；VIEWER 403；未知 opportunity 404；全通过 → READY_TO_FILE + filingSubmitted=false
 *       + externalExecutionStatus=NOT_STARTED；授权未就绪/无 provider → 409 且 disposition 明确；
 *       GET 读模型 tenant-scoped 且无 credential。
 */

import { describe, expect, it } from 'vitest';

import {
  handleCustomsFilingStatusReadRequest,
  handleCustomsRecoveryStartRequest,
  type CustomsRecoveryHttpDeps,
} from '../services/customs/customs-recovery-http';
import type { CustomsOpportunityTruth } from '../services/customs/customs-one-click-start';
import { PERMISSIONS } from '../services/workflow/permissions';

const ORG = 'cc200000-0000-4000-8000-000000000001';
const USER = 'cc200000-0000-4000-8000-000000000002';
const OPP = 'opp-c21-1';

const TRUTH: CustomsOpportunityTruth = {
  opportunityId: OPP,
  organizationId: ORG,
  entryFactPresent: true,
  evidenceBundleCompleteness: 'COMPLETE',
  eligibilityDecision: 'ELIGIBLE',
  recoverableAmounts: [{ currency: 'USD', amount: '18620.00' }],
  remedyRoute: 'DRAWBACK',
  filingDeadline: '2027-05-01',
  recoveryPackageStatus: 'READY',
  ruleVersion: 'us-customs-v1',
};

const FULL_AUTH = {
  customsAgreementSigned: true,
  importerOfRecordConfirmed: true,
  claimantConfirmed: true,
  recoveryRightConfirmed: true,
  brokerConnected: true,
  brokerAuthorizationValid: true,
  filingPermissionValid: true,
  providerCapabilityReady: true,
};

function depsFor(overrides: Partial<CustomsRecoveryHttpDeps> = {}): CustomsRecoveryHttpDeps {
  return {
    opportunities: {
      async load(organizationId, opportunityId) {
        return organizationId === ORG && opportunityId === OPP ? TRUTH : null;
      },
    },
    authorization: FULL_AUTH,
    provider: { providerId: 'broker-a', capabilities: { DATA_READ: true, FILING_CREATE: true, DOCUMENT_UPLOAD: true, STATUS_READ: true } },
    filingStatus: { async listFacts() { return []; } },
    now: () => new Date('2026-10-03T09:00:00.000Z'),
    ...overrides,
  };
}

function session(role: string) {
  return { organizationId: ORG, actorUserId: USER, role };
}

describe('C21 — customs recovery HTTP boundary', () => {
  it('⑲ 角色矩阵：OWNER/ADMIN/OPS 有 startCustomsRecovery，FINANCE/VIEWER 没有', () => {
    expect(PERMISSIONS.OWNER.startCustomsRecovery).toBe(true);
    expect(PERMISSIONS.ADMIN.startCustomsRecovery).toBe(true);
    expect(PERMISSIONS.OPS.startCustomsRecovery).toBe(true);
    expect(PERMISSIONS.FINANCE.startCustomsRecovery).toBe(false);
    expect(PERMISSIONS.VIEWER.startCustomsRecovery).toBe(false);
  });

  it('⑱ client 注入领域字段 → 400 且零 snapshot', async () => {
    const res = await handleCustomsRecoveryStartRequest(
      { opportunityId: OPP, request: { recoverableAmount: '999999.00' }, session: session('OWNER') },
      depsFor(),
    );
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('FIELD_NOT_ALLOWED:recoverableAmount');
    const feeRate = await handleCustomsRecoveryStartRequest(
      { opportunityId: OPP, request: { feeRate: '0.30' }, session: session('OWNER') },
      depsFor(),
    );
    expect(feeRate.status).toBe(400);
  });

  it('⑲ VIEWER → 403；未知 opportunity → 404', async () => {
    const viewer = await handleCustomsRecoveryStartRequest({ opportunityId: OPP, request: {}, session: session('VIEWER') }, depsFor());
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe('CAPABILITY_REQUIRED');
    const missing = await handleCustomsRecoveryStartRequest(
      { opportunityId: 'opp-missing', request: {}, session: session('OWNER') },
      depsFor(),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('OPPORTUNITY_NOT_FOUND');
  });

  it('⑰ 全通过 → 200 READY_TO_FILE 且 filingSubmitted=false / externalExecutionStatus=NOT_STARTED', async () => {
    const res = await handleCustomsRecoveryStartRequest(
      { opportunityId: OPP, request: {}, session: session('OWNER') },
      depsFor(),
    );
    expect(res.status).toBe(200);
    expect(res.body.recoveryStatus).toBe('READY_TO_FILE');
    expect(res.body.filingSubmitted).toBe(false);
    expect(res.body.externalExecutionStatus).toBe('NOT_STARTED');
    expect(res.body.submissionSnapshot).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('credential');
  });

  it('⑮⑯ 授权未就绪 → 409 AUTHORIZATION_NOT_READY（BROKER_HANDOFF）；无 provider → 409 FILING_CAPABILITY_MISSING', async () => {
    const auth = await handleCustomsRecoveryStartRequest(
      { opportunityId: OPP, request: {}, session: session('OWNER') },
      depsFor({ authorization: { ...FULL_AUTH, brokerAuthorizationValid: false } }),
    );
    expect(auth.status).toBe(409);
    expect(auth.body.code).toBe('AUTHORIZATION_NOT_READY');
    expect(auth.body.disposition).toBe('BROKER_HANDOFF');
    expect(auth.body.filingSubmitted).toBe(false);
    const noProvider = await handleCustomsRecoveryStartRequest(
      { opportunityId: OPP, request: {}, session: session('OWNER') },
      depsFor({ provider: null }),
    );
    expect(noProvider.status).toBe(409);
    expect(noProvider.body.code).toBe('FILING_CAPABILITY_MISSING');
  });

  it('⑳ GET filing-status：200（tenant-scoped 投影，无 credential）；未知 opportunity 404；未知角色 403', async () => {
    const ok = await handleCustomsFilingStatusReadRequest({ opportunityId: OPP, session: session('VIEWER') }, depsFor());
    expect(ok.status).toBe(200);
    const body = ok.body.filingStatus as Record<string, unknown>;
    expect(body.currentStatus).toBeNull();
    expect(body.derivesRecoveredCash).toBe(false);
    const serialized = JSON.stringify(ok.body);
    for (const forbidden of ['credential', 'accessToken', 'secret', 'rawPII']) {
      expect(serialized).not.toContain(forbidden);
    }
    const missing = await handleCustomsFilingStatusReadRequest({ opportunityId: 'opp-missing', session: session('OWNER') }, depsFor());
    expect(missing.status).toBe(404);
    const ghost = await handleCustomsFilingStatusReadRequest({ opportunityId: OPP, session: session('GHOST') }, depsFor());
    expect(ghost.status).toBe(403);
  });
});
