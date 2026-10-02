/**
 * CARRIER QUEUE #5（MSG-20261003-109 ⑪–㉖）— Invoice + POD read plane 回归。
 * 断言：fail-closed 前置、verified lineage、request/response 双向绑定、金额十进制安全、charge 归一化 + raw code 保留、
 * POD 掩码与隐私、raw payload 白名单、失败分类、read-only 边界、无真实请求、无 SLA/退款资格推导。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addDecimalStrings,
  createSandboxCarrierInvoiceReadPort,
  createSandboxCarrierPODReadPort,
  isDecimalString,
  maskRecipientName,
  readCarrierInvoiceFacts,
  readCarrierPOD,
  resolveCarrierInvoiceAdapter,
  resolveCarrierPODAdapter,
  type CarrierInvoiceReadInput,
  type CarrierInvoiceReadPort,
  type CarrierPODReadInput,
  type CarrierRawInvoiceRecord,
  type CarrierRawPODRecord,
} from '../services/carriers/carrier-invoice-pod-read';
import { CarrierProviderReadError, createInMemoryCarrierVerifiedAccountRegistry, type InMemoryCarrierVerifiedAccountRegistry } from '../services/carriers/carrier-tracking-read';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const UPS_TRACKING = '1Z999AA10123456784';
const FEDEX_TRACKING = '7712 3456 7890';

const UPS_INVOICE: CarrierRawInvoiceRecord = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  invoiceReference: 'UPS-INV-1',
  invoiceDate: '2026-09-30',
  trackingNumber: UPS_TRACKING,
  shipmentReference: 'SHP-1',
  serviceLevel: 'GROUND',
  currency: 'USD',
  totalCharge: '41.30',
  charges: [
    { rawChargeCode: 'BASE', amount: '35.00' },
    { rawChargeCode: 'FUEL', amount: '5.25' },
    { rawChargeCode: 'RES', amount: '0.75' },
    { rawChargeCode: 'MYSTERY-CODE', amount: '0.30' },
  ],
  billedWeight: '12.5',
  billedZone: 'Z2',
  rawReference: 'sha256:ups-inv-1',
};

const FEDEX_INVOICE: CarrierRawInvoiceRecord = {
  provider: 'FEDEX',
  externalAccountId: 'FDX-ACCT-9',
  invoiceReference: 'FDX-INV-9',
  trackingNumber: FEDEX_TRACKING,
  currency: 'USD',
  totalCharge: '60.00',
  charges: [
    { rawChargeCode: 'BASE_CHARGE', amount: '50.00' },
    { rawChargeCode: 'FUEL_SURCHARGE', amount: '10.00' },
  ],
  rawReference: 'sha256:fdx-inv-9',
};

const UPS_POD: CarrierRawPODRecord = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: UPS_TRACKING,
  deliveryStatus: 'D',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  deliveryLocation: 'Austin, TX',
  recipientName: 'Jane Doe',
  signed: true,
  signatureAvailable: true,
  proofType: 'SIGNATURE',
  documentReference: 'artifact:pod-1',
  rawReference: 'sha256:ups-pod-1',
};

const FEDEX_POD: CarrierRawPODRecord = {
  provider: 'FEDEX',
  externalAccountId: 'FDX-ACCT-9',
  trackingNumber: FEDEX_TRACKING,
  deliveryStatus: 'DL',
  deliveredAt: '2026-10-01T18:00:00.000Z',
  deliveryLocation: 'New York, NY',
  recipientName: 'John Smith',
  signed: false,
  signatureAvailable: false,
  proofType: 'PHOTO',
  documentReference: 'artifact:pod-9',
  rawReference: 'sha256:fdx-pod-9',
};

function registry(): InMemoryCarrierVerifiedAccountRegistry {
  const accounts = createInMemoryCarrierVerifiedAccountRegistry();
  accounts.record({ provider: 'UPS', credentialRef: 'SANDBOX:UPS:cred-1', externalAccountId: 'UPS-ACCT-1', organizationId: 'org-a', identitySource: 'PROVIDER_DISCOVERY' });
  accounts.record({ provider: 'FEDEX', credentialRef: 'SANDBOX:FEDEX:registration:fdx-acct-9', externalAccountId: 'FDX-ACCT-9', organizationId: 'org-a', identitySource: 'PROVIDER_VERIFIED_REGISTRATION' });
  return accounts;
}

function invoiceInput(overrides: Partial<CarrierInvoiceReadInput> = {}): CarrierInvoiceReadInput {
  return { provider: 'UPS', credentialRef: 'SANDBOX:UPS:cred-1', externalAccountId: 'UPS-ACCT-1', organizationId: 'org-a', ...overrides };
}

function podInput(overrides: Partial<CarrierPODReadInput> = {}): CarrierPODReadInput {
  return { provider: 'UPS', credentialRef: 'SANDBOX:UPS:cred-1', externalAccountId: 'UPS-ACCT-1', trackingNumber: UPS_TRACKING, organizationId: 'org-a', ...overrides };
}

const INVOICE_PORT = createSandboxCarrierInvoiceReadPort({ UPS: [UPS_INVOICE], FEDEX: [FEDEX_INVOICE] });
const POD_PORT = createSandboxCarrierPODReadPort({ UPS: { [UPS_TRACKING]: UPS_POD }, FEDEX: { [FEDEX_TRACKING]: FEDEX_POD } });

function spyInvoicePort(result: readonly CarrierRawInvoiceRecord[] | Error) {
  const calls: Array<Parameters<CarrierInvoiceReadPort['getInvoiceFacts']>[0]> = [];
  return {
    calls,
    port: {
      async getInvoiceFacts(input) {
        calls.push(input);
        if (result instanceof Error) throw result;
        return result;
      },
    } as CarrierInvoiceReadPort,
  };
}

describe('CARRIER QUEUE #5 — invoice fail-closed + lineage', () => {
  it('unknown carrier fail-closed（invoice / POD 两侧）', async () => {
    const spy = spyInvoicePort([UPS_INVOICE]);
    const invoice = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, invoiceInput({ provider: 'DHL' }));
    expect(invoice.ok ? null : invoice.reason).toBe('UNKNOWN_CARRIER');
    expect(spy.calls).toHaveLength(0);
    const pod = await readCarrierPOD(
      { port: POD_PORT, accounts: registry() },
      podInput({ provider: 'DHL' }),
    );
    expect(pod.ok ? null : pod.reason).toBe('UNKNOWN_CARRIER');
  });

  it('missing credentialRef / unverified lineage / cross-tenant / provider mismatch 分别 fail-closed', async () => {
    const spy = spyInvoicePort([UPS_INVOICE]);
    const noRef = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, invoiceInput({ credentialRef: '  ' }));
    expect(noRef.ok ? null : noRef.reason).toBe('CREDENTIAL_REF_REQUIRED');
    const unverified = await readCarrierInvoiceFacts(
      { port: spy.port, accounts: createInMemoryCarrierVerifiedAccountRegistry() },
      invoiceInput(),
    );
    expect(unverified.ok ? null : unverified.reason).toBe('UNVERIFIED_ACCOUNT_LINEAGE');
    const crossTenant = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, invoiceInput({ organizationId: 'org-b' }));
    expect(crossTenant.ok ? null : crossTenant.reason).toBe('CROSS_TENANT_ACCOUNT');
    const providerMismatch = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, invoiceInput({ provider: 'FEDEX' }));
    expect(providerMismatch.ok ? null : providerMismatch.reason).toBe('PROVIDER_ACCOUNT_MISMATCH');
    expect(spy.calls).toHaveLength(0);
  });

  it('plaintext credential 输入不受支持', async () => {
    const spy = spyInvoicePort([UPS_INVOICE]);
    const input = { ...invoiceInput(), clientSecret: 'PLAINTEXT-XYZ' } as unknown as CarrierInvoiceReadInput;
    const outcome = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, input);
    expect(outcome.ok ? null : outcome.reason).toBe('PLAINTEXT_CREDENTIAL_NOT_SUPPORTED');
    expect(spy.calls).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain('PLAINTEXT-XYZ');
  });
});

describe('CARRIER QUEUE #5 — invoice normalization', () => {
  it('UPS invoice → normalized fact（金额分层 + raw code 保留 + 未知 → OTHER）', async () => {
    const outcome = await readCarrierInvoiceFacts({ port: INVOICE_PORT, accounts: registry(), now: () => NOW }, invoiceInput());
    if (!outcome.ok) throw new Error('expected ok');
    const fact = outcome.facts[0];
    expect(fact.provider).toBe('UPS');
    expect(fact.invoiceReference).toBe('UPS-INV-1');
    expect(fact.currency).toBe('USD');
    expect(fact.baseCharge).toBe('35.00');
    expect(fact.fuelSurcharge).toBe('5.25');
    expect(fact.accessorialCharges).toBe('1.05');
    expect(fact.tax).toBeNull();
    expect(fact.totalCharge).toBe('41.30');
    expect(fact.rawChargeCodes).toEqual(['BASE', 'FUEL', 'RES', 'MYSTERY-CODE']);
    expect(fact.charges.map((charge) => charge.kind)).toEqual(['BASE', 'FUEL', 'RESIDENTIAL', 'OTHER']);
    expect(fact.rawReference).toBe('sha256:ups-inv-1');
    expect(outcome.billingTruthOnly).toBe(true);
  });

  it('FedEx invoice → normalized fact（provider adapter 独立）', async () => {
    const outcome = await readCarrierInvoiceFacts(
      { port: INVOICE_PORT, accounts: registry(), now: () => NOW },
      invoiceInput({ provider: 'FEDEX', credentialRef: 'SANDBOX:FEDEX:registration:fdx-acct-9', externalAccountId: 'FDX-ACCT-9' }),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.facts[0].baseCharge).toBe('50.00');
    expect(outcome.facts[0].fuelSurcharge).toBe('10.00');
    expect(outcome.facts[0].invoiceReference).toBe('FDX-INV-9');
  });

  it('金额十进制安全：不经过 float，非法金额 / 货币 fail-closed', async () => {
    expect(addDecimalStrings(['0.1', '0.2'])).toBe('0.3');
    expect(addDecimalStrings(['10', '0.005'])).toBe('10.005');
    expect(isDecimalString('41.30')).toBe(true);
    expect(isDecimalString('41.3e2')).toBe(false);
    const adapter = resolveCarrierInvoiceAdapter('UPS')!;
    expect(adapter.chargeKind('BASE')).toBe('BASE');
    expect(adapter.chargeKind('UNKNOWN_CODE')).toBe('OTHER');
    const bad = spyInvoicePort([{ ...UPS_INVOICE, totalCharge: '41,30' }]);
    const outcome = await readCarrierInvoiceFacts({ port: bad.port, accounts: registry() }, invoiceInput());
    expect(outcome.ok ? null : outcome.reason).toBe('INVALID_AMOUNT');
    const badCurrency = spyInvoicePort([{ ...UPS_INVOICE, currency: 'US' }]);
    const outcome2 = await readCarrierInvoiceFacts({ port: badCurrency.port, accounts: registry() }, invoiceInput());
    expect(outcome2.ok ? null : outcome2.reason).toBe('CURRENCY_REQUIRED');
  });

  it('request / response 双向绑定：account / invoice reference / tracking 不符一律 reject', async () => {
    const accountSpy = spyInvoicePort([{ ...UPS_INVOICE, externalAccountId: 'UPS-ACCT-OTHER' }]);
    const accountMismatch = await readCarrierInvoiceFacts({ port: accountSpy.port, accounts: registry() }, invoiceInput());
    expect(accountMismatch.ok ? null : accountMismatch.reason).toBe('ACCOUNT_MISMATCH');
    expect(JSON.stringify(accountMismatch)).not.toContain('UPS-ACCT-OTHER');
    const refSpy = spyInvoicePort([UPS_INVOICE]);
    const invoiceMismatch = await readCarrierInvoiceFacts(
      { port: refSpy.port, accounts: registry() },
      invoiceInput({ invoiceReference: 'UPS-INV-OTHER' }),
    );
    expect(invoiceMismatch.ok ? null : invoiceMismatch.reason).toBe('INVOICE_IDENTITY_MISMATCH');
    const trackingSpy = spyInvoicePort([UPS_INVOICE]);
    const trackingMismatch = await readCarrierInvoiceFacts(
      { port: trackingSpy.port, accounts: registry() },
      invoiceInput({ trackingNumber: '1Z999AA10123456799' }),
    );
    expect(trackingMismatch.ok ? null : trackingMismatch.reason).toBe('TRACKING_IDENTITY_MISMATCH');
  });

  it('raw payload 白名单：未声明字段 fail-closed 且不外泄', async () => {
    const spy = spyInvoicePort([{ ...UPS_INVOICE, rawPayload: 'PRIVATE-INVOICE-RAW' } as unknown as CarrierRawInvoiceRecord]);
    const outcome = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, invoiceInput());
    expect(outcome.ok ? null : outcome.reason).toBe('RAW_PAYLOAD_INVALID');
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE-INVOICE-RAW');
    const chargeSpy = spyInvoicePort([{ ...UPS_INVOICE, charges: [{ rawChargeCode: 'BASE', amount: '1.00', accessToken: 'X' } as never] }]);
    const outcome2 = await readCarrierInvoiceFacts({ port: chargeSpy.port, accounts: registry() }, invoiceInput());
    expect(outcome2.ok ? null : outcome2.reason).toBe('PLAINTEXT_CREDENTIAL_NOT_SUPPORTED');
  });
});

describe('CARRIER QUEUE #5 — POD read plane', () => {
  it('UPS POD → normalized fact（masked 姓名 + artifact reference）', async () => {
    const outcome = await readCarrierPOD({ port: POD_PORT, accounts: registry(), now: () => NOW }, podInput());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.pod.deliveryStatus).toBe('DELIVERED');
    expect(outcome.pod.recipientNameMasked).toBe('J***');
    expect(outcome.pod.signed).toBe(true);
    expect(outcome.pod.signatureAvailable).toBe(true);
    expect(outcome.pod.proofType).toBe('SIGNATURE');
    expect(outcome.pod.documentReference).toBe('artifact:pod-1');
    expect(outcome.pod.rawReference).toBe('sha256:ups-pod-1');
    expect(outcome.deliveryEvidenceOnly).toBe(true);
  });

  it('FedEx POD → normalized fact（provider adapter 独立）', async () => {
    const outcome = await readCarrierPOD(
      { port: POD_PORT, accounts: registry(), now: () => NOW },
      podInput({ provider: 'FEDEX', credentialRef: 'SANDBOX:FEDEX:registration:fdx-acct-9', externalAccountId: 'FDX-ACCT-9', trackingNumber: FEDEX_TRACKING }),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.pod.proofType).toBe('PHOTO');
    expect(outcome.pod.recipientNameMasked).toBe('J***');
    expect(resolveCarrierPODAdapter('DHL')).toBeNull();
  });

  it('POD response tracking binding：返回 tracking 与请求不符 → POD_TRACKING_IDENTITY_MISMATCH', async () => {
    const spyPort = {
      async getPOD() {
        return { ...UPS_POD, trackingNumber: '1Z999AA10123456799' };
      },
    };
    const outcome = await readCarrierPOD({ port: spyPort, accounts: registry() }, podInput());
    expect(outcome.ok ? null : outcome.reason).toBe('POD_TRACKING_IDENTITY_MISMATCH');
    expect(JSON.stringify(outcome)).not.toContain('1Z999AA10123456799');
    expect(JSON.stringify(outcome)).not.toContain('pod');
  });

  it('隐私纪律：不暴露完整姓名 / signature image / 完整 raw payload', async () => {
    const outcome = await readCarrierPOD({ port: POD_PORT, accounts: registry(), now: () => NOW }, podInput());
    if (!outcome.ok) throw new Error('expected ok');
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('signatureImage');
    expect(maskRecipientName('Jane Doe')).toBe('J***');
    expect(maskRecipientName(null)).toBeNull();
    const rawSpy = {
      async getPOD() {
        return { ...UPS_POD, signatureImage: 'PRIVATE-SIGNATURE' } as unknown as CarrierRawPODRecord;
      },
    };
    const rejected = await readCarrierPOD({ port: rawSpy, accounts: registry() }, podInput());
    expect(rejected.ok ? null : rejected.reason).toBe('PLAINTEXT_CREDENTIAL_NOT_SUPPORTED');
    expect(JSON.stringify(rejected)).not.toContain('PRIVATE-SIGNATURE');
  });
});

describe('CARRIER QUEUE #5 — taxonomy + read-only boundaries', () => {
  it('NOT_FOUND / NOT_AUTHORIZED / RATE_LIMITED / TEMPORARILY_UNAVAILABLE 分类稳定（invoice 与 POD）', async () => {
    for (const code of [
      'NOT_FOUND',
      'NOT_AUTHORIZED',
      'RATE_LIMITED',
      'TEMPORARILY_UNAVAILABLE',
    ] as const) {
      const invoiceSpy = spyInvoicePort(new CarrierProviderReadError(code));
      const invoice = await readCarrierInvoiceFacts({ port: invoiceSpy.port, accounts: registry() }, invoiceInput());
      expect(invoice.ok ? null : invoice.reason).toBe(code);
      const podPort = {
        async getPOD() {
          throw new CarrierProviderReadError(code);
        },
      };
      const pod = await readCarrierPOD({ port: podPort, accounts: registry() }, podInput());
      expect(pod.ok ? null : pod.reason).toBe(code);
    }
    const empty = await readCarrierInvoiceFacts({ port: createSandboxCarrierInvoiceReadPort({}), accounts: registry() }, invoiceInput());
    expect(empty.ok ? null : empty.reason).toBe('NOT_FOUND');
  });

  it('provider error sanitization：未知异常 → PROVIDER_ERROR 且不回显上游消息', async () => {
    const spy = spyInvoicePort(new Error('UPS_INVOICE_UPSTREAM_BOOM'));
    const outcome = await readCarrierInvoiceFacts({ port: spy.port, accounts: registry() }, invoiceInput());
    expect(outcome.ok ? null : outcome.reason).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(outcome)).not.toContain('UPS_INVOICE_UPSTREAM_BOOM');
  });

  it('read-only 边界 + 无 SLA/退款资格推导 + 无真实请求', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const invoice = await readCarrierInvoiceFacts({ port: INVOICE_PORT, accounts: registry(), now: () => NOW }, invoiceInput());
    const pod = await readCarrierPOD({ port: POD_PORT, accounts: registry(), now: () => NOW }, podInput());
    if (!invoice.ok || !pod.ok) throw new Error('expected ok');
    for (const outcome of [invoice, pod]) {
      expect(outcome.readOnly).toBe(true);
      expect(outcome.transportEnabled).toBe(false);
      expect(outcome.platformWriteEnabled).toBe(false);
      expect(outcome.productionCredentials).toBe('ABSENT');
      const serialized = JSON.stringify(outcome);
      for (const forbidden of ['refundDue', 'claimValue', 'slaEligible', 'successFee']) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
