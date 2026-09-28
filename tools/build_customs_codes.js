#!/usr/bin/env node
/**
 * 从 中国海关单一窗口数据集(guoyunhe/singlewindow) 生成可直接用于项目的代码表。
 * 只生成「已核对与项目一致」的表（国别 / 贸易方式），并对「计量单位」做冲突体检（不自动替换）。
 *
 * 用法：
 *   # 先把 singlewindow 仓库 clone 到本地，或下载这几个 JSON 到 ./singlewindow/
 *   git clone https://github.com/guoyunhe/singlewindow.git
 *   node tools/build_customs_codes.js ./singlewindow
 *
 * 产物：tools/customsCodes.generated.json  —— { COUNTRY_CODES, TRADE_MODE_CODES }
 * 接入：在 customsCodes.ts 里 import 后并入现有 map（见 README）。
 * Node 18+，零依赖。
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || './singlewindow';
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

function build() {
  // —— 国别(已核对：中国142/美国502/日本116 与项目一致，安全) ——
  const country = read('CusCountry.json');
  const COUNTRY_CODES = {};
  for (const c of country) {
    const code = String(c.COUNTRY_CODE || '').trim();
    if (!code) continue;
    for (const k of [c.COUN_C_NAME, c.COUN_E_NAME, c.ISO_E]) {
      if (k && String(k).trim()) COUNTRY_CODES[String(k).trim()] = code;
    }
  }

  // —— 贸易方式(标准代码 0110 等，安全) ——
  const trade = read('CusTrade.json');
  const TRADE_MODE_CODES = {};
  for (const t of trade) {
    const code = String(t.TRADE_MODE || '').trim();
    if (!code) continue;
    for (const k of [t.FULL_TRADE, t.ABBR_TRADE]) {
      if (k && String(k).trim()) TRADE_MODE_CODES[String(k).trim()] = code;
    }
  }

  const out = { COUNTRY_CODES, TRADE_MODE_CODES };
  fs.writeFileSync(path.join(__dirname, 'customsCodes.generated.json'), JSON.stringify(out, null, 1));
  console.log(`✓ 生成 customsCodes.generated.json`);
  console.log(`  国别条目: ${Object.keys(COUNTRY_CODES).length}（含中英文+ISO别名）`);
  console.log(`  贸易方式条目: ${Object.keys(TRADE_MODE_CODES).length}`);
  console.log(`  抽查: 中国=${COUNTRY_CODES['中国']} 美国=${COUNTRY_CODES['美国']} 一般贸易=${TRADE_MODE_CODES['一般贸易']}`);

  // —— 计量单位：只做冲突体检，不自动替换（项目与官方表存在差异）——
  try {
    const unit = read('CusUnit.json');
    const name2code = {};
    for (const u of unit) name2code[u.UNIT_NAME] = u.UNIT_CODE;
    const projUnits = { '千克': '035', '台': '018', '个': '007', '件': '008', '套': '017', '米': '006', '吨': '036', '双': '109', '升': '030', '立方米': '016' };
    const conflicts = [];
    for (const [nm, pc] of Object.entries(projUnits)) {
      const sw = name2code[nm];
      if (sw && sw !== pc) conflicts.push(`${nm}: 项目=${pc} vs 官方=${sw}`);
    }
    console.log('\n⚠️ 计量单位代码体检（未自动替换，需你确认以哪份为准）：');
    if (conflicts.length) conflicts.forEach((c) => console.log('   冲突 ' + c));
    else console.log('   未发现冲突');
    console.log('   建议：以你们「单一窗口」客户端实际接受的计量单位代码为准，确认后再决定是否替换。');
  } catch { /* 无 CusUnit 时跳过 */ }
}

try { build(); }
catch (e) { console.error('✗ 生成失败：', e.message, '\n  请确认参数目录下有 CusCountry.json / CusTrade.json（git clone singlewindow 后传入其路径）'); process.exit(1); }
