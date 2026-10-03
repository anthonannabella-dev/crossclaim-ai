'use client';

import { useState } from 'react';

/**
 * G5-POST-FORMS：carrier response 人工补录（只读边界内的内部写）。
 * 只提交 status / providerReference / note —— 服务端强制 source=USER_REPORTED、verificationLevel=UNVERIFIED，
 * client 不得（也无法）提交 source / verificationLevel / 身份字段。
 */
const STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'DENIED',
  'APPROVED',
  'PARTIALLY_APPROVED',
  'PAID',
  'CLOSED',
  'UNKNOWN',
];

export default function ManualResponseForm() {
  const [packageId, setPackageId] = useState('');
  const [status, setStatus] = useState('PENDING');
  const [providerReference, setProviderReference] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (packageId.trim() === '') {
      setResult('请填写 packageId');
      return;
    }
    setBusy(true);
    setResult('');
    try {
      const res = await fetch('/api/carrier-claim-packages/' + encodeURIComponent(packageId.trim()) + '/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status,
          providerReference: providerReference.trim() === '' ? null : providerReference.trim(),
          note: note.trim() === '' ? null : note.trim(),
        }),
      });
      const body = (await res.json()) as { status?: string; code?: string; detail?: string };
      if (res.ok) {
        setResult('已记录（' + (body.status ?? 'RECORDED') + '）· verificationLevel 恒为 UNVERIFIED');
      } else {
        setResult('被拒绝：HTTP ' + res.status + ' · ' + (body.code ?? 'UNKNOWN') + (body.detail ? ' · ' + body.detail : ''));
      }
    } catch (error) {
      setResult('请求失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-slate-200 p-4">
      <h2 className="text-base font-medium">人工补录 carrier 响应（只 USER_REPORTED）</h2>
      <p className="mt-1 text-xs text-slate-500">
        服务端强制 source=USER_REPORTED / verificationLevel=UNVERIFIED；不会产生 carrier 确认，也不会改动资金真值。
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-slate-600">packageId</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">status</span>
          <select
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">providerReference（可选，恒 unverified）</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
            value={providerReference}
            onChange={(e) => setProviderReference(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">note（可选，≤500）</span>
          <input
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      <button
        className="mt-3 rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
        onClick={submit}
        disabled={busy}
      >
        {busy ? '提交中…' : '记录人工补录'}
      </button>
      {result !== '' ? <p className="mt-2 text-sm text-slate-700">{result}</p> : null}
    </section>
  );
}
