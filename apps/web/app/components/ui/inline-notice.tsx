import type { ReactNode } from 'react';

export type NoticeTone = 'info' | 'warn' | 'danger';

const TONES: Record<NoticeTone, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  danger: 'border-red-200 bg-red-50 text-red-800',
};

/** 区块级提示（加载失败 / 边界说明 / 未启用通道）。 */
export default function InlineNotice({
  tone = 'info',
  title,
  children,
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={'rounded-lg border px-4 py-3 text-sm ' + TONES[tone]}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? 'mt-1' : ''}>{children}</div>
    </div>
  );
}
