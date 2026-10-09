import Link from 'next/link';
import { cookies } from 'next/headers';

import { getCustomsUnlockCopy } from '../../../../i18n/customs-unlock-copy';
import { getServerLocale } from '../../../../i18n/server';
import CustomsUnlockPanel, {
  type CustomsUnlockBasisEntry,
} from '../../../components/customs-unlock-panel';
import type { OpportunityApiItem } from '../../../lib/dashboard-view';

/**
 * V2-06 —— `/customs/unlock/[opportunityId]`：客户**主动**启动关税追回的入口页。
 *
 * 不变式（PHASE B / PHASE G）：
 *  1. 只读既有只读端点（`/opportunities?domain=CUSTOMS`），不新增 API/Schema，不碰 Prisma。
 *  2. 金额**原样展示**后端返回的字符串，绝不换算、绝不跨币种求和、绝不前端推导。
 *  3. 无可信预估（后端未给出金额）时**不显示任何金额**，也不显示付费入口，只引导补充资料。
 *  4. 付费面板必须由客户点击后才展开；禁止自动弹出强制购买框。
 *  5. 机会不存在或不属于当前账户 → 不展示任何业务信息（fail-closed）。
 *  6. 支付通道未启用（PAYMENTS_ENABLED=false，现有 Payment HOLD）时购买按钮禁用。
 */

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

async function apiGet<T>(path: string, cookie: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export default async function CustomsUnlockPage({
  params,
}: {
  params: Promise<{ opportunityId: string }>;
}) {
  const { opportunityId } = await params;
  const locale = await getServerLocale();
  const copy = getCustomsUnlockCopy(locale);
  const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';

  const cookieStore = await cookies();
  const list = await apiGet<{ items: OpportunityApiItem[] }>(
    '/opportunities?domain=CUSTOMS&limit=100',
    cookieStore.toString(),
  );
  const item = list?.items?.find((row) => row.id === opportunityId) ?? null;

  if (item === null) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-6">
        <Link className="text-sm text-slate-500 underline" href="/customs">
          {copy.backToCustoms}
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">{copy.notFoundTitle}</h1>
        <p className="text-sm text-slate-700">{copy.notFoundBody}</p>
      </main>
    );
  }

  const hasTrustworthyEstimate =
    typeof item.recoverableAmount === 'string' && item.recoverableAmount.trim().length > 0;

  const basis: CustomsUnlockBasisEntry[] = [
    { label: copy.eligibilityHeading, value: item.customerStatus.label },
    { label: copy.basisHeading, value: item.opportunityType },
    { label: copy.estimateBasis, value: item.claimDeadline ?? '—' },
  ];

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <Link className="text-sm text-slate-500 underline" href="/customs">
        {copy.backToCustoms}
      </Link>

      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">{copy.pageTitle}</h1>
        <p className="text-sm text-slate-700">{item.title || item.opportunityType}</p>
        {item.account ? <p className="text-xs text-slate-500">{item.account.displayName}</p> : null}
      </header>

      <section className="space-y-1">
        <h2 className="text-sm font-semibold text-slate-900">{copy.estimateHeading}</h2>
        {hasTrustworthyEstimate ? (
          // 原样展示后端持久化字符串；不做换算、不做求和。
          <p className="text-lg font-medium text-slate-900">
            {item.recoverableAmount} {item.currency}
          </p>
        ) : (
          <p className="text-sm text-slate-700">{copy.noEstimateYet}</p>
        )}
      </section>

      <section className="space-y-1">
        <h2 className="text-sm font-semibold text-slate-900">{copy.evidenceCompleteness}</h2>
        <p className="text-sm text-slate-700">
          {item.customerStatus.code} · {item.opportunityType}
        </p>
      </section>

      {/*
        付费入口只在存在可信预估时出现（业务规则 4）。
        额度感知（已购用户不再被要求重复购买）需要权益读取端点，当前未接（见 V2-06 文档 BLOCKED）。
      */}
      {hasTrustworthyEstimate ? (
        <CustomsUnlockPanel
          copy={copy}
          paymentsEnabled={paymentsEnabled}
          alreadyCovered={false}
          basis={basis}
        />
      ) : null}
    </main>
  );
}
