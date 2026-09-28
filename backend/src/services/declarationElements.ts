// ============================================================
// 申报要素查询服务
// ------------------------------------------------------------
// 数据来源:中国单一窗口公开参数(CusMerchElement)，已处理为
//   { "CODE_TS": ["要素1","要素2",...] }，按 HS 前缀分级存放(4~8位)。
// 通用要素(CAS/GTIN)已统一挪到每条末尾;实质申报要素在前。
//
// ⚠️ 要素「官方申报顺序」与「是否必填」以单一窗口为准:本表来自公开参数，
//    顺序已尽量贴近但不保证逐项与口岸客户端一致;系统不臆造要素内容。
// 数据文件默认随镜像打包在 data/declElements.generated.json;
// 可用 CUSTOMS_DECL_ELEMENTS_PATH 指向自有/更新版本覆盖。
// ============================================================

let ELEMENTS: Record<string, string[]> = {};
let loadedCount = 0;

function tryLoad(p: string): boolean {
  try {
    const fs = require('fs');
    if (!fs.existsSync(p)) return false;
    const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (json && typeof json === 'object') {
      ELEMENTS = json;
      loadedCount = Object.keys(json).length;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

(function init() {
  const path = require('path');
  const explicit = process.env.CUSTOMS_DECL_ELEMENTS_PATH;
  const candidates = [
    explicit,
    path.resolve(__dirname, '../../data/declElements.generated.json'),
    path.resolve(process.cwd(), 'data/declElements.generated.json'),
  ].filter(Boolean) as string[];
  for (const c of candidates) { if (tryLoad(c)) break; }
})();

export function declElementsLoaded(): number {
  return loadedCount;
}

// 按 HS 编码查申报要素:取数据集中「是输入前缀的最长 CODE_TS」对应的要素清单。
// 例:输入 8471300000 → 命中 84713;输入 6109100000 → 命中 6109。
export function lookupDeclarationElements(hsCode?: string): { matchedCode: string; elements: string[]; broadened?: boolean } | null {
  const d = (hsCode || '').replace(/\D/g, '');
  if (!d) return null;
  // ① 正常:输入比数据编码深 → 取「是输入前缀的最长 CODE_TS」
  let best: string | null = null;
  for (const code of Object.keys(ELEMENTS)) {
    if (d.startsWith(code)) {
      if (!best || code.length > best.length) best = code;
    }
  }
  if (best) return { matchedCode: best, elements: ELEMENTS[best] };

  // ② 兜底:输入比数据编码浅(如只填4位,要素在子目) → 取最浅的子目,标注 broadened
  let shortestChild: string | null = null;
  for (const code of Object.keys(ELEMENTS)) {
    if (code.startsWith(d)) {
      if (!shortestChild || code.length < shortestChild.length) shortestChild = code;
    }
  }
  if (shortestChild) return { matchedCode: shortestChild, elements: ELEMENTS[shortestChild], broadened: true };

  return null;
}