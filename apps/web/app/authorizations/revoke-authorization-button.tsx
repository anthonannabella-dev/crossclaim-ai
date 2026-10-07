'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface RevokeLabels {
  revokeCta: string;
  revokeReasonLabel: string;
  revokeConfirm: string;
  revokeCancel: string;
  revokeBusy: string;
  revokeFailed: string;
  networkError: string;
}

/**
 * P7：撤销授权（客户端只提交 reason；**不提交任何 scope / 权限字段**）。
 * 撤销的作用域由服务端按该授权解析，前端不参与判定。
 */
export default function RevokeAuthorizationButton({
  authorizationId,
  labels,
  disabled,
}: {
  authorizationId: string;
  labels: RevokeLabels;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (disabled) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/standing-authorizations/${authorizationId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        setError(labels.revokeFailed.replace('{status}', String(response.status)));
        return;
      }
      setOpen(false);
      setReason('');
      router.refresh();
    } catch {
      setError(labels.networkError);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
      >
        {labels.revokeCta}
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <label className="block text-xs text-slate-600">
        {labels.revokeReasonLabel}
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || reason.trim() === ''}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? labels.revokeBusy : labels.revokeConfirm}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
        >
          {labels.revokeCancel}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
