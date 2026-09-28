const cards = [
  {
    title: '上传账单',
    body: '上传承运商账单 CSV；文件会经过字节级安全检查后进入导入流水线。',
    href: '/upload',
  },
  {
    title: '导入状态',
    body: '查看每个导入批次的处理结果、失败行与去重情况。',
    href: '/imports',
  },
  {
    title: '检测结果',
    body: '查看检测出的可追回机会（Opportunity）与金额明细。',
    href: '/opportunities',
  },
];

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold">工作台</h1>
        <p className="mt-2 text-slate-600">
          C-0008-A 阶段：邀请制登录、上传入口、导入状态与检测结果展示的骨架页面。
        </p>
      </section>
      <section className="grid gap-4 sm:grid-cols-3">
        {cards.map((card) => (
          <a
            key={card.title}
            href={card.href}
            className="rounded-lg border bg-white p-5 shadow-sm transition hover:border-slate-400"
          >
            <h2 className="font-medium">{card.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{card.body}</p>
            <span className="mt-3 inline-block text-sm text-slate-500">即将开放</span>
          </a>
        ))}
      </section>
    </div>
  );
}
