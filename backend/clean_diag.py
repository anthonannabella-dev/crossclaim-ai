# -*- coding: utf-8 -*-
import re
f = 'D:/customs-saas/backend/src/services/groupPipelineService.ts'
s = open(f, encoding='utf-8').read()
pattern = re.compile(
    r"let aiItems: any\[\] = \[\];\s*try \{.*?\} catch \(e[^)]*\) \{[^}]*\}",
    re.DOTALL
)
clean = """let aiItems: any[] = [];
try {
    const { extractWithAI } = await import('./ocrParser');
    const aiDocs = await prisma.document.findMany({
      where: { tenantId: group.tenantId, billOfLading: group.billOfLading, ocrResult: { not: null } },
    });
    const combinedText = aiDocs.map((d: any) => d.ocrResult || '').join('\\n');
    if (combinedText.trim()) {
      const extracted = await extractWithAI(combinedText, 'declaration');
      if (extracted && Array.isArray((extracted as any).items)) {
        aiItems = (extracted as any).items.filter((it: any) => it && (it.hsCode || it.description));
      }
    }
  } catch (e) { /* AI 提取失败则回退占位逻辑,不影响主流程 */ }"""
m = pattern.search(s)
if not m:
    print('FAIL: 没匹配到 try 块,未改动文件,请把这条结果回报')
else:
    s = s[:m.start()] + clean + s[m.end():]
    open(f, 'w', encoding='utf-8').write(s)
    print('OK: 诊断块已整段替换为干净版')
