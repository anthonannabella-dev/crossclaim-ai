'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import type { Messages } from '../../i18n';

interface UploadResponse {
  status: string;
  fileAssetId: string;
  scan: { status: string; detectedMime: string; sha256: string; sizeBytes: number };
  import: { batchId: string; status: string; rowsOk: number; rowsFailed: number; duplicates: number } | null;
}

export default function UploadForm({ t }: { t: Messages }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/uploads', {
        method: 'POST',
        headers: {
          'content-type': file.type || 'text/csv',
          'x-file-name': file.name,
        },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as UploadResponse & { message?: string };
      if (!response.ok) {
        setError(body.message ?? t.uploadPage.rejected);
        return;
      }
      setResult(body);
    } catch {
      setError(t.uploadPage.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.uploadPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.uploadPage.description}</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block text-sm"
            aria-label={t.uploadPage.chooseFile}
          />
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            type="submit"
            disabled={busy || !file}
            className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
          >
            {busy ? t.uploadPage.submitting : t.uploadPage.submit}
          </button>
        </form>
      </section>

      {result ? (
        <section className="rounded-lg border bg-white p-6 text-sm">
          <h2 className="text-lg font-medium">{t.uploadPage.resultTitle}</h2>
          <p className="mt-2">
            {t.dashboard.colStatus}：
            {result.status === 'DUPLICATE' ? t.uploadPage.duplicate : t.uploadPage.imported} ·{' '}
            {result.scan.detectedMime} · {result.scan.sizeBytes}
          </p>
          {result.import ? (
            <p className="mt-1">
              {result.import.batchId.slice(0, 8)} · {t.dashboard.colRowsOk} {result.import.rowsOk} ·{' '}
              {t.dashboard.colRowsFailed} {result.import.rowsFailed}
            </p>
          ) : null}
          <Link href="/" className="mt-4 inline-block text-slate-600 underline">
            {t.common.backToDashboard}
          </Link>
        </section>
      ) : null}
    </div>
  );
}
