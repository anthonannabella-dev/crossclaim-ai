'use client';

import { useState } from 'react';

/**
 * G5-POST-FORMS：customs start-recovery（内部准备，不 filing）。
 * 只提交 opportunityId —— 其余全部 server-derived；响应显式给出 filingSubmitted=false / externalExecutionStatus=NOT_STARTED。
 */
export default function StartRecoveryForm() {
  const [opportunityId, setOpportunityId] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (opportunityId.trim() === '') {
      setResult('请填写 opportunityId');
      return;
    }
    setBusy(true);
    setResult('');
    try {
      const res = await fetch('/api/customs-opportunities/' + encodeURIComponent(opportunityId.trim()) + '/start-recovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as {
        recoveryStatus?: string;
        filingSubmitted?: boolean;
        externalExecutionStatus?: string;
        code?: string;
        disposition?: string;
        blockers?: string[];
      };
      if (res.ok) {
        setResult(
          'recoveryStatus=' +
            (body.recoveryStatus ?? '?') +
            ' · filingSubmitted=' +
            String(body.filingSubmitted ?? false) +
            ' · externalExecutionStatus=' +
            (body.externalExecutionStatus ?? '?'),
        );
      } else {
        const blockers = (body.blockers ?? []).join(', ');
        setResult(
          '未就绪：HTTP ' + res.status + ' · ' + (body.code ?? 'UNKNOWN') + (body.disposition ? ' · ' + body.disposition : '') + (blockers ? ' · ' + blockers : ''),
        );
      }
    } catch (error) {
      setResult('请求失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-slate-200 p-4">
      <h2 className="text-base font-medium">Customs 内部追回准备（不执行 filing）</h2>
      <p className="mt-1 text-xs text-slate-500">
        只做 server 端校验 / 授权就绪 / filing route 决策 / immutable snapshot；不会调用 provider、不会提交申报、不会扣款。
      </p>
      <label className="mt-3 block text-sm">
        <span className="text-slate-600">opportunityId</span>
        <input
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
          value={opportunityId}
          onChange={(e) => setOpportunityId(e.target.value)}
        />
      </label>
      <button
        className="mt-3 rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
        onClick={submit}
        disabled={busy}
      >
        {busy ? '请求中…' : '准备追回（READY_TO_FILE）'}
      </button>
      {result !== '' ? <p className="mt-2 text-sm text-slate-700">{result}</p> : null}
    </section>
  );
}
