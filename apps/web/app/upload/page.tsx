'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

interface UploadResponse {
  status: string;
  fileAssetId: string;
  scan: { status: string; detectedMime: string; sha256: string; sizeBytes: number };
  import: { batchId: string; status: string; rowsOk: number; rowsFailed: number; duplicates: number } | null;
}

export default function UploadPage() {
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
        setError(body.message ?? '上传被拒绝');
        return;
      }
      setResult(body);
    } catch {
      setError('网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">上传账单</h1>
        <p className="mt-2 text-sm text-slate-600">
          支持 CSV。文件会先做字节级安全检查（不信任浏览器声明的 MIME），通过后才进入导入流水线；
          相同内容的文件不会重复入库。
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block text-sm"
          />
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            type="submit"
            disabled={busy || !file}
            className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
          >
            {busy ? '上传中…' : '上传并导入'}
          </button>
        </form>
      </section>

      {result ? (
        <section className="rounded-lg border bg-white p-6 text-sm">
          <h2 className="text-lg font-medium">上传结果</h2>
          <p className="mt-2">
            状态：{result.status === 'DUPLICATE' ? '已存在（未重复导入）' : '已导入'} · 检测：
            {result.scan.detectedMime} · {result.scan.sizeBytes} 字节
          </p>
          {result.import ? (
            <p className="mt-1">
              批次 {result.import.batchId.slice(0, 8)}… · 成功 {result.import.rowsOk} 行 · 失败{' '}
              {result.import.rowsFailed} 行 · 去重 {result.import.duplicates} 行
            </p>
          ) : null}
          <Link href="/" className="mt-4 inline-block text-slate-600 underline">
            返回工作台
          </Link>
        </section>
      ) : null}
    </div>
  );
}
