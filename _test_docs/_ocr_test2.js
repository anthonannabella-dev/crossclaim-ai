
const fs = require('fs');
const { recognizeImage, extractWithAI } = require('/app/dist/services/ocrParser');

async function main() {
  // Packing list
  const text1 = await recognizeImage('/app/_test_docs/packing.jpg');
  const result1 = text1 && text1.trim() ? await extractWithAI(text1, 'packing_list') : {};
  fs.writeFileSync('/tmp/ocr_packing.json', JSON.stringify({text: (text1||'').slice(0,500), result: result1}, null, 2));
  console.log('packing DONE', (text1||'').length);
  
  // Bill of lading
  const text2 = await recognizeImage('/app/_test_docs/bl.jpg');
  const result2 = text2 && text2.trim() ? await extractWithAI(text2, 'bill_of_lading') : {};
  fs.writeFileSync('/tmp/ocr_bl.json', JSON.stringify({text: (text2||'').slice(0,500), result: result2}, null, 2));
  console.log('bl DONE', (text2||'').length);
}
main().catch(e => {
  fs.writeFileSync('/tmp/ocr_error2.txt', e.message + '\\n' + e.stack);
  console.log('ERROR', e.message);
});
