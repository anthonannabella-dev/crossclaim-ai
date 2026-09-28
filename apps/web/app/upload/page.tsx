import Link from 'next/link';

export default function UploadPage() {
  return (
    <div className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">上传账单</h1>
      <p className="mt-2 text-sm text-slate-600">
        上传入口已具备后端能力（字节级安全检查 + 导入流水线），浏览器上传表单将在 C-0008-A
        的下一步接线（需要会话通过后由 API 接收文件）。
      </p>
      <Link href="/" className="mt-4 inline-block text-sm text-slate-600 underline">
        返回工作台
      </Link>
    </div>
  );
}
