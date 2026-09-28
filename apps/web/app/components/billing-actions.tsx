'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 已批准状态机：DRAFT → ISSUED → PAID（服务端权威，这里只决定按钮可见性）。 */
const NEXT: Record<string, string[]> = {
  DRAFT: ['ISSUED'],
  ISSUED: ['PAID'],
  PAID: [],
  PARTIALLY_PAID: ['PAID'],
  VOID: [],
  WRITTEN_OFF: [],
};

export default function BillingActions({ invoiceId, status }: { invoiceId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentReference, setPaymentReference] = useState('');
  const [note, setNote] = useState('');

  async function advance(to: string) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { to };
      if (to === 'PAID') {
        if (paymentReference.trim() !== '') body.paymentReference = paymentReference.trim();
        if (note.trim() !== '') body.note = note.trim();
      }
      const response = await fetch(`/api/billing/${invoiceId}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `请求失败（${response.status}）`);
        return;
      }
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  const targets = NEXT[status] ?? [];
  if (targets.length === 0) return <span className="text-xs text-slate-400">—</span>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {targets.map((to) => (
          <button
            key={to}
            type="button"
            disabled={busy}
            onClick={() => void advance(to)}
            className="rounded bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-60"
          >
            {to === 'ISSUED' ? '开票（ISSUED）' : '标记已收款（PAID）'}
          </button>
        ))}
      </div>
      {targets.includes('PAID') ? (
        <div className="flex flex-wrap gap-2">
          <input
            value={paymentReference}
            onChange={(event) => setPaymentReference(event.target.value)}
            placeholder="paymentReference（或填备注）"
            className="w-48 rounded border px-2 py-1 text-xs"
          />
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="note（可选）"
            className="w-40 rounded border px-2 py-1 text-xs"
          />
        </div>
      ) : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
