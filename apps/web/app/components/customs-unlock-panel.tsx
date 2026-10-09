'use client';

import { useState } from 'react';

import type { CustomsUnlockCopy } from '../../i18n/customs-unlock-copy';

/**
 * V2-06 — 付费解锁面板（客户**主动点击**后才展开）。
 * 不变式：
 *  1. 不自动弹出、不自动跳转、不自动下单：初始只显示一个按钮 + 说明。
 *  2. 面板中出现的金额一律来自调用方传入的服务端事实；本组件**不做任何金额推导或换算**。
 *  3. 购买按钮在支付通道未启用时禁用（Payment HOLD），不伪造成功状态。
 */
export interface CustomsUnlockBasisEntry {
  label: string;
  value: string;
}

export interface CustomsUnlockPanelProps {
  copy: CustomsUnlockCopy;
  paymentsEnabled: boolean;
  alreadyCovered: boolean;
  basis: readonly CustomsUnlockBasisEntry[];
}

export default function CustomsUnlockPanel({
  copy,
  paymentsEnabled,
  alreadyCovered,
  basis,
}: CustomsUnlockPanelProps) {
  const [started, setStarted] = useState(false);

  if (alreadyCovered) {
    return <p className="text-sm text-emerald-700">{copy.alreadyCovered}</p>;
  }

  if (!started) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setStarted(true)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          {copy.startCta}
        </button>
        <p className="text-xs text-slate-500">{copy.startHint}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-900">{copy.planHeading}</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>{copy.planSingleBenefit}</li>
          <li>{copy.planMonthlyBenefit}</li>
        </ul>
        <p className="text-xs text-slate-500">{copy.priceNote}</p>
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-900">{copy.successFeeHeading}</h3>
        <p className="text-sm text-slate-700">{copy.successFeeBody}</p>
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-900">{copy.paymentStatusHeading}</h3>
        <p className="text-sm text-slate-700">
          {paymentsEnabled ? copy.paymentEnabled : copy.paymentHold}
        </p>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-400"
        >
          {copy.purchaseDisabled}
        </button>
      </section>

      <section className="space-y-1">
        <p className="text-sm text-slate-700">{copy.thirdPartyAndRefund}</p>
      </section>

      {basis.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-900">{copy.basisHeading}</h3>
          <dl className="text-xs text-slate-600">
            {basis.map((entry) => (
              <div key={entry.label} className="flex gap-2">
                <dt className="min-w-32 text-slate-500">{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
