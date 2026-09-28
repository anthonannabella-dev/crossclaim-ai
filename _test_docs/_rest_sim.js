
const path = require('path');
const fs = require('fs');
const os = require('os');

async function test() {
  // 模拟 REST API 上传场景
  const tempPath = path.join(os.tmpdir(), 'ocr_test_' + Date.now() + '.jpg');
  fs.copyFileSync('/app/_test_docs/invoice.jpg', tempPath);
  
  // parseDocument 内部 = recognizeImage + extractWithAI
  const { parseDocument } = require('/app/dist/services/ocrParser');
  const result = await parseDocument(tempPath, 'invoice');
  console.log('parseDocument result:');
  console.log(JSON.stringify(result, null, 2));
  
  fs.unlinkSync(tempPath);
}
test().catch(e => {
  console.log('GRAND ERROR:', e.message);
  console.log(e.stack);
});
