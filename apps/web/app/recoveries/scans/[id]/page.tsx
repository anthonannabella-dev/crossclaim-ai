import { cookies } from 'next/headers';

import { getServerMessages } from '../../../../i18n/server';
import HistoricalScanView, { type HistoricalScanSummaryView } from './historical-scan-view';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

/**
 * HISTORICAL_RECOVERY_SCAN_V1 / UI_RESULT_VIEW —— 历史扫描结果页（只读）。
 * 只消费服务端只读投影 `GET /recovery-scans/:id`；不触发扫描、不写库、不产生外部动作。
 */
export default async function HistoricalScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getServerMessages();
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();

  let summary: HistoricalScanSummaryView | null = null;
  try {
    const response = await fetch(`${API_BASE}/recovery-scans/${encodeURIComponent(id)}`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    if (response.ok) summary = (await response.json()) as HistoricalScanSummaryView;
  } catch {
    summary = null;
  }

  return <HistoricalScanView summary={summary} labels={t.historicalScan} />;
}
