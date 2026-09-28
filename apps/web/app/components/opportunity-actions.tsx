'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 与后端 REJECT_REASONS 保持一致（架构方批准的拒绝词表）。 */
const REJECT_REASONS = ['wrong_amount', 'duplicate', 'not_recoverable', 'other'] as const;

const LABELS: Record<(typeof REJECT_REASONS)[number], string> = {
  wrong_amount: '金额有误',
  duplicate: '重复',
  not_recoverable: '不可追回',
  other: '其他',
};

export default function OpportunityActions({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<(typeof REJECT_REASONS)[number]>('wrong_amount');

  async function post(action: 'qualify' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/opportunities/${opportunityId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({ reason }) : undefined,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `请求失败（${response.status}）`);
        return;
      }
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void post('qualify')}
        className="rounded bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-60"
      >
        确认
      </button>
      <select
        value={reason}
        onChange={(event) => setReason(event.target.value as (typeof REJECT_REASONS)[number])}
        className="rounded border px-2 py-1 text-xs"
        aria-label="拒绝原因"
      >
        {REJECT_REASONS.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={() => void post('reject')}
        className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 disabled:opacity-60"
      >
        拒绝
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
