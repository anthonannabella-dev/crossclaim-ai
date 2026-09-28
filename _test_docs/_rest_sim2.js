
const { parseDocument } = require('/app/dist/services/ocrParser');
const fs = require('fs');
const path = require('path');

async function test() {
  // 模拟 REST handler：写入临时文件再调
  const imgBuf = fs.readFileSync('/app/_test_docs/invoice.jpg');
  const tempPath = '/tmp/ocr_test_' + Date.now() + '.jpg';
  fs.writeFileSync(tempPath, imgBuf);
  
  console.log('TEMP FILE SIZE:', fs.statSync(tempPath).size);
  
  const start = Date.now();
  const result = await parseDocument(tempPath, 'invoice');
  const elapsed = Date.now() - start;
  
  console.log('ELAPSED:', elapsed, 'ms');
  console.log('RESULT KEYS:', Object.keys(result));
  console.log('RESULT:', JSON.stringify(result).slice(0, 500));
  
  fs.unlinkSync(tempPath);
}
test().catch(e => {
  console.log('ERROR:', e.message);
  console.log(e.stack.split('\\n').slice(0,3).join('\\n'));
});
