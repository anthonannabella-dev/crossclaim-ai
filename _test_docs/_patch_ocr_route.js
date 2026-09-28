
const fs = require('fs');
const code = fs.readFileSync('/app/dist/routes/routes/ocr.js', 'utf-8');
console.log('FILE LENGTH:', code.length);
const mark = 'return res.json({\n                success: true,\n                data: result,';
const idx = code.indexOf(mark);
console.log('MARK AT:', idx);
if (idx >= 0) {
  const before = code.slice(0, idx);
  const after = code.slice(idx);
  const debug = 'console.log("[OCR ROUTE DEBUG] parseDocument result:", JSON.stringify(result).slice(0,500));\n                ';
  const patched = before + debug + after;
  fs.writeFileSync('/app/dist/routes/routes/ocr.js', patched, 'utf-8');
  console.log('PATCHED SUCCESS');
}
