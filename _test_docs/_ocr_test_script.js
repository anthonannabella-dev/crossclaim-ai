
const fs = require('fs');
const { recognizeImage, extractWithAI } = require('/app/dist/services/ocrParser');

async function main() {
  const text = await recognizeImage('/app/_test_docs/invoice.jpg');
  fs.writeFileSync('/tmp/ocr_step1.txt', JSON.stringify({length: (text||'').length, content: (text||'').slice(0,1000)}));
  
  if (text && text.trim()) {
    const result = await extractWithAI(text, 'invoice');
    fs.writeFileSync('/tmp/ocr_step2.json', JSON.stringify(result, null, 2));
  }
}
main().catch(e => {
  fs.writeFileSync('/tmp/ocr_error.txt', e.message + '\n' + e.stack);
});
